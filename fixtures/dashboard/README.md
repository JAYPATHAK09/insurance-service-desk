# Dashboard fixtures

The dashboard reads `fixtures/<module>/eval-results.json` (written by each module's evaluation test) and shows it read-only on the
"Fixture results" tab. Accuracy is computed by the dashboard from counts; any accuracy field in the file is ignored.

```json
{ "classification": { "correct": 0, "total": 0 }, "citation": { "correct": 0, "total": 0 }, "mode": "synthetic" }
```

No results are committed here: figures appear only when a module's evaluation publishes them.
