import { z } from 'zod';
import type { Finding } from '../contracts';

export class ModelOutputError extends Error {
  constructor(public issues: string[]) {
    super(`Invalid model output: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'ModelOutputError';
  }
}

const EvidenceSchema = z.object({
  doc_id: z.string().min(1).max(100),
  page: z.number().int().min(1).max(10_000),
  quote: z.string().min(1).max(2000),
});

const FindingSchema = z.object({
  key: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  classification: z.string().min(1).max(60),
  summary: z.string().min(1).max(2000),
  evidence: z.array(EvidenceSchema).max(20).default([]),
  suggested_owner: z.string().max(200).optional(),
  next_action: z.string().max(1000).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const OutputSchema = z.object({ findings: z.array(FindingSchema).max(500) });

function toObject(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    throw new ModelOutputError(['output is not valid JSON']);
  }
}

/**
 * Parse and validate raw model output. Throws ModelOutputError listing paths and codes only
 * (never echoing values, which may contain document text). Evidence comes back unverified.
 */
export function validateModelOutput(raw: unknown, allowedClassifications: readonly string[]): Finding[] {
  const parsed = OutputSchema.safeParse(toObject(raw));
  if (!parsed.success) {
    throw new ModelOutputError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`));
  }
  const bad = parsed.data.findings.filter((f) => !allowedClassifications.includes(f.classification));
  if (bad.length) {
    throw new ModelOutputError(bad.map((f) => `findings[${f.key}].classification: not in allowed set`));
  }
  const seen = new Set<string>();
  return parsed.data.findings.map((f) => {
    if (seen.has(f.key)) throw new ModelOutputError([`duplicate finding key`]);
    seen.add(f.key);
    return {
      key: f.key,
      type: f.type,
      classification: f.classification,
      summary: f.summary,
      evidence: f.evidence.map((e) => ({ ...e, verified: false })),
      suggestedOwner: f.suggested_owner,
      nextAction: f.next_action,
      attributes: f.attributes,
    };
  });
}
