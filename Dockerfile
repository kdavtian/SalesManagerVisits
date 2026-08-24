FROM node:20-alpine

WORKDIR /app

COPY server/package*.json server/
RUN cd server && npm ci --omit=dev

COPY server server
COPY client client

RUN apk add --no-cache su-exec \
  && mkdir -p /app/server/uploads \
  && addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
