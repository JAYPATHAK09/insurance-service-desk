import fs from 'node:fs/promises';
import path from 'node:path';

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

async function findSidecar(root: string, filename: string, depth = 0): Promise<string | null> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name === `${filename}.ocr.txt`) return full;
    if (e.isDirectory() && depth < 4 && !e.name.startsWith('.')) {
      const hit = await findSidecar(full, filename, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
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

export function getOcrAdapter(): OcrAdapter {
  return new SyntheticOcrAdapter();
}
