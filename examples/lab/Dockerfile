FROM node:24-alpine
ARG VERSION=v1
ENV VERSION=$VERSION
WORKDIR /app
COPY server.js ./server.js
USER node
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
