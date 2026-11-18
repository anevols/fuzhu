FROM node:24-alpine AS build

RUN npm install -g pnpm@10.5.2
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIST=/app/apps/web/dist

COPY --from=build /app /app
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8787 80 443
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1

CMD ["node", "apps/server/dist/index.js"]
