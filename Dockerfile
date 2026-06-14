FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

# Ensure cache directory exists and is writable by non-root user
RUN mkdir -p /app/cache && chown -R 1000:1000 /app

EXPOSE 9119

USER 1000

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD node -e "fetch('http://127.0.0.1:9119/readyz').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
