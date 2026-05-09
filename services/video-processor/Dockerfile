# syntax=docker/dockerfile:1.6
# Multi-stage build for video-processor Cloud Run service.
# Build context er services/video-processor/.

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

# ffmpeg + ffprobe fra Debian-pakker (~ libavcodec/libx264/libfdk-aac-fri).
# Installerer libheif1 + webp for sharp-likende WebP-poster (vi bruker bare ffmpeg, men trygt å ha).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist

RUN npm ci --omit=dev && npm cache clean --force

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/index.js"]
