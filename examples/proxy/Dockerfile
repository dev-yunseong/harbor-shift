FROM node:24-alpine
ARG VERSION=v1
ENV VERSION=$VERSION
WORKDIR /app
COPY app.js ./app.js
USER node
STOPSIGNAL SIGTERM
CMD ["node", "app.js"]
