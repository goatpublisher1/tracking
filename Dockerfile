# =====================================================================
#  Dockerfile — empacota a app de tracking para o Coolify
#  Coloque este arquivo na MESMA pasta dos .js e do package.json.
#  No Coolify: New Resource → Application → Dockerfile.
# =====================================================================
FROM node:20-slim

WORKDIR /app

# instala só as dependências primeiro (cache de build)
COPY package.json ./
RUN npm install --omit=dev

# copia o restante do código
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
