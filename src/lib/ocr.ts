import fs from 'node:fs/promises';
import path from 'node:path';
import { isDemoPublic } from './env';

export interface OcrInput {
  filename: string;
  /** 1-based page number being recognised. */
  page: number;
  bytes: Uint8Array;
}
export interface OcrOutput {
  ok: boolean;
  text: string;
}

/** Plug a real OCR service in behind this interface (configured and authorised only). */
export interface OcrAdapter {
  readonly name: string;
  recognise(input: OcrInput): Promise<OcrOutput>;
}

const SIDECAR_SUFFIX = '.ocr.txt';
type SidecarIndex = Map<string, string>;

async function walkSidecars(root: string, into: SidecarIndex, depth = 0): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name.endsWith(SIDECAR_SUFFIX)) {
      const key = e.name.slice(0, -SIDECAR_SUFFIX.length);
      if (!into.has(key)) into.set(key, full); // first hit wins, as the old per-page walk did
    } else if (e.isDirectory() && depth < 4 && !e.name.startsWith('.')) {
      await walkSidecars(full, into, depth + 1);
    }
  }
}

// One directory walk per root per process (the promise is cached, so concurrent callers share it).
const indexes = new Map<string, Promise<SidecarIndex>>();

function sidecarIndex(root: string): Promise<SidecarIndex> {
  let idx = indexes.get(root);
  if (!idx) {
    idx = (async () => {
      const m: SidecarIndex = new Map();
      await walkSidecars(root, m);
      return m;
    })();
    indexes.set(root, idx);
  }
  return idx;
}

/** For tests, or after sidecars are added while the process is running. */
export function resetOcrIndex(): void {
  indexes.clear();
}

async function findSidecar(root: string, filename: string): Promise<string | null> {
  return (await sidecarIndex(root)).get(filename) ?? null;
}

/**
 * Deterministic OCR for synthetic mode. For `scan.pdf` it reads a fixture sidecar `scan.pdf.ocr.txt`
 * (pages separated by form feed, \f). No sidecar, or no text for that page: ok=false, i.e. the file
 * is "unreadable" and the page is marked ocr_status=failed.
 */
export class SyntheticOcrAdapter implements OcrAdapter {
  readonly name = 'synthetic-ocr';
  constructor(
    private lookup: (filename: string) => Promise<string | null> = async (f) => {
      const hit = await findSidecar(process.env.FIXTURES_DIR ?? path.join(process.cwd(), 'fixtures'), path.basename(f));
      return hit ? fs.readFile(hit, 'utf8') : null;
    },
  ) {}

  async recognise({ filename, page }: OcrInput): Promise<OcrOutput> {
    const sidecar = await this.lookup(filename);
    if (sidecar == null) return { ok: false, text: '' };
    const text = (sidecar.split('\f')[page - 1] ?? '').trim();
    return text ? { ok: true, text } : { ok: false, text: '' };
  }
}

/** Reads nothing and recognises nothing: every scanned page is reported unreadable (ocr_status=failed). */
export class NoOcrAdapter implements OcrAdapter {
  readonly name = 'none';
  async recognise(): Promise<OcrOutput> {
    return { ok: false, text: '' };
  }
}

/**
 * OCR_ADAPTER = synthetic | none. Unset defaults to `synthetic` only while the model provider is
 * synthetic (the offline demo); with a live model provider it defaults to `none`, so fixture text is
 * never presented as the OCR of real uploads. Unknown values are treated as `none`.
 */
export function getOcrAdapter(): OcrAdapter {
  const explicit = process.env.OCR_ADAPTER?.trim().toLowerCase();
  const syntheticMode = isDemoPublic() || (process.env.MODEL_PROVIDER ?? 'synthetic').toLowerCase() === 'synthetic';
  const choice = explicit || (syntheticMode ? 'synthetic' : 'none');
  return choice === 'synthetic' ? new SyntheticOcrAdapter() : new NoOcrAdapter();
}
