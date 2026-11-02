# Feasibility build: Bifrost HTTP gateway (dynamic build, so it can plugin.Open .so files)
# plus the Halflife probe plugin compiled INSIDE the transports module, guaranteeing
# identical dependency versions (Go plugins require exact version match with the host).
# Build context: experiments/
FROM golang:1.27.3-bookworm AS builder
ENV CGO_ENABLED=1 GOOS=linux GOWORK=off GOFLAGS=-p=3 GOMAXPROCS=4
WORKDIR /app
COPY vendor/bifrost-v2.4.0/transports/go.mod vendor/bifrost-v2.4.0/transports/go.sum ./
RUN go mod download
COPY vendor/bifrost-v2.4.0/transports/ ./
# The gateway embeds its web UI (go:embed all:ui). We skip the Node UI build and embed a stub.
RUN mkdir -p bifrost-http/ui && echo '<html><body>ui stub (feasibility build)</body></html>' > bifrost-http/ui/index.html
RUN go build -trimpath -o /out/bifrost-http ./bifrost-http
COPY feasibility/probe/ ./halflifeprobe/
COPY feasibility/probe/ ./halflifeprobepre/
RUN go build -buildmode=plugin -trimpath -ldflags "-X main.pluginName=halflife-probe-post" -o /out/probe-post.so ./halflifeprobe \
 && go build -buildmode=plugin -trimpath -ldflags "-X main.pluginName=halflife-probe-pre"  -o /out/probe-pre.so  ./halflifeprobepre

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out/ /opt/bifrost/
WORKDIR /data
EXPOSE 8080 9091 9092
ENTRYPOINT ["/opt/bifrost/bifrost-http", "-app-dir", "/data", "-host", "0.0.0.0", "-port", "8080"]
