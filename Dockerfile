FROM node:25 AS builder
WORKDIR /app
RUN npm i -g pnpm@10.32.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm -C packages/api sonamu build

FROM node:25-slim AS runner
WORKDIR /app
RUN npm i -g pnpm@10.32.0
RUN npm i -g @anthropic-ai/claude-code

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=44900

COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/api ./packages/api

EXPOSE 44900
CMD ["pnpm", "-C", "packages/api", "start"]
