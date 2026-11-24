# E2E fixtures

The `.txt` files are the mongosh output printed in the MongoDB manual's tested code examples, copied byte for byte from
[`mongodb/docs`](https://github.com/mongodb/docs) at a pinned commit (sample_mflix dataset, MongoDB 8.2.2). They are
used here only as test input; the copyright and terms of that repository apply to them.

| File | Source (pinned commit `22f0b96` / `048f704`) |
|---|---|
| `analyze-query-plan-no-index.txt` | [`tutorial/analyze-query-plan/range-explain-no-index-output.sh`](https://github.com/mongodb/docs/blob/22f0b96d949801c97efcb66fba554b67804a1f66/content/code-examples/tested/command-line/mongosh/tutorial/analyze-query-plan/range-explain-no-index-output.sh) (`executionStats`, COLLSCAN, hand-trimmed with `'...': '...'`) |
| `analyze-query-plan-index.txt` | [`tutorial/analyze-query-plan/range-explain-index-output.sh`](https://github.com/mongodb/docs/blob/22f0b96d949801c97efcb66fba554b67804a1f66/content/code-examples/tested/command-line/mongosh/tutorial/analyze-query-plan/range-explain-index-output.sh) (`executionStats`, IXSCAN + FETCH) |
| `aggregation-explain.txt` | [`aggregation/pipelines/explain/output.sh`](https://github.com/mongodb/docs/blob/048f704820c9d00a62751692c600d6fb078e932a/content/code-examples/tested/command-line/mongosh/aggregation/pipelines/explain/output.sh) (`queryPlanner` only, SBE, one rejected plan) |
| `aggregation-explain-field.txt` | [`aggregation/pipelines/explain-field/output.sh`](https://github.com/mongodb/docs/blob/048f704820c9d00a62751692c600d6fb078e932a/content/code-examples/tested/command-line/mongosh/aggregation/pipelines/explain-field/output.sh) (`executionStats` aggregation, SBE GROUP over COLLSCAN) |

`sharded.ts` is **not** captured output. The manual publishes no complete sharded example, only the field layout in
[Explain Results](https://www.mongodb.com/docs/manual/reference/explain-results/); that file builds a small
synthetic document with exactly those documented fields and invented names and numbers.
