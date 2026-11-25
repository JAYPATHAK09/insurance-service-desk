import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog, cases, findings, reviews } from '@/db/schema';
import { WORKFLOW_STATES } from '@/lib/contracts';
import { TRANSITIONS, WorkflowError, checkReopen, checkTransition, reopenCase, transitionCase } from '@/lib/workflow';
import { freshDb, makeCase, U } from './helpers';

describe('state machine (pure)', () => {
  it('allows only the defined forward path', () => {
    const ctx = { role: 'handler' as const, openFindings: 0 };
    expect(checkTransition('intake', 'extraction', ctx)).toBeNull();
    expect(checkTransition('intake', 'approval', ctx)).toMatch(/Cannot move/);
    expect(checkTransition('exported', 'intake', ctx)).toMatch(/Cannot move/);
    expect(TRANSITIONS.exported).toEqual([]);
    expect(Object.keys(TRANSITIONS)).toEqual([...WORKFLOW_STATES]);
  });
  it('blocks approval and export while findings are unresolved', () => {
    expect(checkTransition('exception_resolution', 'approval', { role: 'handler', openFindings: 2 })).toMatch(/unresolved/);
    expect(checkTransition('approval', 'exported', { role: 'handler', openFindings: 1 })).toMatch(/unresolved/);
    expect(checkTransition('approval', 'exported', { role: 'supervisor', openFindings: 0 })).toBeNull();
  });
  it('analysts cannot transition or reopen', () => {
    expect(checkTransition('intake', 'extraction', { role: 'analyst', openFindings: 0 })).toMatch(/read-only/);
    expect(checkReopen('exported', 'a good reason', 'analyst')).toMatch(/read-only/);
  });
  it('reopen needs a reason and a reopenable state', () => {
    expect(checkReopen('exported', '  ', 'handler')).toMatch(/reason/);
    expect(checkReopen('intake', 'a good reason', 'handler')).toMatch(/Cannot reopen/);
    expect(checkReopen('exported', 'insurer sent new query', 'handler')).toBeNull();
  });
});

describe('state machine (persisted)', () => {
  it('moves forward, audits each step, and refuses invalid jumps', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id);
    await transitionCase(db, { caseId: c.id, to: 'extraction', actorId: U.handlerA.id, role: 'handler' });
    await expect(transitionCase(db, { caseId: c.id, to: 'exported', actorId: U.handlerA.id, role: 'handler' })).rejects.toBeInstanceOf(WorkflowError);
    const [row] = await db.select().from(cases).where(eq(cases.id, c.id));
    expect(row!.status).toBe('extraction');
    const log = await db.select().from(auditLog).where(eq(auditLog.caseId, c.id));
    expect(log.map((l) => l.action)).toEqual(['case.transition']);
    expect(log[0]!.meta).toMatchObject({ from: 'intake', to: 'extraction' });
  });

  it('open findings block approval until resolved', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id, { status: 'exception_resolution' });
    const [r] = await db.insert(reviews).values({ caseId: c.id, module: c.module, version: 1, documentHashes: [], inputHash: 'x', mode: 'synthetic', modelId: 'synthetic-v1', promptVersion: 'p' }).returning();
    const [f] = await db.insert(findings).values({ caseId: c.id, reviewId: r!.id, module: c.module, key: 'k', type: 't', classification: 'missing', summary: 's', evidence: [] }).returning();
    await expect(transitionCase(db, { caseId: c.id, to: 'approval', actorId: U.handlerA.id, role: 'handler' })).rejects.toThrow(/unresolved/);
    await db.update(findings).set({ status: 'accepted' }).where(eq(findings.id, f!.id));
    await transitionCase(db, { caseId: c.id, to: 'approval', actorId: U.handlerA.id, role: 'handler' });
  });

  it('reopen moves back to evidence_review, counts, and is audited with the reason', async () => {
    const db = await freshDb();
    const c = await makeCase(U.handlerA.id, { status: 'exported' });
    await expect(reopenCase(db, { caseId: c.id, reason: '', actorId: U.handlerA.id, role: 'handler' })).rejects.toBeInstanceOf(WorkflowError);
    await reopenCase(db, { caseId: c.id, reason: 'Insurer sent a new query', actorId: U.handlerA.id, role: 'handler' });
    const [row] = await db.select().from(cases).where(eq(cases.id, c.id));
    expect(row).toMatchObject({ status: 'evidence_review', reopenCount: 1 });
    const log = await db.select().from(auditLog).where(eq(auditLog.action, 'case.reopened'));
    expect(log[0]!.meta).toMatchObject({ from: 'exported', to: 'evidence_review', reasonText: 'Insurer sent a new query' });
  });
});
