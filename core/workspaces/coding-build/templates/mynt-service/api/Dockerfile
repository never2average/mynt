# Build context: the project root (compose.yaml).
FROM node:22.11-alpine AS build
WORKDIR /app
COPY . .
RUN npm install --no-audit --no-fund -w api && npm run build -w api && npm prune --omit=dev

FROM node:22.11-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api/dist ./api/dist
COPY --from=build /app/api/contract ./api/contract
COPY --from=build /app/api/package.json ./api/package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "api/dist/server.js"]
