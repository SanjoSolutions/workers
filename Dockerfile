FROM node:lts-alpine
RUN apk add --no-cache git bash expect
RUN npm install -g pnpm
RUN printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/claude && chmod +x /usr/local/bin/claude
WORKDIR /app
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["pnpm", "exec", "vitest", "run", "src/tests/e2e/"]
