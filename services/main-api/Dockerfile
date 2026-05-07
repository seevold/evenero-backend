# syntax=docker/dockerfile:1.6
# Multi-stage build for main-api Cloud Run service.
# Build context er services/main-api/ (single-service build) eller repo-root.
# Vi går ut fra at build context er services/main-api/.

# ---------- Build stage ----------
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---------- Runtime stage ----------
FROM node:20-slim
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist

RUN npm ci --omit=dev && npm cache clean --force

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/index.js"]
