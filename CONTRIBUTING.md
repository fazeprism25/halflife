# Contributing to Halflife

Thanks for your interest. Halflife is a hackathon prototype maintained by one person, so please open an issue to discuss anything larger than a small fix before writing code.

> **Licence:** Halflife is licensed under the [Apache License 2.0](LICENSE). Under section 5 of that licence, any contribution you intentionally submit for inclusion is licensed under the same terms, unless you explicitly state otherwise. Only submit work you have the right to license this way. Do not paste code, data or text from sources whose licence is unclear or incompatible with Apache-2.0. Record any new third-party material in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Getting set up

Follow [docs/INSTALLATION.md](docs/INSTALLATION.md). For most engine work you only need Node.js 24; for the plugin and end-to-end tests you need Docker. Development workflow and debugging: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Before you open a pull request

1. **Run the tests that cover what you changed:**
   ```bash
   cd engine && npm test                                     # always
   docker build -f deploy/gateway.Dockerfile --target plugin-test --no-cache-filter plugin-test --progress=plain .   # if plugin/ or shared/ changed
   node deploy/test/integration.mjs                          # if deploy/, the plugin, or engine HTTP/cache behaviour changed
   ```
   None of these need API keys or spend credits.
2. **Add or update tests** for behaviour changes. Engine tests live in `engine/test/`; plugin tests in `plugin/plugin_test.go`.
3. **Do not run live scripts in CI-like loops.** Live scripts (`deploy/test/live-*.mjs`, `eval/*run*.mjs`, `deploy/demo/run-demo.mjs`) spend real Tavily credits and DeepSeek balance. If your change needs one, say so in the PR and report the spend.
4. **Never commit secrets, local state or private material:** `deploy/.env`, anything under `engine/data/`, `deploy/test/results/`, `deploy/demo/`'s backup screenshots and transcripts, FreshQA data or files that reproduce it verbatim, logs, or database files. Screenshots for documentation go in `docs/assets/screenshots/`, with local times, time zones and any personal data blanked out. Check `git status` and `git diff --cached` before committing.
5. **Update documentation** when behaviour, configuration or commands change: `README.md`, the relevant file in `docs/`, `deploy/.env.example` for new variables, and `CHANGELOG.md`.
6. **Record design decisions** in `research/ARCHITECTURE_DECISIONS.md` (next AD number: decision, why, alternatives rejected).

## Ground rules for the code

- **Engine stays dependency-free.** No npm packages without a recorded architecture decision. Use erasable TypeScript syntax only (no `enum`, `namespace` or parameter properties) and explicit `.ts` import extensions.
- **Plugin stays light and fail-open.** Standard library plus `bifrost/core/schemas` only; every hook recovers panics; no blocking network calls on the request path except in explicit `verify` mode with a timeout.
- **The LLM never produces numbers** that feed the model, and everything it returns is validated in code.
- **Never fabricate results.** Missing providers, failed calls and spend limits produce labelled limitations, never a guessed verdict.
- **Keep freshness and truth separate.** Halflife reports freshness risk, verification verdicts and evidence confidence as distinct quantities; do not merge them into one score or describe the project as a general fact-checker.
- Test-only code lives under `engine/test/` or `deploy/test/` and labels its output.

## Reporting bugs

Include: what you ran (commands, request body), what you expected, what happened, the report ID from `x-halflife-report` if relevant, and the engine/gateway log lines (`docker logs halflife-engine-1`). **Remove keys, tokens and virtual keys** from anything you paste.

For security issues, see [docs/SECURITY.md](docs/SECURITY.md) — do not open a public issue.
