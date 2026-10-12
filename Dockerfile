FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV npm_config_nodedir=/usr/local
RUN npm install -g pnpm@11.21.0 && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/script/package.json packages/script/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm test

FROM node:24-bookworm-slim AS production-deps
WORKDIR /app
ENV npm_config_nodedir=/usr/local
RUN npm install -g pnpm@11.21.0 && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/script/package.json packages/script/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim
ENV NODE_ENV=production SUBHARBOR_DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
