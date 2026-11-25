# Disclosure checker fixtures

All people, insurers and references are fictional. Each folder is one case with an `expected.json` checked by `tests/disclosure-eval.test.ts`.

Two documents per case (`kind`: `disclosure` = customer-confirmed call record or form, `proposal` = draft proposal). Both use one line grammar:

```
CUSTOMER DISCLOSURE CONFIRMATION (call record)        |  DRAFT PROPOSAL - <insurer>
Insured person: <name>
Date of birth: <date>
Reference: <ref>
Confirmed on: <date>   |   Proposal date: <date>
Channel: <call|...>                                   (customer record only)

MEMBER: <name> (<self|spouse|child|parent>)
Q<n> | <question text> | <answer> | <date>
```

- An empty answer, or only underscores, is **blank** (unanswered). It is never read as "No".
- `N/A`, `-`, `not sure`, `Yes / No` templates are **ambiguous**.
- `Yes...` is yes; exactly `No`, `Nil`, `None` is an explicit negative.
- Members are matched only by exactly the same name (case and punctuation ignored).

`expected.json`: `files` (with `scan`: `sidecar` = scanned PDF read via `<file>.ocr.txt`, `failed` = scan whose OCR failed), `findings`
(member, question id, classification, verbatim quotes) and `docFindings` (comparison refused, e.g. `insured_mismatch`, `unreadable_document`).
`matched` is the number of answer pairs that agree and so produce no finding.

Cases: complete, partial, duplicate, contradictory, omission, similar-names, blank-vs-no, unreadable, insured-mismatch.
`eval-results.json` is written by `npx vitest run tests/disclosure-eval.test.ts` (or `npx tsx src/modules/disclosure-checker/eval.ts`).
