FROM node:20-alpine

WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source code
COPY . .

EXPOSE 5540

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:${WEB_PORT:-5540}/ || exit 1

CMD ["node", "server.js"]
