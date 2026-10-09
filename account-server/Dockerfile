# Headroom Account Server, with the web app. Build from the repository root:
#   docker build -f account-server/Dockerfile -t headroom-accounts .
#   docker run -d -p 8780:8780 -v headroom-accounts:/data headroom-accounts
# Put it behind HTTPS (e.g. Caddy) or pass TLS_CERT/TLS_KEY.
FROM node:22-alpine
WORKDIR /app
COPY account-server/server.mjs ./
COPY web ./web
ENV DATA_DIR=/data WEB_ROOT=/app/web PORT=8780
# A fresh named volume copies this directory's owner, so the unprivileged user can write the database.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8780
USER node
CMD ["node", "server.mjs"]
