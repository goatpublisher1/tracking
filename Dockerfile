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

# O rolling update do Coolify exige health check passando: ele sobe o container
# novo, espera ficar saudavel, e so entao derruba o antigo. Sem isso, todo
# redeploy tem uma janela em que o webhook e recusado — e a PayT nao re-tenta.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
