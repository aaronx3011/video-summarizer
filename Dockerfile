FROM node:24-bookworm AS client
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HF_HOME=/data/models
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && python3 -m venv /opt/whisper && /opt/whisper/bin/pip install --no-cache-dir faster-whisper yt-dlp
ENV PATH="/opt/whisper/bin:$PATH"
COPY --from=client /app/dist ./dist
COPY server.js transcribe.py ./
EXPOSE 3001
CMD ["npm", "start"]
