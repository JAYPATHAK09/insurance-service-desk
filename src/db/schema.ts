import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import type { Evidence, PageText } from '@/lib/contracts';

const id = () =>
  text('id')
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  role: text('role', { enum: ['handler', 'supervisor', 'analyst'] }).notNull(),
  createdAt: createdAt(),
});

export const cases = pgTable(
  'cases',
  {
    id: id(),
    module: text('module', { enum: ['claim-reconciler', 'disclosure-checker', 'renewal-agent'] }).notNull(),
    insurer: text('insurer').notNull(),
    /** External reference (claim no., proposal no., policy no.). With module+insurer it is the dedupe key. */
    reference: text('reference').notNull(),
    title: text('title').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    status: text('status', {
      enum: ['intake', 'extraction', 'evidence_review', 'exception_resolution', 'approval', 'exported'],
    })
      .notNull()
      .default('intake'),
    dueDate: timestamp('due_date', { withTimezone: true }).notNull(),
    priority: text('priority', { enum: ['low', 'normal', 'high'] })
      .notNull()
      .default('normal'),
    attentionReason: text('attention_reason'),
    reopenCount: integer('reopen_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('cases_module_insurer_reference_uq').on(t.module, t.insurer, t.reference), index('cases_owner_idx').on(t.ownerId)],
);

export const documents = pgTable(
  'documents',
  {
    id: id(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    sha256: text('sha256').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    kind: text('kind').notNull().default('other'),
    size: integer('size').notNull(),
    pages: jsonb('pages').$type<PageText[]>().notNull(),
    storageKey: text('storage_key').notNull(),
    uploadedBy: text('uploaded_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique('documents_case_sha_uq').on(t.caseId, t.sha256)],
);

export const jobs = pgTable('jobs', {
  id: id(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  type: text('type').notNull(),
  caseId: text('case_id').references(() => cases.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull().default(1),
  /** Small structured result (ids, counts). Never document text. */
  result: jsonb('result').$type<Record<string, unknown>>(),
  error: text('error'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    module: text('module').notNull(),
    version: integer('version').notNull(),
    documentHashes: jsonb('document_hashes').$type<string[]>().notNull(),
    /** sha256(sorted hashes | mode | model | prompt version): same inputs never create a second review. */
    inputHash: text('input_hash').notNull(),
    mode: text('mode', { enum: ['synthetic', 'live'] }).notNull(),
    modelId: text('model_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('reviews_case_version_uq').on(t.caseId, t.version),
    unique('reviews_case_input_uq').on(t.caseId, t.inputHash),
  ],
);

export interface ReviewerDecision {
  by: string;
  decision: 'accept' | 'override' | 'dismiss';
  note: string;
  at: string;
}
export interface Correction {
  by: string;
  at: string;
  field: string;
  from: unknown;
  to: unknown;
  reason: string;
}

export const findings = pgTable(
  'findings',
  {
    id: id(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    module: text('module').notNull(),
    key: text('key').notNull(),
    type: text('type').notNull(),
    status: text('status', { enum: ['open', 'accepted', 'overridden', 'dismissed'] })
      .notNull()
      .default('open'),
    classification: text('classification').notNull(),
    summary: text('summary').notNull(),
    evidence: jsonb('evidence').$type<Evidence[]>().notNull(),
    suggestedOwner: text('suggested_owner'),
    nextAction: text('next_action'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>(),
    decision: jsonb('decision').$type<ReviewerDecision>(),
    corrections: jsonb('corrections').$type<Correction[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [unique('findings_review_key_uq').on(t.reviewId, t.key), index('findings_case_idx').on(t.caseId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    caseId: text('case_id'),
    entity: text('entity'),
    entityId: text('entity_id'),
    /** Sanitised metadata only (ids, counts, states). Never document contents. */
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index('audit_case_idx').on(t.caseId)],
);

export const acknowledgements = pgTable(
  'acknowledgements',
  {
    id: id(),
    caseId: text('case_id')
      .notNull()
      .references(() => cases.id, { onDelete: 'cascade' }),
    findingId: text('finding_id')
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    acknowledgedBy: text('acknowledged_by').notNull(), // customer name / channel as recorded by the advisor
    recordedBy: text('recorded_by')
      .notNull()
      .references(() => users.id),
    language: text('language', { enum: ['en', 'hi'] }).notNull().default('en'),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [unique('ack_finding_uq').on(t.findingId)],
);

export const retentionPolicy = pgTable('retention_policy', {
  scope: text('scope', { enum: ['documents', 'audit'] }).primaryKey(),
  days: integer('days').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const kpiEvents = pgTable(
  'kpi_events',
  {
    id: id(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    caseId: text('case_id'),
    module: text('module'),
    kind: text('kind').notNull(),
    value: numeric('value').notNull().default('1'),
    source: text('source', { enum: ['fixture', 'pilot', 'scenario'] }).notNull(),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    dedupeKey: text('dedupe_key').unique(),
  },
  (t) => [index('kpi_kind_idx').on(t.kind, t.at)],
);
