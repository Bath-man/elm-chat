FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci && npm run typecheck && npm test \
    && python3 scripts/package-source.py && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
# Retain workspace manifests so npm can recreate the same workspace dependency links.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/packages/crypto/package.json ./packages/crypto/package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.mjs"]
