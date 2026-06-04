FROM node:25 AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@10.32.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/ai-sdk/package.json packages/ai-sdk/package.json
COPY packages/cli/package.json packages/cli/package.json
RUN pnpm install --frozen-lockfile

COPY . .
# sonamu build = api dist + web vite build → packages/api/web-dist 로 복사.
# 워크스페이스 내부 의존 0개라 sdk/ai-sdk/cli 는 빌드에 불필요(전체 install 은 lockfile 일관성 위해 유지).
RUN pnpm -C packages/api sonamu build

FROM node:25-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y libpq5 procps && rm -rf /var/lib/apt/lists/*

RUN npm i -g pnpm@10.32.0
RUN npm i -g @openai/codex

ENV HOST=0.0.0.0
ENV PORT=44900

# 런타임 필요분만 복사
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/api ./packages/api

EXPOSE 44900
CMD ["pnpm", "-C", "packages/api", "start"]
