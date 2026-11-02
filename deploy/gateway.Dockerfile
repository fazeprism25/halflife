# Bifrost v2.4.0 gateway, built dynamically so it can load the Halflife plugin (.so).
#
# Why not the official image: it is statically linked and Go's plugin.Open needs a dynamic
# host. Why build the plugin inside the transports module: Go plugins must be compiled with
# exactly the host's dependency versions. (research/ARCHITECTURE_DECISIONS.md AD-01)
#
# Build context: repository root.
#   docker build -f deploy/gateway.Dockerfile -t halflife-gateway .
#   docker build -f deploy/gateway.Dockerfile --target plugin-test .   # Go unit + race tests

ARG GO_IMAGE=golang:1.27.3-bookworm

FROM ${GO_IMAGE} AS source
ARG BIFROST_REF=transports/v2.4.0
ARG BIFROST_COMMIT=e869c3f
RUN git clone --depth 1 --branch "${BIFROST_REF}" https://github.com/maximhq/bifrost.git /src \
 && cd /src && test "$(git rev-parse --short=7 HEAD)" = "${BIFROST_COMMIT}" \
 || (echo "Bifrost ref ${BIFROST_REF} is not commit ${BIFROST_COMMIT}" >&2; exit 1)

FROM ${GO_IMAGE} AS builder
# GOFLAGS=-p=3 keeps BuildKit within Docker Desktop's memory on a 16 GB host.
ENV CGO_ENABLED=1 GOOS=linux GOWORK=off GOFLAGS=-p=3 GOMAXPROCS=4
WORKDIR /app
COPY --from=source /src/transports/go.mod /src/transports/go.sum ./
RUN --mount=type=cache,target=/root/go/pkg/mod go mod download
COPY --from=source /src/transports/ ./
# The gateway embeds its web UI (go:embed all:ui). The Node UI build is skipped to keep the
# image small and the build light; a stub page is embedded instead. The Halflife console
# is served by the engine.
RUN mkdir -p bifrost-http/ui && printf '<!doctype html><title>Bifrost</title><p>Bifrost gateway (Halflife build). The Halflife console is served by the engine.</p>' > bifrost-http/ui/index.html
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -o /out/bifrost-http ./bifrost-http
COPY plugin/*.go ./halflife/
COPY shared/temporal-cues.json ./halflife/temporal-cues.json
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go vet ./halflife/ && go build -buildmode=plugin -trimpath -o /out/halflife.so ./halflife

FROM builder AS plugin-test
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go test -race -count=1 -v ./halflife/ 2>&1 | tee /out/plugin-test.log
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go test -run '^$' -bench . -benchmem -benchtime 3000x ./halflife/ | tee /out/plugin-bench.log

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* && useradd --system --uid 10001 --home /data bifrost \
 && mkdir -p /data && chown bifrost /data
COPY --from=builder /out/bifrost-http /out/halflife.so /opt/bifrost/
USER bifrost
WORKDIR /data
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD curl -fsS http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/opt/bifrost/bifrost-http", "-app-dir", "/data", "-host", "0.0.0.0", "-port", "8080"]
