FROM node:22-slim AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY frontend frontend
COPY tsconfig.json vite.config.mjs ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LOG_FILE="" \
    PORT=8018
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend backend
COPY --from=frontend /app/dist dist
RUN useradd -m routewise && chown -R routewise:routewise /app
USER routewise
EXPOSE 8018
# Render sets PORT and terminates TLS at its proxy; trust X-Forwarded-For so rate limits see real client IPs.
CMD ["sh", "-c", "exec uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*' --no-access-log"]
