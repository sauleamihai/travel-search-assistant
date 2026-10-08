FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM dependencies AS test
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tests ./tests
RUN chown node:node /app
USER node
CMD ["sh", "-c", "npm run check && npm run test:ci"]

FROM dependencies AS runtime
ENV NODE_ENV=production PORT=3000
COPY src ./src
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => { if (!r.ok) process.exitCode = 1; }).catch(() => { process.exitCode = 1; })"
CMD ["node", "src/server.js"]
