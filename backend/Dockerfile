# --- build stage: resolve production dependencies only ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime stage ---
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# node:alpine ships an unprivileged "node" user (uid 1000). Never run as root.
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
