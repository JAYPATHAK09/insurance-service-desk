import { count, eq } from 'drizzle-orm';
import { audit } from '@/lib/audit';
import { refreshAttention } from '@/lib/cases';
import type { ModuleId, WorkflowState } from '@/lib/contracts';
import { ingestDocument } from '@/lib/ingest';
import { getProvider } from '@/lib/model/providers';
import { makeTextPdf } from '@/lib/pdf-fixture';
import { runReview } from '@/lib/review';
import { seedClaimFixtures } from '@/modules/claim-reconciler/fixtures';
import { seedDisclosureFixtures } from '@/modules/disclosure-checker/fixtures';
import { seedRenewalFixtures } from '@/modules/renewal-agent/fixtures';
import type { Db } from './client';
import { cases, retentionPolicy, users } from './schema';

/** Fictional people and insurers only. */
export const SEED_USERS = {
  handler: { id: 'user-handler-asha', email: 'asha.rao@demo.example', name: 'Asha Rao (Handler)', role: 'handler' as const },
  supervisor: { id: 'user-supervisor-vikram', email: 'vikram.menon@demo.example', name: 'Vikram Menon (Supervisor)', role: 'supervisor' as const },
  analyst: { id: 'user-analyst-neha', email: 'neha.kapoor@demo.example', name: 'Neha Kapoor (Analyst)', role: 'analyst' as const },
};

const day = (n: number) => new Date(Date.now() + n * 86_400_000);
const enc = (s: string) => new TextEncoder().encode(s);

interface SeedCase {
  module: ModuleId;
  insurer: string;
  reference: string;
  title: string;
  owner: keyof typeof SEED_USERS;
  status: WorkflowState;
  due: number;
  priority?: 'low' | 'normal' | 'high';
}

const SEED_CASES: SeedCase[] = [
  { module: 'claim-reconciler', insurer: 'Northstar General', reference: 'CLM-1001', title: 'Hospitalisation claim: insurer query on discharge papers', owner: 'handler', status: 'evidence_review', due: 2, priority: 'high' },
  { module: 'claim-reconciler', insurer: 'Bluebird Health', reference: 'CLM-1002', title: 'Day-care claim: query response ready for sign-off', owner: 'handler', status: 'approval', due: 5 },
  { module: 'claim-reconciler', insurer: 'Northstar General', reference: 'CLM-1003', title: 'Cashless claim: repeated query on itemised bill', owner: 'supervisor', status: 'exception_resolution', due: -3, priority: 'high' },
  { module: 'disclosure-checker', insurer: 'Bluebird Health', reference: 'DSC-2001', title: 'Family floater proposal: scanned disclosure form', owner: 'handler', status: 'extraction', due: 4 },
  { module: 'disclosure-checker', insurer: 'Meridian Life', reference: 'DSC-2002', title: 'Individual proposal: awaiting documents', owner: 'supervisor', status: 'intake', due: 7, priority: 'low' },
  { module: 'renewal-agent', insurer: 'Meridian Life', reference: 'REN-3001', title: 'Health policy renewal: terms comparison', owner: 'handler', status: 'evidence_review', due: 10 },
  { module: 'renewal-agent', insurer: 'Northstar General', reference: 'REN-3002', title: 'Renewal completed and exported', owner: 'handler', status: 'exported', due: -10, priority: 'low' },
];

const QUERY_LETTER = `Northstar General - Claim Query Letter
Claim reference: CLM-1001
Dear Broker, to proceed with the claim please provide:
1. Original discharge summary, duly signed by the treating doctor.
2. Itemised hospital bill (a consolidated bill is not acceptable).
Reply within 7 days.`;

const REGISTER = `Document register - CLM-1001
Discharge summary: copy, unsigned, received 02-Mar
Hospital bill: consolidated, received 02-Mar
Submission receipt: SUB-77120 (receipt only, no content check)`;

export async function seedIfEmpty(db: Db): Promise<boolean> {
  const [{ n }] = (await db.select({ n: count() }).from(users)) as [{ n: number }];
  if (n > 0) return false;

  await db.insert(users).values(Object.values(SEED_USERS)).onConflictDoNothing();
  await db
    .insert(retentionPolicy)
    .values([
      { scope: 'documents', days: Number(process.env.RETENTION_DAYS) > 0 ? Number(process.env.RETENTION_DAYS) : 365 },
      { scope: 'audit', days: 730 },
    ])
    .onConflictDoNothing();

  const ids = new Map<string, string>();
  for (const c of SEED_CASES) {
    const [row] = await db
      .insert(cases)
      .values({
        module: c.module,
        insurer: c.insurer,
        reference: c.reference,
        title: c.title,
        ownerId: SEED_USERS[c.owner].id,
        status: c.status,
        dueDate: day(c.due),
        priority: c.priority ?? 'normal',
      })
      .onConflictDoNothing()
      .returning({ id: cases.id });
    if (row) ids.set(c.reference, row.id);
  }

  const uploader = SEED_USERS.supervisor.id;
  const clm1001 = ids.get('CLM-1001')!;
  await ingestDocument(db, { caseId: clm1001, filename: 'query-letter.txt', bytes: enc(QUERY_LETTER), kind: 'query_letter', uploadedBy: uploader });
  await ingestDocument(db, { caseId: clm1001, filename: 'document-register.txt', bytes: enc(REGISTER), kind: 'document_register', uploadedBy: uploader });
  // A scanned form with no text layer and no OCR sidecar: ocr_status=failed -> needs attention.
  await ingestDocument(db, { caseId: ids.get('DSC-2001')!, filename: 'scanned-disclosure.pdf', bytes: makeTextPdf(['']), kind: 'disclosure', uploadedBy: uploader });

  for (const [ref, id] of ids) {
    await audit(db, { actorId: uploader, action: 'case.seeded', caseId: id, entity: 'case', entityId: id, meta: { reference: ref } });
    await refreshAttention(db, id);
  }

  await seedModuleFixtures(db);
  return true;
}

/**
 * Load every module's fixture cases and run the synthetic review on each so the queue and findings
 * are populated. Synthetic mode only (a live provider must never be called from the seed path).
 * Idempotent: the loaders key cases by module+insurer+reference and reviews dedupe by input hash.
 */
export async function seedModuleFixtures(db: Db): Promise<number> {
  if (getProvider().mode !== 'synthetic') return 0;
  const ownerId = SEED_USERS.handler.id;
  const caseIds = new Set<string>();
  for (const r of await seedClaimFixtures(db, { ownerId })) caseIds.add(r.caseId);
  for (const r of await seedDisclosureFixtures(db, { ownerId })) caseIds.add(r.caseId);
  for (const r of await seedRenewalFixtures(db, { ownerId })) caseIds.add(r.caseId);
  // The seeded CLM-1001 has real documents, so it gets a real synthetic review in place of the old placeholder.
  const [clm1001] = await db.select({ id: cases.id }).from(cases).where(eq(cases.reference, 'CLM-1001'));
  if (clm1001) caseIds.add(clm1001.id);
  for (const caseId of caseIds) {
    try {
      await runReview(db, { caseId, actorId: SEED_USERS.supervisor.id });
    } catch (e) {
      console.warn('seed review skipped:', caseId, e instanceof Error ? e.message : e);
    }
  }
  return caseIds.size;
}
