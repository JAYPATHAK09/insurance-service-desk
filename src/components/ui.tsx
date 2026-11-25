import { modeLabel, type Mode, type WorkflowState } from '@/lib/contracts';

/** Every model-derived result carries this badge. Never hide or restyle it away. */
export function ModeBadge({ mode, model }: { mode: Mode; model: string }) {
  const live = mode === 'live';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        live ? 'border-accent text-accent' : 'border-line text-muted'
      }`}
      title={live ? `Produced by a live model: ${model}` : 'Produced by deterministic synthetic mode (no live model)'}
      data-testid="mode-badge"
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-accent' : 'bg-muted'}`} />
      {modeLabel(mode, model)}
    </span>
  );
}

export const STATE_LABEL: Record<WorkflowState, string> = {
  intake: 'Intake',
  extraction: 'Extraction',
  evidence_review: 'Evidence review',
  exception_resolution: 'Exception resolution',
  approval: 'Approval',
  exported: 'Exported',
};

export function StatusPill({ status }: { status: WorkflowState }) {
  return <span className="pill">{STATE_LABEL[status]}</span>;
}

export function AttentionTag({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return <span className="text-muted">-</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {reasons.map((r) => (
        <span
          key={r}
          className="inline-flex items-center rounded-full border border-danger/40 bg-danger/10 px-2.5 py-0.5 text-xs font-medium text-danger"
        >
          {r}
        </span>
      ))}
    </span>
  );
}

export const MODULE_LABEL: Record<string, string> = {
  'claim-reconciler': 'Claim query',
  'disclosure-checker': 'Disclosure',
  'renewal-agent': 'Renewal',
};

export const fmtDate = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
export const fmtDateTime = (d: Date | string) =>
  new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
