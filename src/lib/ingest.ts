import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { documents } from '@/db/schema';
import type { DocumentRecord, PageText } from './contracts';
import { audit } from './audit';
import { maxUploadBytes } from './env';
import { getOcrAdapter, type OcrAdapter } from './ocr';
import { getStorage, type ObjectStorage } from './storage';

export const DOCUMENT_KINDS = [
  'query_letter',
  'document_register',
  'correspondence',
  'receipt',
  'submission',
  'proposal',
  'disclosure',
  'policy_schedule',
  'endorsement',
  'renewal_proposal',
  'other',
] as const;

const ALLOWED_EXT: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv' };
const MIN_TEXT_PER_PAGE = 15; // below this a PDF page is treated as a scan and sent to OCR

export class IngestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const clean = (s: string) => s.replace(/\u0000/g, '').replace(/\r\n?/g, '\n');

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'file';
}

async function extractPdf(bytes: Uint8Array, filename: string, ocr: OcrAdapter): Promise<PageText[]> {
  let pageTexts: string[];
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const res = await extractText(pdf, { mergePages: false });
    pageTexts = res.text as string[];
  } catch {
    // Unparseable file: one failed page so the case is flagged for attention instead of silently empty.
    const r = await ocr.recognise({ filename, page: 1, bytes });
    return [{ page: 1, text: clean(r.text), ocr_status: r.ok ? 'ok' : 'failed' }];
  }
  const out: PageText[] = [];
  for (let i = 0; i < pageTexts.length; i++) {
    const text = clean(pageTexts[i] ?? '').trim();
    if (text.length >= MIN_TEXT_PER_PAGE) {
      out.push({ page: i + 1, text, ocr_status: 'not_needed' });
      continue;
    }
    const r = await ocr.recognise({ filename, page: i + 1, bytes });
    out.push({ page: i + 1, text: r.ok ? clean(r.text) : '', ocr_status: r.ok ? 'ok' : 'failed' });
  }
  return out.length ? out : [{ page: 1, text: '', ocr_status: 'failed' }];
}

export async function extractPages(
  bytes: Uint8Array,
  filename: string,
  ext: string,
  ocr: OcrAdapter,
): Promise<PageText[]> {
  if (ext === 'pdf') return extractPdf(bytes, filename, ocr);
  const text = clean(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
  // Text and CSV files may carry explicit page breaks (form feed); otherwise one page.
  const parts = ext === 'txt' ? text.split('\f') : [text];
  return parts.map((t, i) => ({ page: i + 1, text: t.trim(), ocr_status: 'not_needed' as const }));
}

export interface IngestInput {
  caseId: string;
  filename: string;
  bytes: Uint8Array;
  kind?: string;
  uploadedBy?: string | null;
}
export interface IngestDeps {
  ocr?: OcrAdapter;
  storage?: ObjectStorage;
}

/**
 * Store and extract a document. Idempotent per (case, sha256): a repeated upload returns the existing
 * row with duplicate=true and creates nothing (the DB unique constraint is the final guard).
 */
export async function ingestDocument(
  db: Db,
  input: IngestInput,
  deps: IngestDeps = {},
): Promise<{ document: DocumentRecord; duplicate: boolean }> {
  const filename = safeFilename(input.filename);
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const mime = ALLOWED_EXT[ext];
  if (!mime) throw new IngestError('Only PDF, TXT and CSV files are accepted');
  if (input.bytes.byteLength === 0) throw new IngestError('Empty file');
  if (input.bytes.byteLength > maxUploadBytes()) throw new IngestError('File too large', 413);
  if (ext === 'pdf' && Buffer.from(input.bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new IngestError('File content is not a PDF');
  }
  const kind = input.kind && (DOCUMENT_KINDS as readonly string[]).includes(input.kind) ? input.kind : 'other';

  const sha = sha256Hex(input.bytes);
  const existing = await findByHash(db, input.caseId, sha);
  if (existing) return { document: existing, duplicate: true };

  const pages = await extractPages(input.bytes, filename, ext, deps.ocr ?? getOcrAdapter());
  const storageKey = `cases/${input.caseId}/${sha}.${ext}`;
  await (deps.storage ?? getStorage()).put(storageKey, input.bytes);

  const [row] = await db
    .insert(documents)
    .values({
      caseId: input.caseId,
      sha256: sha,
      filename,
      mime,
      kind,
      size: input.bytes.byteLength,
      pages,
      storageKey,
      uploadedBy: input.uploadedBy ?? null,
    })
    .onConflictDoNothing({ target: [documents.caseId, documents.sha256] })
    .returning();
  if (!row) {
    // Lost a race with a concurrent identical upload.
    const again = await findByHash(db, input.caseId, sha);
    if (again) return { document: again, duplicate: true };
    throw new IngestError('Could not store document', 500);
  }
  await audit(db, {
    actorId: input.uploadedBy,
    action: 'document.uploaded',
    caseId: input.caseId,
    entity: 'document',
    entityId: row.id,
    meta: {
      sha256: sha,
      pageCount: pages.length,
      ocrFailedPages: pages.filter((p) => p.ocr_status === 'failed').length,
      kind,
      filename,
    },
  });
  return { document: toRecord(row), duplicate: false };
}

type DocRow = typeof documents.$inferSelect;
export const toRecord = (r: DocRow): DocumentRecord => ({
  id: r.id,
  caseId: r.caseId,
  sha256: r.sha256,
  filename: r.filename,
  mime: r.mime,
  kind: r.kind,
  pages: r.pages,
  storageKey: r.storageKey,
});

async function findByHash(db: Db, caseId: string, sha: string): Promise<DocumentRecord | null> {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.caseId, caseId), eq(documents.sha256, sha)))
    .limit(1);
  return row ? toRecord(row) : null;
}

export async function listDocuments(db: Db, caseId: string): Promise<DocumentRecord[]> {
  const rows = await db.select().from(documents).where(eq(documents.caseId, caseId)).orderBy(documents.createdAt);
  return rows.map(toRecord);
}
