import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HttpError } from '@/lib/access';
import { refreshAttention } from '@/lib/cases';
import { api } from '@/lib/http';
import { IngestError, ingestDocument, listDocuments } from '@/lib/ingest';
import { requireCase } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const GET = api(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { db } = await requireCase(id, 'read');
  const docs = await listDocuments(db, id);
  // Metadata only: no page text over this endpoint.
  return NextResponse.json(
    docs.map((d) => ({ id: d.id, filename: d.filename, kind: d.kind, sha256: d.sha256, pages: d.pages.length, ocrFailedPages: d.pages.filter((p) => p.ocr_status === 'failed').length })),
  );
});

/** multipart/form-data: file, kind?. Re-uploading identical bytes returns 200 with duplicate=true. */
export const POST = api(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { user, db } = await requireCase(id, 'write');
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, 'Expected multipart form data');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new IngestError('Missing file');
  const kind = z.string().max(40).catch('other').parse(form.get('kind') ?? 'other');
  const { document, duplicate } = await ingestDocument(db, {
    caseId: id,
    filename: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
    kind,
    uploadedBy: user.id,
  });
  await refreshAttention(db, id);
  return NextResponse.json({ id: document.id, sha256: document.sha256, duplicate }, { status: duplicate ? 200 : 201 });
});
