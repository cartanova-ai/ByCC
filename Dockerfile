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

# Claude CLI 온보딩 스킵
RUN mkdir -p /root/.claude && echo '{"hasCompletedOnboarding":true,"theme":"dark"}' > /root/.claude/settings.json

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=44900

COPY --from=builder /app /app

EXPOSE 44900
CMD ["pnpm", "-C", "packages/api", "start"]
