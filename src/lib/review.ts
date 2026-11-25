import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { cases, findings, reviews } from '@/db/schema';
import { getModule } from '@/modules/registry';
import { audit } from './audit';
import { refreshAttention } from './cases';
import type { ModelProvider } from './contracts';
import { listDocuments } from './ingest';
import { runJob } from './jobs';
import { getProvider } from './model/providers';
import { verifyCitations } from './model/verify';

export class ReviewError extends Error {}

export const computeInputHash = (hashes: string[], mode: string, model: string, promptVersion: string) =>
  createHash('sha256')
    .update([...hashes].sort().join(',') + `|${mode}|${model}|${promptVersion}`)
    .digest('hex');

/**
 * Run the case's module engine against its current documents and persist a versioned review.
 * Idempotent: the same documents + model + prompt version return the existing review and create no
 * new findings. Citations are always verified here, whatever the engine did.
 */
export async function runReview(db: Db, args: { caseId: string; actorId: string; provider?: ModelProvider }) {
  const [c] = await db.select().from(cases).where(eq(cases.id, args.caseId));
  if (!c) throw new ReviewError('Case not found');
  const engine = getModule(c.module);
  const provider = args.provider ?? getProvider();
  const docs = await listDocuments(db, c.id);
  if (!docs.length) throw new ReviewError('Upload at least one document before running a review');

  const hashes = docs.map((d) => d.sha256);
  const inputHash = computeInputHash(hashes, provider.mode, provider.model, engine.promptVersion);

  const outcome = await runJob(db, {
    idempotencyKey: `review:${c.id}:${inputHash}`,
    type: 'review',
    caseId: c.id,
    run: async () => {
      const raw = await engine.run(c.id, docs, provider);
      const verified = verifyCitations(raw, docs);
      return db.transaction(async (tx) => {
        const [{ v }] = (await tx
          .select({ v: sql<number>`coalesce(max(${reviews.version}), 0)::int` })
          .from(reviews)
          .where(eq(reviews.caseId, c.id))) as [{ v: number }];
        const [review] = await tx
          .insert(reviews)
          .values({
            caseId: c.id,
            module: c.module,
            version: v + 1,
            documentHashes: hashes,
            inputHash,
            mode: provider.mode,
            modelId: provider.model,
            promptVersion: engine.promptVersion,
            createdBy: args.actorId,
          })
          .onConflictDoNothing({ target: [reviews.caseId, reviews.inputHash] })
          .returning();
        const existing =
          review ??
          (await tx.select().from(reviews).where(and(eq(reviews.caseId, c.id), eq(reviews.inputHash, inputHash))))[0]!;
        if (review && verified.length) {
          await tx
            .insert(findings)
            .values(
              verified.map((f) => ({
                caseId: c.id,
                reviewId: review.id,
                module: c.module,
                key: f.key,
                type: f.type,
                classification: f.classification,
                summary: f.summary,
                evidence: f.evidence,
                suggestedOwner: f.suggestedOwner,
                nextAction: f.nextAction,
                attributes: f.attributes,
              })),
            )
            .onConflictDoNothing({ target: [findings.reviewId, findings.key] });
        }
        await audit(tx as unknown as Db, {
          actorId: args.actorId,
          action: 'review.created',
          caseId: c.id,
          entity: 'review',
          entityId: existing.id,
          meta: { version: existing.version, mode: provider.mode, model: provider.model, findings: verified.length },
        });
        return { reviewId: existing.id, version: existing.version, findings: verified.length };
      });
    },
  });
  await refreshAttention(db, c.id);
  return outcome;
}
