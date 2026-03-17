FROM node:lts-alpine
RUN apk add --no-cache git bash
RUN npm install -g pnpm
WORKDIR /app
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts
CMD ["pnpm", "exec", "vitest", "run", "src/tests/new-user-e2e.test.ts"]
