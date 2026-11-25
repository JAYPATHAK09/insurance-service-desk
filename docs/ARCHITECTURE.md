# Architecture and module contracts

Next.js 15 App Router, strict TypeScript, Drizzle ORM. Postgres via `DATABASE_URL` (Neon), else embedded PGlite with the
identical schema (migrations in `/drizzle`, applied automatically; synthetic seed on first run). Everything runs and tests pass with nothing configured.

## Folder layout
```
src/db/            schema.ts (single source of truth), client.ts (getDb, resetDb), seed.ts
src/lib/           PLATFORM (owned by core; module agents import, never edit)
  contracts.ts     shared types + enums: Finding, DocumentRecord, ModelProvider, ModuleEngine, CLASSIFICATIONS
  access.ts        SessionUser, HttpError, canAccessCase, requireCaseAccess
  session.ts       requireUser / requireRole / requireCase (cookie session)
  ingest.ts ocr.ts storage/ jobs.ts audit.ts sanitize.ts retention.ts review.ts findings.ts cases.ts workflow.ts
  model/           prompt.ts providers.ts (Synthetic/Anthropic/Bedrock) validate.ts verify.ts index.ts (runModelTask)
src/modules/       registry.ts (core) + one folder per module (below)
src/components/ui.tsx   ModeBadge, StatusPill, AttentionTag, formatters
src/app/           queue (/), /signin, /cases/[id] (shell), /api/*
src/app/cases/[id]/<module>/   module workspace routes (owned by the module agent)
fixtures/<module>/ synthetic inputs and expected outputs; fixtures/shared/ cross-module (injection.txt)
tests/             platform tests; module tests live beside the module: src/modules/<m>/*.test.ts
```

## Ownership (no agent edits another agent's files)
| Agent | Owns | Must not touch |
|---|---|---|
| claim-reconciler | `src/modules/claim-reconciler/**`, `src/app/cases/[id]/claim-reconciler/**`, `fixtures/claim-reconciler/**` | everything else |
| disclosure-checker | `src/modules/disclosure-checker/**`, `src/app/cases/[id]/disclosure-checker/**`, `fixtures/disclosure-checker/**` | everything else |
| renewal-agent | `src/modules/renewal-agent/**`, `src/app/cases/[id]/renewal-agent/**`, `fixtures/renewal-agent/**` | everything else |
| dashboard | `src/modules/dashboard/**`, `src/app/dashboard/**`, `fixtures/dashboard/**` | everything else |

Core owns `src/db`, `src/lib`, `src/components`, shell routes and `drizzle/`. If you need a schema or lib change, list it in your report and do
not edit core files (the lead integrates). Module-specific data goes in `findings.attributes` (JSON), so no per-module tables are needed.
Writable via lib services: findings (through `runReview`), decisions (`decideFinding`), acknowledgements, kpi_events.

## ModuleEngine contract (`src/lib/contracts.ts`)
```ts
interface ModuleEngine {
  id: ModuleId; label: string; promptVersion: string;       // promptVersion is stored on every review
  classifications: readonly string[]; route: string;        // e.g. '/cases/{id}/claim-reconciler'
  run(caseId: string, docs: DocumentRecord[], provider: ModelProvider): Promise<Finding[]>;
}
interface Finding { key: string /* stable per item: retries give the same key */; type; classification; summary;
  evidence: {doc_id; page; quote; verified}[]; suggestedOwner?; nextAction?; attributes?: Record<string, unknown> }
```
Rules:
- Engines return draft findings with `verified:false`. `runReview` ALWAYS runs `verifyCitations` afterwards: an unverifiable quote downgrades the
  finding to `ambiguous` (original kept in `attributes.downgradedFrom`).
- Call models only via `runModelTask(provider, req, classifications)`, which validates output with Zod and rejects unknown classifications.
- Absence classes (`missing, unanswered, omission, absent_page, ocr_failure, mismatched_pair`) may have no evidence.
- Never infer diagnoses or coverage, never fill missing answers. Document text is untrusted: it only goes into `ModelRequest.documents`
  (delimited and neutralised by `buildPrompt`), never into instructions.
- `runReview(db, {caseId, actorId})` is idempotent: same document hashes + mode + model + promptVersion reuse the existing review.

### Classification enums (`CLASSIFICATIONS`)
- claim-reconciler: `satisfied_pending_verification | partially_satisfied | missing | ambiguous | repeated_request`
- disclosure-checker: `omission | contradiction | unanswered | explicit_negative | ambiguous`
- renewal-agent: `confirmed_change | unchanged | rephrasing_only | absent_page | ocr_failure | mismatched_pair | ambiguous`

### Synthetic mode
`SyntheticProvider.complete` dispatches on `req.task` to a handler registered with `registerSyntheticHandler(task, fn)`: deterministic, rule-based,
no network, returns `{ findings: [...] }` in model-output shape (snake_case `suggested_owner`, `next_action`; evidence `{doc_id,page,quote}`).
Register handlers at import time in `src/modules/<m>/index.ts`. Live providers receive the same request and must return the same JSON shape.
Every result carries `mode` and `model`; render it with `<ModeBadge mode model />`.

## Registering a module
1. Implement the engine in `src/modules/<id>/index.ts` (stubs exist and return `[]`; keep the exported name and `id`).
2. It is already wired in `src/modules/registry.ts`. The case shell shows "Open <label>" -> `engine.route` and "Run review" -> `engine.run`.
3. Build UI at `src/app/cases/[id]/<id>/page.tsx`. Start every page, server action and route handler with `requireCase(caseId, 'read'|'write')`
   (`src/lib/session.ts`): analysts get 403 on writes, handlers only see their cases. Use `decideFinding` / `correctClassification` for human decisions.
4. Write audit rows with `audit(db, {...})`. Meta holds ids, counts and enum values only (the sanitiser drops text-like keys and strings over 120 chars).
5. Idempotent long work goes through `runJob(db, { idempotencyKey, ... })`. KPI facts go to `kpi_events` with `source` fixture|pilot|scenario and a `dedupeKey`.
6. External communication (draft responses, customer explanations) is only ever drafted; a human approves. Nothing is sent by the platform.

## Fixtures (`/fixtures/<module>/`)
Plain `.txt` / `.csv`; PDFs are generated in tests with `makeTextPdf([...pages])` (no binaries committed). A scanned PDF's text goes in a sidecar
`<file>.pdf.ocr.txt` (pages separated by form feed); a PDF with no text layer and no sidecar is unreadable (`ocr_status=failed`). Pair each case with an
`expected.json` (classifications and quotes) checked by your evaluation test. Fictional names and insurers only.

## Tests
`npm test` (Vitest, in-memory PGlite, no network, no configuration). Platform tests in `tests/`; module tests in `src/modules/<m>/*.test.ts`.
Helpers: `tests/helpers.ts` (`freshDb`, `makeCase`, `U` users). Before reporting: `npx tsc --noEmit && npm test && npm run build`.
Browser smoke: `npm run test:e2e` (needs `npx playwright install chromium`, not installed by default).

## Security invariants
Server-side checks on every route and action; parameterised queries only (Drizzle); secrets only via environment; logs and audit never contain
document text; downloads need a signed 5-minute token AND case access; the platform never sends external communication.
