FROM node:24-bookworm-slim AS assets
WORKDIR /assets
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY scripts/vendor.mjs scripts/vendor.mjs
RUN npm run build

FROM ghcr.io/astral-sh/uv:0.9.30 AS uv
FROM python:3.12-slim-bookworm
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1 PATH="/app/.venv/bin:$PATH"
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY fotovibe fotovibe
COPY static static
COPY --from=assets /assets/static/vendor static/vendor
RUN useradd --system --uid 10001 --create-home fotovibe
USER fotovibe
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn fotovibe.app:create_app --factory --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*' --no-access-log"]
