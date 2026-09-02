# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache curl tar gzip

FROM base AS deps
COPY package*.json ./
# `|| npm install` ফলব্যাক সরানো হয়েছে: npm ci ব্যর্থ হলে (লকফাইল অসামঞ্জস্য)
# আগে নীরবে non-deterministic install চলত, ফলে প্রোডাকশন ইমেজে এমন ভার্সন
# ঢুকতে পারত যা কেউ রিভিউ করেনি এবং বিল্ড লগে ব্যর্থতা দেখাই যেত না।
# লকফাইল অবৈধ হলে বিল্ড এখন জোরে ব্যর্থ হবে।
RUN npm ci --omit=dev --legacy-peer-deps

FROM base AS production
ENV NODE_ENV=production
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# /app/backups ইমেজেই তৈরি করে nodejs-এর মালিকানায় দেওয়া হচ্ছে। docker-compose.yml এখানে
# backups_data নামের ভলিউম মাউন্ট করে — মাউন্ট-পাথ ইমেজে না থাকলে Docker সেটা root:root
# হিসেবে বানায়, আর কন্টেইনার USER nodejs হিসেবে চলে বলে services/backupManager.js-এর
# সব রাইট EACCES-এ ব্যর্থ হতো (ব্যাকআপ ফিচার কন্টেইনারে সম্পূর্ণ অকেজো থাকত)।
RUN mkdir -p /app/public/uploads /app/backups && chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fs http://localhost:${PORT:-3000}/health || exit 1
CMD ["node", "server.js"]

FROM base AS development
ENV NODE_ENV=development
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
EXPOSE 3000
CMD ["npx", "nodemon", "server.js"]
