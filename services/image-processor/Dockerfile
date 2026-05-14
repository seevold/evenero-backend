# syntax=docker/dockerfile:1.6
# Multi-stage build for image-processor Cloud Run service.
# Build context er services/image-processor/.

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

# sharp har native deps via libvips (inkludert i prebuilt binary).
# Ingen ekstra apt-packages nødvendig for JPEG/PNG/WebP.
# HEIC håndteres av heic-convert (WASM, ingen native deps).

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist

RUN npm ci --omit=dev && npm cache clean --force

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/index.js"]
