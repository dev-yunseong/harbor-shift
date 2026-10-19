FROM docker:29-cli AS docker
FROM node:24-alpine
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json ./
COPY src ./src
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "src/proxy-cli.js"]
CMD ["/config/service.json"]
