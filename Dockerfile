FROM node:20-alpine

WORKDIR /app

COPY server/package*.json server/
RUN cd server && npm ci --omit=dev

COPY server server
COPY client client

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
