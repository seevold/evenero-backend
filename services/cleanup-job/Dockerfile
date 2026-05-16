# syntax=docker/dockerfile:1.6
# Cloud Run Job — kjøres på Cloud Scheduler-trigger og slettes når ferdig.
# Build context er services/cleanup-job/.

FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-slim
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist

RUN npm ci --omit=dev && npm cache clean --force

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
