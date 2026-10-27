FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json vite.config.ts ./
COPY apps/web/package.json ./apps/web/package.json
COPY services/api/package.json ./services/api/package.json
RUN npm ci --ignore-scripts
COPY apps/web ./apps/web
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317
COPY --from=build /app/dist ./dist
COPY deploy/web-server.mjs ./web-server.mjs
ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/yiminspace/ielts-lab"
LABEL org.opencontainers.image.revision=${GIT_SHA}
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "web-server.mjs"]
