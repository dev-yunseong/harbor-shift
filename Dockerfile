FROM docker:29-cli AS docker
FROM node:24-alpine
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "src/proxy-cli.js"]
CMD ["/config/harbor.yml"]
