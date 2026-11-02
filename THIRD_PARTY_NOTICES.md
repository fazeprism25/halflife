# Third-party notices and acknowledgements

Halflife's own source code is licensed under the [Apache License 2.0](LICENSE). This file lists the third-party software, data and services Halflife builds on, how each one is used, and whether any of it is included in this repository. It is a good-faith inventory, not legal advice.

## Summary

| Component | Licence | In this repository? | How it is used |
|---|---|---|---|
| Bifrost (`maximhq/bifrost`, tag `transports/v2.4.0`, commit `e869c3f`) | Apache-2.0 | **No** | cloned and compiled inside the gateway image at build time |
| Bifrost's Go dependencies (via `transports/go.sum`) | various; see below | No | compiled into the gateway binary and plugin at build time |
| Go standard library and toolchain | BSD-3-Clause | No | build image `golang:1.27.3-bookworm` |
| Node.js 24 | MIT (plus bundled components' licences) | No | engine runtime, image `node:24.16.0-bookworm-slim` |
| Debian base image | various (Debian packages) | No | gateway runtime image `debian:bookworm-slim` |
| FreshQA dataset | repository Apache-2.0; spreadsheet data has **no stated licence** | **No** (only our own adjudication notes) | evaluation input; downloaded by the user |
| Tavily, DeepSeek | commercial API services, governed by their terms of service | No | called at runtime with the user's own keys |
| Wikidata (feasibility sprint only) | CC0 | aggregate statistics only | `experiments/feasibility/results/wikidata_*.json` |

The browser extension (`extension/`) has **no dependencies**. Its ChatGPT DOM handling was informed by reading the source of three public projects (inspected 2026-11-03; no code copied):
- [dialoguesai/chatgpt-shadow-extension](https://github.com/dialoguesai/chatgpt-shadow-extension) (Apache-2.0): the September 2026 "search unit" attributes and its streaming indicators, re-implemented in `extension/src/adapters/chatgpt.js`.
- [maks-bond/chatgpt-conversation-exporter](https://github.com/maks-bond/chatgpt-conversation-exporter) (no licence): only its published observation that off-screen turns are empty shells. None of its code is used.
- [kappilyadav/chatgpt-exporter](https://github.com/kappilyadav/chatgpt-exporter) (MIT): reviewed for comparison; nothing used.

The engine (`engine/`) has **no npm dependencies**. The console references fonts by name only (Inter, JetBrains Mono, Iowan Old Style and system fallbacks); no font files are bundled. Its icons are simple SVG paths written for this project.

## Bifrost

- Source: <https://github.com/maximhq/bifrost>. Licence: Apache License 2.0, Copyright 2025 H3 Labs Inc.
- Halflife uses Bifrost only through supported extension points (a Go plugin, Relays, the cache plugin's context key and admin API). No Bifrost source file is copied into this repository. The plugin's exported hook functions follow Bifrost's plugin interface signatures, and it imports `github.com/maximhq/bifrost/core/schemas`.
- **If you distribute images built from this repository**, they contain Bifrost and its dependencies. You must then comply with the Apache-2.0 terms (include its licence and any NOTICE), and with the terms of the dependencies listed below. Bifrost's own [`THIRD_PARTY_NOTICES.md`](https://github.com/maximhq/bifrost/blob/main/THIRD_PARTY_NOTICES.md) identifies MPL-2.0 Go components compiled into its binary: `github.com/hashicorp/go-version`, and parts of `github.com/cyphar/filepath-securejoin`. MPL-2.0 requires that the source of those files remains available.
- The plugin `.so` links the packages imported by `core/schemas`. Their direct third-party imports and the licences their upstream repositories state are: `github.com/bytedance/sonic` (Apache-2.0), `github.com/mark3labs/mcp-go` (MIT), `github.com/tidwall/gjson` and `github.com/tidwall/sjson` (MIT), `github.com/valyala/fasthttp` (MIT), and `golang.org/x/net` (BSD-3-Clause). All are permissive and compatible with Apache-2.0. Exact versions are pinned by Bifrost's `go.sum`.
- The gateway image replaces Bifrost's web UI with a one-line stub page, so no Bifrost UI (npm) code is built or shipped.

## FreshQA

- Vu, T., Iyyer, M., Wang, X., Constant, N., Wei, J., Wei, J., Tar, C., Sung, Y.-H., Zhou, D., Le, Q., and Luong, T. (2023). *FreshLLMs: Refreshing Large Language Models with Search Engine Augmentation.* arXiv:2310.03214. Repository: <https://github.com/freshllms/freshqa>.
- The repository's code is Apache-2.0, but the dataset itself is published as Google Sheets **without an explicit licence**. This repository therefore does **not** include the snapshot CSVs, the sampled evaluation set, or raw runs that reproduce questions and answers verbatim. The build, run and score scripts are included; [docs/EVALUATION.md](docs/EVALUATION.md) explains how to obtain the data yourself.
- `eval/freshqa-adjudications.json` contains only this project's own adjudication notes and source URLs, keyed by item ID.
- Aggregate results and a few short descriptions of individual items appear in the documentation to report the evaluation.

## Web content in screenshots and results

The console screenshots in `docs/assets/screenshots/` show short excerpts, titles and URLs of third-party web pages returned by Tavily as evidence. They are shown, as the product shows them, to illustrate how Halflife cites its sources. All rights in that content remain with its owners.

## Services

Halflife calls the **Tavily** and **DeepSeek** APIs, and optionally other LLM providers, with credentials that you supply. Your use of those services is governed by their terms. This repository includes no credentials and no cached API responses, apart from the evaluation summaries described above.
