# mango-api container (linux/arm64). Build context: repository root.
FROM ghcr.io/astral-sh/uv:0.12.19 AS uv

FROM public.ecr.aws/docker/library/python:3.13-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /src
COPY pyproject.toml uv.lock ./
COPY packages/py/mango-core packages/py/mango-core
COPY packages/py/mango-packs packages/py/mango-packs
COPY apps/api apps/api
# Connector manifests: the MCP catalog is release data, baked into the image (D19).
COPY connectors connectors
# What each Bedrock model can do: release data too (rule 7).
COPY models/capabilities.json models/capabilities.json
# Install only mango-api and its runtime dependencies from the lockfile.
RUN uv export --frozen --no-dev --package mango-api --no-emit-workspace --no-header \
      --format requirements-txt > /tmp/requirements.txt \
 && uv pip install --system --no-cache --requirement /tmp/requirements.txt --target /app \
 && cp -R packages/py/mango-core/src/. /app/ \
 && cp -R packages/py/mango-packs/src/. /app/ \
 && cp -R apps/api/src/. /app/ \
 && for manifest in connectors/*/manifest.json; do \
      id="$(basename "$(dirname "$manifest")")"; \
      mkdir -p "/app/mcp-catalog/$id" && cp "$manifest" "/app/mcp-catalog/$id/manifest.json"; \
    done \
 && cp models/capabilities.json /app/model-capabilities.json

FROM public.ecr.aws/docker/library/python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app \
    MANGO_MCP_CATALOG_DIR=/app/mcp-catalog \
    MANGO_MODEL_CAPABILITIES=/app/model-capabilities.json
COPY --from=build /app /app
USER 10001:10001
EXPOSE 8000
# Mirrors the ECS task health check (ECS ignores this instruction; it serves local runs).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"]
CMD ["python", "-m", "uvicorn", "mango_api.app:main", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-server-header", "--timeout-keep-alive", "75"]
