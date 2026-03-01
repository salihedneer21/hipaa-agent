FROM node:22-bookworm-slim AS build

WORKDIR /app/frontend

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src

RUN pnpm install --frozen-lockfile
RUN pnpm run build


FROM caddy:2-alpine AS runtime

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/frontend/dist /srv

EXPOSE 80 443

