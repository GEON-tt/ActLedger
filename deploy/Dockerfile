# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --filter "@actledger/server..."
RUN pnpm --filter "@actledger/server..." run build
RUN pnpm --filter @actledger/server deploy --prod /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production ACTLEDGER_DATA=/data
WORKDIR /app
COPY --from=build /out /app
RUN chmod +x /app/dist/main.js \
 && ln -s /app/dist/main.js /usr/local/bin/actledger-server \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4400/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["actledger-server"]
CMD ["serve", "--host", "0.0.0.0", "--port", "4400"]
