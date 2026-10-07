# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci
COPY . .
# prisma generate needs the schema; tsc compiles src/ to dist/
# DATABASE_URL is only needed so the Prisma CLI can parse the schema; no connection is made at build time.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm run build

# Runtime image. We keep the full node_modules (incl. tsx) because the one-shot "migrate" service runs the
# TypeScript migration/seed scripts with it. For a leaner prod image, compile scripts too and `npm prune --omit=dev`.
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache wget
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json
USER node
EXPOSE 4000 4001
CMD ["node", "dist/server.js"]
