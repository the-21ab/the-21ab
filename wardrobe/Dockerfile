FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# No runtime dependencies, so there is nothing to npm install.
COPY package.json server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
