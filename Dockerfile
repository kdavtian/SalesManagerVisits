FROM node:20-alpine

# The user and su-exec come first: they never change, so this layer is cached and the slow steps below do not repeat on every deploy.
RUN apk add --no-cache su-exec \
  && addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY server/package*.json server/
RUN cd server && npm ci --omit=dev

# poppler's pdftoppm turns a document PDF into one picture (server/src/shared/pdfPreview.js): the viewer shows it at once and "Save" stores it in the
# phone's photos. Own layer after npm ci, so it is installed once and cached like the dependencies.
RUN apk add --no-cache poppler-utils

COPY server server
COPY client client

# Only the uploads folder is ever written to (docker-entrypoint.sh fixes its owner at start). The code and node_modules stay root-owned and
# read-only for the app user: the old `chown -R /app` copied the whole of node_modules into a new image layer on every deploy.
RUN mkdir -p /app/server/uploads && chown app:app /app/server/uploads

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
