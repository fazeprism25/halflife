# Experiments

Historical material from the feasibility sprint, kept as evidence for [`research/HALFLIFE_FEASIBILITY_REPORT.md`](../research/HALFLIFE_FEASIBILITY_REPORT.md). It is not part of the product and is not maintained.

| Path | Contents |
|---|---|
| `feasibility/probe/main.go` | a minimal probe plugin used to test Bifrost's plugin hooks, cache TTL, streaming and failure behaviour |
| `feasibility/configs/` | Bifrost configs for each probe scenario (local-only placeholder keys) |
| `feasibility/run.mjs` | the probe runner |
| `feasibility/tavily_probe.mjs` | a Tavily API probe (needs `TAVILY_API_KEY`; spends credits) |
| `feasibility/results/` | measured results cited by the feasibility report |

**Not reproducible from this repository alone.** `feasibility/Dockerfile` builds from Bifrost sources expected in `experiments/vendor/bifrost-v2.4.0/` (a clone of `https://github.com/maximhq/bifrost` at tag `transports/v2.4.0`), which is not committed. The build log, gateway logs and the host inventory are also excluded. The product build (`deploy/gateway.Dockerfile`) does not depend on anything in this directory.
