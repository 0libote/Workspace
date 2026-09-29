FROM oven/bun:1.4.2-alpine AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 WEB_DIST_DIR=/app/apps/web/dist
COPY --from=build --chown=10001:10001 /app /app
USER 10001:10001
EXPOSE 3000
CMD ["bun", "apps/server/src/index.ts"]
