# syntax=docker/dockerfile:1.6
# Multi-stage build for zipper-service-v2 Cloud Run service.

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
ENV PORT=8080

# Entry-script velger mode:
#   JOB_MODE=true → batch-prosess (Cloud Run Job execution)
#   ellers        → HTTP-server (Cloud Run Service)
# Begge bygges av samme image — én Dockerfile, to deploy-targets.
CMD ["sh","-c","if [ \"$JOB_MODE\" = \"true\" ]; then exec node dist/job.js; else exec node dist/index.js; fi"]
