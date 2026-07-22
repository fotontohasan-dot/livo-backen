# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache curl

FROM base AS deps
COPY package*.json ./
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

FROM base AS production
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/public/uploads && chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fs http://localhost:${PORT:-3000}/health || exit 1
CMD ["node", "app.js"]

FROM base AS development
ENV NODE_ENV=development
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
EXPOSE 3000
CMD ["npx", "nodemon", "app.js"]
