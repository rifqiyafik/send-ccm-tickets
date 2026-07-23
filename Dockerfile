FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Jakarta

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p config sessions/whatsapp sessions/baileys downloads logs data \
  && mkdir -p reference-data \
  && cp data/pic_nop_region_sumbagut.json reference-data/pic_nop_region_sumbagut.json \
  && cp data/ccm_handling_sqa_region_sumbagut.json reference-data/ccm_handling_sqa_region_sumbagut.json \
  && chown -R node:node /app

USER node

CMD ["npm", "start"]
