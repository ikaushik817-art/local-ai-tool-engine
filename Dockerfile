# One instance for one person. Not a multi-user server (see SECURITY.md).
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV AI_UI_HOST=0.0.0.0 AI_UI_PORT=3737 \
    AI_FILES_DIR=/data AI_NOTES_FILE=/data/.ai-memory.json AI_LOG_FILE=/data/logs/late.log \
    AI_HISTORY_FILE=/data/.ai-history.json
VOLUME /data
EXPOSE 3737
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3737/api/health || exit 1
CMD ["node", "server.js"]
