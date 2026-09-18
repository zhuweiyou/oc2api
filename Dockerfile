# Static checks (lint + format) must pass before the runtime image is built.
FROM node:24-alpine AS check
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run lint && npm run format:check

FROM node:24-alpine AS runtime
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/index.js"]