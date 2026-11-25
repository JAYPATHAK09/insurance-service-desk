/**
 * Shared contracts. Module agents import from here and must not redefine these.
 * Pure types and constants only: no I/O, safe to import anywhere.
 */

export const ROLES = ['handler', 'supervisor', 'analyst'] as const;
export type Role = (typeof ROLES)[number];

export const MODULE_IDS = ['claim-reconciler', 'disclosure-checker', 'renewal-agent'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export const WORKFLOW_STATES = [
  'intake',
  'extraction',
  'evidence_review',
  'exception_resolution',
  'approval',
  'exported',
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const MODES = ['synthetic', 'live'] as const;
export type Mode = (typeof MODES)[number];

export const OCR_STATUSES = ['not_needed', 'ok', 'failed'] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];

export const FINDING_STATUSES = ['open', 'accepted', 'overridden', 'dismissed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Classification enums. `ambiguous` is the universal downgrade target. */
export const CLASSIFICATIONS = {
  'claim-reconciler': [
    'satisfied_pending_verification',
    'partially_satisfied',
    'missing',
    'ambiguous',
    'repeated_request',
  ],
  'disclosure-checker': ['omission', 'contradiction', 'unanswered', 'explicit_negative', 'ambiguous'],
  'renewal-agent': [
    'confirmed_change',
    'unchanged',
    'rephrasing_only',
    'absent_page',
    'ocr_failure',
    'mismatched_pair',
    'ambiguous',
  ],
} as const satisfies Record<ModuleId, readonly string[]>;

/** Classifications whose meaning is "nothing was found", so zero evidence is legitimate. */
export const ABSENCE_CLASSIFICATIONS: readonly string[] = [
  'missing',
  'unanswered',
  'omission',
  'absent_page',
  'ocr_failure',
  'mismatched_pair',
];

export interface PageText {
  page: number; // 1-based
  text: string;
  ocr_status: OcrStatus;
}

export interface DocumentRecord {
  id: string;
  caseId: string;
  sha256: string;
  filename: string;
  mime: string;
  kind: string;
  pages: PageText[];
  storageKey: string;
}

export interface Evidence {
  doc_id: string;
  page: number;
  quote: string;
  verified: boolean;
}

/** A finding as produced by an engine, before persistence. */
export interface Finding {
  /** Stable identity within a review (e.g. requested-item id). Retries must produce the same key. */
  key: string;
  type: string;
  classification: string;
  summary: string;
  evidence: Evidence[];
  suggestedOwner?: string;
  nextAction?: string;
  /** Module-specific structured fields (old/new value, family member, ...). No document dumps. */
  attributes?: Record<string, unknown>;
}

export interface ModelRequest {
  /** Task id; SyntheticProvider dispatches on this (see registerSyntheticHandler). */
  task: string;
  promptVersion: string;
  instructions: string;
  documents: Array<{ id: string; name: string; pages: Array<{ page: number; text: string }> }>;
}

export interface ModelResult {
  mode: Mode;
  model: string;
  promptVersion: string;
  /** Raw model output: object or JSON string. Always pass through validateModelOutput. */
  output: unknown;
}

export interface ModelProvider {
  readonly mode: Mode;
  readonly model: string;
  complete(req: ModelRequest): Promise<ModelResult>;
}

export interface ModuleEngine {
  id: ModuleId;
  label: string;
  /** Bump when prompts/rules change: it is stored on every review. */
  promptVersion: string;
  classifications: readonly string[];
  /** Case-relative route for the module workspace, e.g. `/cases/{id}/claim-reconciler`. */
  route: string;
  run(caseId: string, docs: DocumentRecord[], provider: ModelProvider): Promise<Finding[]>;
}

export function modeLabel(mode: Mode, model: string): string {
  return mode === 'synthetic' ? 'Synthetic' : `Live (${model})`;
}
