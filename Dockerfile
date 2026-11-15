# The hosted app: the built frontend plus the Python backend, serving plain HTTP on port 8765 behind Cloudflare
# (see docs/hosting.md). Nothing secret is baked in: settings, the Enable Banking key and the data are mounted at run
# time (deploy/compose.yaml).

# --- Frontend ---
FROM node:26-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Backend ---
FROM python:3.15.0-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /bin/uv

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/backend/.venv/bin:$PATH"

WORKDIR /app/backend
# Dependencies first, so code changes don't reinstall them.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
# The project itself stays an editable install: the app finds the frontend next to its source (finance.config).
COPY backend/src ./src
RUN uv sync --frozen --no-dev
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# Runs as an unprivileged user; /data (the database) is the only place it writes.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin finance
USER finance
ENV FINANCE_DATA_DIR=/data
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=4)"]

# The commit this image was built from (CI passes it), shown in the app. Last, so a new commit only rebuilds this.
ARG APP_REVISION=""
ENV APP_REVISION=$APP_REVISION

CMD ["finance", "serve", "--host", "0.0.0.0", "--port", "8765", "--plain"]
