# Insurance Service Desk

Independent proof-of-work demo, not affiliated with InsuranceDekho. Case queue, evidence review and audit trail for an insurance broker
operations team, with three module workflows (claim query reconciler, proposal disclosure checker, renewal terms change agent) plugged into a
shared platform. All data is fictional. See `docs/SPEC.md` (requirements) and `docs/ARCHITECTURE.md` (contracts).

## Run it (no credentials needed)
```bash
npm ci --no-fund --no-audit
npm run dev            # http://localhost:3000 - embedded PGlite in .data/, auto-migrates and seeds
```
Sign in as one of three fictional users: handler (own cases only), supervisor (all cases, can approve and export), analyst (read-only).

```bash
npm test               # Vitest: platform tests, in-memory database
npx tsc --noEmit       # types
npm run build && npm start
npm run test:e2e       # Playwright (first: npx playwright install chromium)
```

## Configuration
Copy `.env.example` to `.env.local`. Everything is optional locally. In production set `SESSION_SECRET` (16+ chars) and `DATABASE_URL`
(Neon; run `npm run db:migrate`; set `DEMO_SEED=1` for the fictional demo data). `MODEL_PROVIDER=anthropic|bedrock` enables a live model only
when its credentials are present; every result is badged `Synthetic` or `Live (<model>)`.

## Public demo mode
Set `DEMO_PUBLIC=true` on any internet-facing deployment. It forces the synthetic model (a configured live provider is refused and a one-line
notice is logged, never a secret), blocks `POST /api/retention` with `run=true` for everyone (403), shows a "Fictional data only, public demo"
banner on every page including sign-in, and caps uploads at 5 files per case and 2 MB each. Independently of that flag, PDFs over 200 pages
are rejected and sign-in and uploads are limited to 30 requests per minute per IP and action (429 beyond).

**The rate limit is in memory, per server instance and best effort**: serverless instances each keep their own counters and they reset on
restart. For a real guarantee put Vercel Firewall rate limiting in front of the app (for example on `/signin`, `/api/cases/*/documents` and
the case upload action). In production the session cookie is `__Host-isd_session` and the server refuses to start without `SESSION_SECRET`.
`OCR_ADAPTER=synthetic|none` picks the OCR adapter (default `synthetic` only in synthetic mode).

## Database
Schema in `src/db/schema.ts`. Generate migrations with `npm run db:generate` (committed in `/drizzle`); apply with `npm run db:migrate`.

## Known limits
Full list in `docs/KNOWN_LIMITATIONS.md`.
Local-disk storage is the default; the `ObjectStorage` interface is ready for an S3-style adapter (not implemented). The Anthropic and Bedrock
adapters have not been exercised against the live services. The demo sign-in is for fictional users only and is not a production login.
