# CI supplies the fixed private runtime checkout as the agent-runtime build context.
FROM python:3.12-slim AS build
WORKDIR /build
RUN pip install --no-cache-dir uv==0.10.12
COPY --from=agent-runtime / /runtime/
COPY services/learning/pyproject.toml services/learning/uv.lock ./
RUN uv export --frozen --no-dev --no-emit-project --no-emit-package agent-runtime --format requirements-txt --no-hashes > requirements.txt \
    && uv pip install --prefix /install -r requirements.txt \
    && uv pip install --prefix /install --no-deps /runtime
COPY services/learning/src ./src
RUN uv pip install --prefix /install --no-deps .

FROM python:3.12-slim AS runtime
COPY --from=build /install /usr/local
RUN groupadd --gid 10001 learning && useradd --uid 10001 --gid 10001 --no-create-home learning \
    && mkdir -p /data/runtime && chown learning:learning /data/runtime && chmod 700 /data/runtime
WORKDIR /app
ENV HOST=0.0.0.0 PORT=4320 RUNTIME_DATABASE=/data/runtime/runtime.sqlite PYTHONDONTWRITEBYTECODE=1
ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/yiminspace/ielts-lab"
LABEL org.opencontainers.image.revision=${GIT_SHA}
USER learning
EXPOSE 4320
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4320/healthz', timeout=4)"
CMD ["python", "-m", "ielts_learning"]
