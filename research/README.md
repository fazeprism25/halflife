# Research and project notes

Working documents written during development. They are kept for transparency and history; the maintained developer documentation is in [`../docs/`](../docs/).

| File | What it is |
|---|---|
| `RESEARCH_REPORT.md` | initial research: hackathon requirements, Bifrost and Tavily capabilities, market and competitor analysis, choice of product direction |
| `HALFLIFE_FEASIBILITY_REPORT.md` | feasibility sprint: what was proven on the real Bifrost binary before building (`../experiments/feasibility/`) |
| `ARCHITECTURE_DECISIONS.md` | numbered design decisions (AD-01 …) with reasons and rejected alternatives |
| `IMPLEMENTATION_LOG.md` | per-session log: changes, tests run with results, bugs found |
| `PROJECT_STATE.md` | current status, measured results, known limitations, priorities |
| `NEXT_SESSION.md` | hand-off notes for the next working session |
| `DEMO_SCRIPT.md` | the live demo script |
| `SUBMISSION.md` | hackathon submission **draft** (not submitted) |

**Note on referenced files.** These notes sometimes cite machine-local artefacts that are deliberately **not** in the repository: test logs and live-run results under `deploy/test/results/`, demo transcripts under `deploy/demo/results/`, raw v1/v2 evaluation runs (`eval/results/run-*.json`), the FreshQA snapshot CSVs and every file that reproduces FreshQA content verbatim (`eval/freshqa-set.json`, raw FreshQA runs, `eval/results/latest-freshqa.md`), the original unredacted screenshots (`deploy/demo/backup/`; sanitised copies are in `docs/assets/screenshots/`), the engine database and its backups, feasibility build logs, and the Bifrost source clones in `experiments/vendor/`. They were excluded because they are logs, local state, machine-specific, or third-party data (see `.gitignore`). The numbers quoted from them are recorded in these notes and, for the evaluation, reproducible from the committed files (see `../docs/EVALUATION.md`).

Some statements here describe the environment the project was built on (a Windows 11 laptop with Docker Desktop) and its constraints; they are not requirements.
