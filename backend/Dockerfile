FROM node:22-bookworm-slim AS build

WORKDIR /app/backend

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src

RUN pnpm install --frozen-lockfile
RUN pnpm run build
RUN pnpm prune --prod


FROM node:22-bookworm-slim AS runtime

WORKDIR /app/backend

ENV NODE_ENV="production"
ENV PORT="3001"

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/backend/package.json ./package.json
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist

RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 3001

CMD ["node", "dist/index.js"]

