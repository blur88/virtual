FROM node:24-alpine

WORKDIR /app

COPY web/package.json ./
COPY web/ ./

RUN chown -R node:node /app

USER node

ENV NODE_ENV=production \
    OFFICE_WEB_HOST=0.0.0.0 \
    OFFICE_WEB_PORT=3000 \
    OFFICE_BRIDGE_URL=http://host.docker.internal:4040

EXPOSE 3000

CMD ["node", "cli.js"]
