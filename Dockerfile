# One image serves both the Angular UI and the API on a single origin.

FROM node:22-slim AS ui
WORKDIR /app/ajaia-docs-ui
COPY ajaia-docs-ui/package.json ajaia-docs-ui/package-lock.json ./
RUN npm ci
COPY ajaia-docs-ui/ ./
RUN npx ng build

FROM node:22-slim AS api
WORKDIR /app/ajaia-docs-api
COPY ajaia-docs-api/package.json ajaia-docs-api/package-lock.json ./
RUN npm ci
COPY ajaia-docs-api/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/ajaia-docs.db \
    STATIC_DIR=/app/public
WORKDIR /app
COPY --from=api /app/ajaia-docs-api/package.json ./
COPY --from=api /app/ajaia-docs-api/node_modules ./node_modules
COPY --from=api /app/ajaia-docs-api/dist ./dist
COPY --from=ui /app/ajaia-docs-ui/dist/ajaia-docs-ui/browser ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
