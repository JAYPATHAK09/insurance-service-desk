# Insurance Service Desk: authoritative spec

Independent InsuranceDekho Founder's Office proof-of-work application. Primary user: an Indian insurance broker's operations team. Three complete workflows with a common case record. Implement the software, run its tests, deploy where authorized. A design document alone is insufficient.

Stack: Next.js + TypeScript, PostgreSQL on Neon (PGlite fallback when no DATABASE_URL), private object storage, Vercel. Server-side model adapter supporting Claude on Amazon Bedrock or the Anthropic API. Deterministic synthetic-data mode that runs without credentials. Clearly identify which mode produced each result. Independent demo branding (not InsuranceDekho's logo or name as product; palette and feel only).

## 1. Claim Query Reconciler
Accept insurer query letters, document registers, prior correspondence and submission receipts. Support PDF, text and CSV, including scanned PDFs through an OCR adapter. Extract each requested item and its qualifiers: original vs copy, signed vs unsigned, date, itemised vs consolidated bill. Match against the case's documents, versions and receipts. Classify as: satisfied pending handler verification, partially satisfied, missing, ambiguous, or repeated request. A receipt alone cannot establish sufficiency. Return source page, quoted evidence, submission reference, suggested owner and next action. Generate a downloadable chronology and a draft response for handler approval.

## 2. Proposal Disclosure Checker
Compare customer-confirmed disclosures with the draft proposal for the same insured person. Display omissions, contradictions, unanswered fields and explicit negative answers. Preserve dates and which covered family member each answer concerns. Show the two source passages side by side. Let the advisor resolve each finding and record customer confirmation. Never infer a diagnosis, fill missing medical answers, or submit a proposal automatically.

## 3. Renewal Terms Change Agent
Compare the expiring policy schedule, endorsements and proposed renewal for the same policyholder, product and period. Flag ambiguous or mismatched document pairs. Extract premium, sum insured, co-pay with scope, deductibles, room limits, sub-limits, exclusions, and waiting-period wording. Distinguish a confirmed change from an absent page, OCR failure or simple rephrasing. Show old value, new value, source pages and reviewer decision. Generate an English or Hindi customer explanation and record acknowledgement of individual material changes.

## Shared operating workflow
Case queue with owner, status, due date and insurer. Support intake, extraction, evidence review, exception resolution, approval, export and reopening. Idempotent jobs and document hashes so retries or repeated uploads do not create duplicate cases or findings. Version every review against the exact documents and model used. Preserve reviewer corrections and an audit trail. Put actions requiring attention first on the operator screen.

Role-based access for handler, supervisor and read-only analyst. Enforce case access server-side. Short-lived document links, server-side secrets, configurable retention and deletion, logs without document contents. Treat uploaded documents as untrusted data. Validate structured model output and verify cited passages exist. Require human approval before any external communication. Keep insurer decisions and coverage determinations with authorized people. Fictional records in the hosted demo. Live connectors only when configured and authorized.

## Founder's Office dashboard
Measure review minutes, repeat requests, corrected discrepancies, acknowledged changes, reviewer overrides, false matches and unresolved cases by age. Define numerator, denominator and date window for every KPI. Separate fixture results, measured pilot results and scenario estimates. CSV export and a scenario calculator for monthly hours released. Do not generate fictional business impact.

## Acceptance tests
Seed complete, partial, duplicate, contradictory and unreadable cases for each module. Test: receipt for the wrong bill, unsigned document when signed required, two family members with similar names, blank vs "No", endorsement overriding a schedule, 0% to 20% co-pay change, missing pages, retries, unauthorized case access. Verify upload through final export in a browser. Publish fixture evaluation results for classification accuracy and citation correctness. Document known failure cases.

## Delivery
Working source, schema and migrations, sample inputs, evaluation fixtures, deployment configuration, .env template, reviewer walkthrough, one-page pilot plan. Run build, tests and smoke checks. Deploy the synthetic demo, verify the deployed URL, report exactly which integrations were exercised. If a credential is unavailable, finish and test the independent demo, then identify the precise credential and remaining verification needed for production.
