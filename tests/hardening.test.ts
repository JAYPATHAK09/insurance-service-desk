import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documents } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { HttpError } from '@/lib/access';
import { DEMO_BANNER_TEXT, DEMO_MAX_UPLOAD_BYTES, MAX_PDF_PAGES, isDemoPublic, maxUploadBytes, sessionCookieName } from '@/lib/env';
import { IngestError, ingestDocument } from '@/lib/ingest';
import { ERRORS, NOTICES, messageFor } from '@/lib/messages';
import { SyntheticProvider } from '@/lib/model';
import { getProvider } from '@/lib/model/providers';
import { NoOcrAdapter, SyntheticOcrAdapter, getOcrAdapter, resetOcrIndex } from '@/lib/ocr';
import { makeTextPdf } from '@/lib/pdf-fixture';
import { RATE_LIMIT_PER_MINUTE, clientIp, rateLimit, resetRateLimits } from '@/lib/ratelimit';
import { assertJsonSameOrigin } from '@/lib/http';
import { runRetentionJob, setRetentionDays } from '@/lib/retention';
import { MemoryStorage } from '@/lib/storage';
import { register } from '@/instrumentation';
import { bytes, freshDb, makeCase, U } from './helpers';

afterEach(() => {
  vi.unstubAllEnvs();
  resetRateLimits();
  resetOcrIndex();
  vi.restoreAllMocks();
});

const deps = () => ({ storage: new MemoryStorage(), ocr: new SyntheticOcrAdapter(async () => null) });

describe('rate limit (H1)', () => {
  it('allows 30 per minute per action+IP, then refuses (429 at the call sites)', () => {
    const t = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) expect(rateLimit('signin', '1.2.3.4', t + i)).toBe(true);
    expect(rateLimit('signin', '1.2.3.4', t + 100)).toBe(false);
    expect(rateLimit('signin', '1.2.3.4', t + 200)).toBe(false);
  });

  it('keeps separate counters per action and per IP, and resets after the window', () => {
    const t = 5_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE + 5; i++) rateLimit('upload', '9.9.9.9', t);
    expect(rateLimit('upload', '9.9.9.9', t + 1)).toBe(false);
    expect(rateLimit('signin', '9.9.9.9', t + 1)).toBe(true); // other action
    expect(rateLimit('upload', '8.8.8.8', t + 1)).toBe(true); // other IP
    expect(rateLimit('upload', '9.9.9.9', t + 60_001)).toBe(true); // new window
  });

  it('reads the first forwarded address, falling back to x-real-ip then a shared bucket', () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientIp(h({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(h({}))).toBe('unknown');
  });

  it('the 429 status is a valid HttpError', () => {
    expect(new HttpError(429, 'Too many requests').status).toBe(429);
  });
});

describe('PDF page cap (M1)', () => {
  it('accepts exactly the cap and rejects one page above it, before any OCR runs', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const page = 'Page text long enough to avoid OCR';
    const ocr = new SyntheticOcrAdapter(async () => null);
    const recognise = vi.spyOn(ocr, 'recognise');
    const atCap = await ingestDocument(db, { caseId: c.id, filename: 'cap.pdf', bytes: makeTextPdf(Array(MAX_PDF_PAGES).fill(page)) }, { storage: new MemoryStorage(), ocr });
    expect(atCap.document.pages).toHaveLength(MAX_PDF_PAGES);

    // Scan pages (no text layer) would each trigger OCR: none must run for an oversized file.
    const err = await ingestDocument(db, { caseId: c.id, filename: 'big.pdf', bytes: makeTextPdf(Array(MAX_PDF_PAGES + 1).fill('')) }, { storage: new MemoryStorage(), ocr }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err).toMatchObject({ status: 400, code: 'too_many_pages' });
    expect(recognise).not.toHaveBeenCalled();
    expect(await db.select().from(documents).where(eq(documents.caseId, c.id))).toHaveLength(1);
  }, 60_000);
});

describe('OCR sidecar index (M1) and adapter selection (L4)', () => {
  it('walks the fixtures directory once, however many pages are recognised', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'isd-ocr-'));
    try {
      await fs.mkdir(path.join(root, 'sub'));
      await fs.writeFile(path.join(root, 'sub', 'scan.pdf.ocr.txt'), 'page one\fpage two\fpage three');
      vi.stubEnv('FIXTURES_DIR', root);
      const readdir = vi.spyOn(fs, 'readdir');
      const adapter = new SyntheticOcrAdapter();
      const outs = [];
      for (const page of [1, 2, 3, 4]) outs.push(await adapter.recognise({ filename: 'scan.pdf', page, bytes: new Uint8Array() }));
      expect(outs.map((o) => o.ok)).toEqual([true, true, true, false]);
      expect(outs[1]!.text).toBe('page two');
      const walks = readdir.mock.calls.length;
      expect(walks).toBe(2); // root + sub, once
      await adapter.recognise({ filename: 'missing.pdf', page: 1, bytes: new Uint8Array() });
      expect(readdir.mock.calls.length).toBe(walks);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('defaults to synthetic only in synthetic mode; OCR_ADAPTER overrides; unknown means none', () => {
    expect(getOcrAdapter()).toBeInstanceOf(SyntheticOcrAdapter);
    vi.stubEnv('MODEL_PROVIDER', 'anthropic');
    expect(getOcrAdapter()).toBeInstanceOf(NoOcrAdapter);
    vi.stubEnv('OCR_ADAPTER', 'synthetic');
    expect(getOcrAdapter()).toBeInstanceOf(SyntheticOcrAdapter);
    vi.stubEnv('OCR_ADAPTER', 'none');
    expect(getOcrAdapter()).toBeInstanceOf(NoOcrAdapter);
    vi.stubEnv('OCR_ADAPTER', 'textract');
    expect(getOcrAdapter()).toBeInstanceOf(NoOcrAdapter);
  });

  it('the none adapter marks scanned pages unreadable', async () => {
    expect(await new NoOcrAdapter().recognise()).toEqual({ ok: false, text: '' });
  });
});

describe('DEMO_PUBLIC (H1)', () => {
  it('is off by default and on only for the exact value "true"', () => {
    expect(isDemoPublic()).toBe(false);
    vi.stubEnv('DEMO_PUBLIC', '1');
    expect(isDemoPublic()).toBe(false);
    vi.stubEnv('DEMO_PUBLIC', 'true');
    expect(isDemoPublic()).toBe(true);
  });

  it('forces the synthetic model even when a live provider is selected and configured', () => {
    vi.stubEnv('DEMO_PUBLIC', 'true');
    vi.stubEnv('MODEL_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-real');
    expect(getProvider()).toBeInstanceOf(SyntheticProvider);
    vi.stubEnv('MODEL_PROVIDER', 'bedrock');
    expect(getProvider()).toBeInstanceOf(SyntheticProvider);
  });

  it('without DEMO_PUBLIC a live provider is still selected when configured', () => {
    vi.stubEnv('MODEL_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-not-real');
    expect(getProvider().mode).toBe('live');
  });

  it('caps uploads at 2 MB each', async () => {
    vi.stubEnv('DEMO_PUBLIC', 'true');
    vi.stubEnv('MAX_UPLOAD_BYTES', String(50 * 1024 * 1024)); // cannot be raised past the demo cap
    expect(maxUploadBytes()).toBe(DEMO_MAX_UPLOAD_BYTES);
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const ok = new Uint8Array(DEMO_MAX_UPLOAD_BYTES).fill(65);
    await expect(ingestDocument(db, { caseId: c.id, filename: 'ok.txt', bytes: ok }, deps())).resolves.toMatchObject({ duplicate: false });
    const over = new Uint8Array(DEMO_MAX_UPLOAD_BYTES + 1).fill(66);
    await expect(ingestDocument(db, { caseId: c.id, filename: 'over.txt', bytes: over }, deps())).rejects.toMatchObject({ status: 413, code: 'file_too_large' });
  });

  it('caps a case at 5 files; an identical re-upload is still a harmless duplicate', async () => {
    vi.stubEnv('DEMO_PUBLIC', 'true');
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    const other = await makeCase(U.handlerA.id);
    for (let i = 1; i <= 5; i++) await ingestDocument(db, { caseId: c.id, filename: `f${i}.txt`, bytes: bytes(`file ${i}`) }, deps());
    await expect(ingestDocument(db, { caseId: c.id, filename: 'f6.txt', bytes: bytes('file 6') }, deps())).rejects.toMatchObject({ code: 'too_many_files' });
    await expect(ingestDocument(db, { caseId: c.id, filename: 'f1.txt', bytes: bytes('file 1') }, deps())).resolves.toMatchObject({ duplicate: true });
    await expect(ingestDocument(db, { caseId: other.id, filename: 'f6.txt', bytes: bytes('file 6') }, deps())).resolves.toMatchObject({ duplicate: false });
    expect(await db.select().from(documents).where(eq(documents.caseId, c.id))).toHaveLength(5);
  });

  it('does not cap files per case when the flag is off', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    for (let i = 1; i <= 7; i++) await ingestDocument(db, { caseId: c.id, filename: `f${i}.txt`, bytes: bytes(`file ${i}`) }, deps());
    expect(await db.select().from(documents).where(eq(documents.caseId, c.id))).toHaveLength(7);
  });

  it('the banner wording is fixed (the component renders it on every page, sign-in included, while the flag is on)', () => {
    // The component itself is JSX, which the node test runner does not compile; the e2e smoke covers rendering.
    expect(DEMO_BANNER_TEXT).toBe('Fictional data only, public demo');
  });
});

describe('retention job idempotency key (L1)', () => {
  it('a changed period or policy update the same day runs again instead of replaying', async () => {
    const db = await freshDb();
    const now = new Date('2026-06-01T10:00:00Z');
    const a = await runRetentionJob(db, now, U.supervisor.id);
    const same = await runRetentionJob(db, now, U.supervisor.id);
    expect(a.state).toBe('ran');
    expect(same.state).toBe('replayed');

    await setRetentionDays(db, 'documents', 30, U.supervisor.id);
    const afterChange = await runRetentionJob(db, now, U.supervisor.id);
    expect(afterChange.state).toBe('ran');
    expect(afterChange).toMatchObject({ result: { days: 30 } });
    expect((await runRetentionJob(db, now, U.supervisor.id)).state).toBe('replayed');

    // Same number of days, but the policy row was rewritten later: still a fresh run.
    await new Promise((r) => setTimeout(r, 5));
    await setRetentionDays(db, 'documents', 30, U.supervisor.id);
    expect((await runRetentionJob(db, now, U.supervisor.id)).state).toBe('ran');
  });
});

describe('JSON and same-origin guard (L2)', () => {
  const req = (headers: Record<string, string>) => new Request('https://desk.example/api/retention', { method: 'POST', headers, body: '{}' });
  it('accepts JSON with no Origin or the same Origin', () => {
    expect(() => assertJsonSameOrigin(req({ 'content-type': 'application/json' }))).not.toThrow();
    expect(() => assertJsonSameOrigin(req({ 'content-type': 'application/json; charset=utf-8', origin: 'https://desk.example' }))).not.toThrow();
  });
  it('rejects other content types with 415, including form posts', () => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect(() => assertJsonSameOrigin(req({ 'content-type': ct }))).toThrowError(expect.objectContaining({ status: 415 }));
    }
    expect(() => assertJsonSameOrigin(req({}))).toThrowError(expect.objectContaining({ status: 415 }));
  });
  it('rejects a foreign or null Origin with 403', () => {
    for (const origin of ['https://evil.example', 'null', 'https://desk.example.evil.example']) {
      expect(() => assertJsonSameOrigin(req({ 'content-type': 'application/json', origin }))).toThrowError(expect.objectContaining({ status: 403 }));
    }
  });
});

describe('session cookie name and startup check (L3)', () => {
  it('uses the __Host- prefix in production and a plain name in development', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(sessionCookieName()).toBe('__Host-isd_session');
    vi.stubEnv('NODE_ENV', 'development');
    expect(sessionCookieName()).toBe('isd_session');
  });

  it('refuses to start in production without a strong SESSION_SECRET, but not during build or in dev', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', '');
    await expect(register()).rejects.toThrow(/SESSION_SECRET/);
    vi.stubEnv('SESSION_SECRET', 'too-short');
    await expect(register()).rejects.toThrow(/SESSION_SECRET/);
    vi.stubEnv('SESSION_SECRET', 'a-long-enough-secret-value-0123456789');
    await expect(register()).resolves.toBeUndefined();
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    await expect(register()).resolves.toBeUndefined();
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    await expect(register()).resolves.toBeUndefined();
  });
});

describe('message codes (L5)', () => {
  it('maps known codes to fixed text and ignores everything else, including prototype names', () => {
    expect(messageFor(NOTICES, 'uploaded')).toBe('Document uploaded.');
    expect(messageFor(ERRORS, 'too_many_files')).toMatch(/maximum/);
    for (const bad of ['<script>alert(1)</script>', 'constructor', '__proto__', 'toString', '', undefined, 'Free text from a crafted link']) {
      expect(messageFor(ERRORS, bad)).toBeUndefined();
      expect(messageFor(NOTICES, bad)).toBeUndefined();
    }
  });
  it('every IngestError code used by the ingest path has a fixed message', () => {
    for (const code of ['choose_file', 'file_type', 'file_empty', 'file_too_large', 'not_pdf', 'too_many_pages', 'too_many_files', 'ingest_failed']) {
      expect(messageFor(ERRORS, code), code).toBeTruthy();
    }
  });
});

describe('CSP header (L7)', () => {
  it('is set, same-origin only, with no external hosts', async () => {
    // @ts-expect-error the Next config is plain ESM without type declarations
    const cfg = (await import('../next.config.mjs')).default as { headers(): Promise<Array<{ headers: Array<{ key: string; value: string }> }>> };
    const all = (await cfg.headers()).flatMap((h) => h.headers);
    const csp = all.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/https?:\/\//);
  });
});
