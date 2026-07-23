FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Jakarta

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p config sessions/whatsapp sessions/baileys downloads logs data \
  && chown -R node:node /app

USER node

CMD ["npm", "start"]
