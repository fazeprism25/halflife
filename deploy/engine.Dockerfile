# Halflife engine (Node 24, zero npm dependencies: TypeScript runs via Node's native type
# stripping; storage is node:sqlite). Build context: repository root.
FROM node:24.16.0-bookworm-slim
ENV NODE_ENV=production HALFLIFE_DATA_DIR=/data HALFLIFE_CUES_PATH=/app/shared/temporal-cues.json
WORKDIR /app
COPY shared/ ./shared/
COPY engine/package.json ./engine/
COPY engine/src/ ./engine/src/
COPY engine/console/ ./engine/console/
COPY deploy/render-config.mjs ./deploy/render-config.mjs
RUN mkdir -p /data /bifrost && chown node:node /data /bifrost
USER node
WORKDIR /app/engine
EXPOSE 8090
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD node -e "fetch('http://127.0.0.1:8090/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/main.ts"]
