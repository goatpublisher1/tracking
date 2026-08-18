# =====================================================================
#  Dockerfile — empacota a app de tracking para o Coolify
#  Coloque este arquivo na MESMA pasta dos .js e do package.json.
#  No Coolify: New Resource → Application → Dockerfile.
# =====================================================================
FROM node:20-slim

WORKDIR /app

# npm ci exige o lockfile e instala exatamente as versoes pinadas.
# Com npm install + ranges ^, cada rebuild resolvia versoes diferentes de
# toda a arvore transitiva — deploy podia subir codigo nunca testado.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# copia o restante do código
COPY . .

# a imagem node:20-slim ja traz o usuario 'node'. Sem isto o processo roda
# como root com o DATABASE_URL e alcance a todos os capi_token.
USER node

EXPOSE 3000

CMD ["node", "server.js"]
