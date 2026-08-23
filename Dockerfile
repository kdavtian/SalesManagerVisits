FROM node:20-alpine

WORKDIR /app

COPY server/package*.json server/
RUN cd server && npm ci --omit=dev

COPY server server
COPY client client

RUN mkdir -p /app/server/uploads \
  && addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 3000

USER app

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
