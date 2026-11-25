# Known limitations

Plain list of what this demo does not do, or does only on a best-effort basis. Items marked "gap" were found in review and deliberately left open.

## Open review findings (gaps)

- **M4 (gap, not fixed).** Deliberately skipped in the hardening pass. TODO: copy the finding text from the review into this entry (it was not part of the change brief).
- **L6 (gap, not fixed).** Deliberately skipped in the hardening pass. TODO: copy the finding text from the review into this entry.

## Public demo mode (`DEMO_PUBLIC=true`)

- The rate limit is in memory and per server instance. On a serverless host each instance has its own counters and they reset on restart, so it slows abuse but does not cap it. Put Vercel Firewall (or another edge rate limit) in front of any public deployment.
- The per-IP key comes from `x-forwarded-for` / `x-real-ip`. Behind a proxy that does not set them all callers share one bucket.
- The 5-files-per-case cap is checked before the insert and is not a database constraint, so a burst of simultaneous uploads can briefly exceed it.
- The demo sign-in lets anyone pick any fictional user. It is not authentication.

## Security hardening still open

- The Content-Security-Policy allows inline scripts and styles (`'unsafe-inline'`) because Next injects inline bootstrap scripts and no nonce is wired. It blocks external hosts, plugins and framing, but it is not a strict CSP.
- The `__Host-` session cookie and the startup `SESSION_SECRET` check only apply when `NODE_ENV=production`. `next start` on a laptop without a secret now refuses to boot.
- Same-origin checks on `/api/retention` compare `Origin` with the request URL; behind a proxy that rewrites the host the check may need the public origin configured.
- A case a user may not see answers 404, but an analyst attempting a write on a case it can read still gets 403 (no information is revealed by that).
- Several module server actions now redirect with short codes, so the page shows a general message ("That action is not allowed on this renewal right now.") rather than the specific domain reason. Specific reasons are not logged.

## Citation checks

- A quote must be at least 20 normalised characters (or the whole page, if shorter) for a positive finding to stand. Short supporting lines are accepted next to a long one, and absence findings may cite short context. This is looser than "every quote at least 20 characters" because the rule engines cite whole lines such as `Co-payment: 0%`. The renewal engine widens short rule quotes with the neighbouring lines; claim and disclosure engines rely on a long line being cited alongside.
- `satisfied_pending_verification` needs a quote containing the item wording, a submission or query reference, or a reference-shaped token. The reference pattern is a heuristic and can accept an unrelated reference-like string.
- The verifier proves a quote exists on the cited page. It does not prove the quote means what the finding says.

## Parser conventions (synthetic and rule engines)

- **Disclosure checker:** rows must be `Q<n> | question | answer | date`, members introduced by `MEMBER: <name> (<relation>)`. Rows outside a member block are rejected, not guessed. Similar names are never merged, so a genuine spelling variant is reported as a different person. Free-text answers are classified only as blank, explicit no, yes or ambiguous.
- **Claim reconciler:** query letters need numbered items; document type is detected from keywords and the optional register CSV. Unusual wording of a request can fall to `ambiguous`. Signed, original and itemised qualifiers come from fixed keywords.
- **Renewal agent:** `Label: value` lines, `Page x of y` footers and page-break markers. Hindi explanations are template-based, not translated by a model. Tables rendered as images or layouts that break lines mid-value are not parsed.
- Only PDF, TXT and CSV are accepted. PDFs over 200 pages are rejected. Scanned pages need OCR; with `OCR_ADAPTER=none` (the default whenever a live model is selected) they are reported unreadable rather than guessed.

## Live mode

- The Anthropic and Bedrock providers have not been run against the live services (no credentials were used). Request signing, response parsing and error paths are unit-tested only.
- Live model output is guarded (schema validation, citation verification, rule cross-checks) but those guards were exercised with fake providers, not real model behaviour.
- Fixture evaluation figures are for the synthetic engines only. They say nothing about live accuracy.
- No real OCR service is wired in; `OCR_ADAPTER=synthetic` only reads fixture sidecar files.

## Platform

- Local-disk storage is the default; the S3-style adapter is an interface only. On Vercel, files are in memory and do not persist.
- The OCR sidecar index is built once per process. Adding sidecar files while the server runs needs a restart.
- Retention runs delete stored documents; they are disabled when `DEMO_PUBLIC=true`.
