# Blacklane Sniper V2 - Multi-stage build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# For Playwright in Docker: install playwright (full) to get Chromium, or use CI image.
# RUN npx playwright install chromium --with-deps

USER node
EXPOSE 3000

CMD ["node", "dist/index.js"]
