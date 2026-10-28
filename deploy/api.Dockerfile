FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY services/api/package.json ./services/api/package.json
RUN npm ci --omit=dev --workspace @ielts-lab/api --include-workspace-root=false --ignore-scripts && npm cache clean --force

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY services/api ./services/api
COPY apps/web/src/lib/questions.mjs apps/web/src/lib/test-track.mjs ./apps/web/src/lib/
RUN mkdir -p /data/recordings /data/daily && chown node:node /data/recordings /data/daily
ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/yiminspace/ielts-lab"
LABEL org.opencontainers.image.revision=${GIT_SHA}
USER node
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:4318/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "services/api/index.mjs"]
