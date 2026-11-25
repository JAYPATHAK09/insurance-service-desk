# KPI definitions

Source of truth in code: `src/modules/dashboard/definitions.ts` (a test checks that every id below exists in code). Computation: `src/modules/dashboard/kpi.ts`.

## Three kinds of result, never mixed

| Label | What it is | Where it comes from |
|---|---|---|
| Fixture results | Seeded synthetic cases and fixture evaluation | `kpi_events.source = 'fixture'`; `fixtures/<module>/eval-results.json` |
| Measured pilot results | Real review events only | `kpi_events.source = 'pilot'`. With none recorded the page shows "No pilot data yet" |
| Scenario estimates | User-entered assumptions | The calculator (never stored, never measured) |

Each source is computed separately and shown on its own tab. No figure combines sources.

**Attribution rule.** A case belongs to a source only when every `kpi_events` row that references it has that one source. Cases with no events or with mixed sources are excluded, and events with no case or whose case belongs to another source are excluded; both are counted and shown under each table. This is what keeps finding and case denominators (which have no source column) from leaking across sources.

**Windows.** `from` is inclusive, `to` is exclusive in code (the page and API take an inclusive `to` day, YYYY-MM-DD, UTC). Default: the last 30 days. Numerators use `kpi_events.at`; denominators use `findings.created_at`. Unresolved-by-age is a snapshot, not a range.

**No data.** If a denominator is 0 the value is empty (`n/a` on the page, blank in CSV). Nothing is defaulted or estimated.

## Measures

| id | Measure | Numerator | Denominator |
|---|---|---|---|
| `review_minutes_mean` | Review minutes per case (mean) | Sum of `kpi_events.value` for kind `review_minutes`, per attributed case, summed over cases | Distinct attributed cases with at least one `review_minutes` event in the window |
| `repeat_request_rate` | Repeat requests | Count of `repeat_request` events | Count of claim-reconciler findings |
| `corrected_discrepancy_rate` | Corrected discrepancies | Count of `finding_corrected` events | Count of findings, all modules |
| `acknowledged_change_rate` | Acknowledged changes | Count of `change_acknowledged` events | Count of renewal-agent findings classified `confirmed_change` |
| `reviewer_override_rate` | Reviewer overrides | Count of `reviewer_override` events | Count of findings with a decision (status accepted, overridden or dismissed) |
| `false_match_rate` | False matches | Count of `false_match` events | Count of findings classified `satisfied_pending_verification`, `partially_satisfied`, `unchanged` or `rephrasing_only` |
| `unresolved_0_2` | Unresolved cases aged 0-2 days | Attributed cases not `exported` with age 0-2 days | All attributed cases not `exported` |
| `unresolved_3_7` | ... aged 3-7 days | as above, 3-7 days | as above |
| `unresolved_8_14` | ... aged 8-14 days | as above, 8-14 days | as above |
| `unresolved_15_plus` | ... aged 15+ days | as above, 15 days or more | as above |

Age is whole days from `cases.created_at` to the as-of instant (negative clamped to 0). Rows with non-numeric or negative `review_minutes` values are ignored.

Event kinds are written by the module agents into `kpi_events` (columns `kind`, `value`, `source`, `case_id`, `dedupe_key`). Counting events, not `value`, is deliberate for every kind except `review_minutes`.

## Fixture evaluation

`fixtures/<module>/eval-results.json`: `{ "classification": {"correct","total"}, "citation": {"correct","total"}, "mode"? }`. Classification accuracy = correct / total of expected classifications matched; citation correctness = correct / total of cited quotes verified in the source page. Accuracy is computed by the dashboard from the counts.

## Scenario calculator

Inputs (all user-editable; defaults are flagged placeholders, not measurements): cases per month, minutes per case today, % minutes saved, review/verification minutes retained per case, ramp %.

```
gross saved minutes per case = minutes per case today x % saved / 100
net saved minutes per case   = max(0, gross saved - retained minutes per case)
cases on new workflow        = cases per month x ramp % / 100
hours released per month     = cases on new workflow x net saved minutes per case / 60
```

Output is always labelled "Scenario estimate, not a measured result".

## CSV export

`GET /api/kpi/export?from=YYYY-MM-DD&to=YYYY-MM-DD` (supervisor and analyst; handler 403). One row per KPI per source with columns: source, source_label, kpi_id, kpi, unit, numerator, denominator, value, window_from, window_to, numerator_definition, denominator_definition, window_definition. Cells starting with a formula character are prefixed with an apostrophe.
