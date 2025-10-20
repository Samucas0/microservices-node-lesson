# CONTEÚDO ATUALIZADO DE: services/orders-service/Dockerfile
FROM node:20-slim
WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl

COPY services/orders-service/package.json ./package.json
# Instala devDependencies (para o Prisma CLI) e depois remove
RUN npm install
RUN npm prune --production

# Adiciona passos do Prisma
COPY services/orders-service/prisma ./prisma
RUN npx prisma generate

# Copia o arquivo da API (Será criado no Passo 5)
COPY services/orders-service/openapi.yaml ./openapi.yaml

COPY services/orders-service/src ./src
COPY common ./common

ENV PORT=3002
EXPOSE 3002
# Executa o push do DB antes de iniciar
CMD ["/bin/sh", "-c", "npx prisma db push --accept-data-loss && npm start"]