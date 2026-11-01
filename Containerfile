# syntax=docker/dockerfile:1

FROM node:25-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY static ./static

RUN npm run build

FROM node:25-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV ANTIBUDGET_HOME=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY fixtures ./fixtures

RUN mkdir -p /data && chown -R node:node /app /data

USER node

VOLUME /data

EXPOSE 8080

ENTRYPOINT ["node", "--experimental-sqlite", "dist/src/cli.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8080"]
