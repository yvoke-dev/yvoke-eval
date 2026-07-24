# Test fixtures

A self-contained, synthetic eval suite used by the harness's own tests. It exists so the harness can
be tested without vendoring any real knowledge base's eval content — that content lives in its own
repository (e.g. `yvoke-eval-oim`) and the harness is pointed at it with `--config`.

Deliberately generic: the domain is a made-up "widget" product, and the playbook names
(`demo-basics`, `demo-advanced`) belong to no real deployment. **Do not add real questions,
collection names, product versions or customer data here.**

| Path | Exercises |
| --- | --- |
| `eval/eval_specs.yaml` | Every spec field the parser understands, including `skip` and `citations: false` |
| `eval/eval_basics.md` | Playbook header binding, `*(annotation)*` stripping, 7 questions (Q6 skipped) |
| `eval/eval_advanced.md` | A second category, so category grouping and selection are covered |
| `eval/baseline/basics/results.json` | The `EvalResult` wire shape — 3 results, all PASS |
| `graders/reviewer.md` | Two stacked frontmatter blocks, so `stripFrontmatter` is covered |
| `yvoke-eval.yaml` | Config loading, `${ENV:default}` interpolation, and two suite overlays |

`eval/runs/` is written into by `ReportWriter` tests and removed again; it is gitignored.
