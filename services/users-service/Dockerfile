FROM node:20-slim
WORKDIR /app

RUN apt-get update -y && apt-get install -y openssl

COPY services/users-service/package.json ./package.json
RUN npm install --only=production

# Adiciona passos do Prisma
COPY services/users-service/prisma ./prisma
RUN npx prisma generate

# Copia o arquivo da API
COPY services/users-service/openapi.yaml ./openapi.yaml

COPY services/users-service/src ./src

COPY common ./common

ENV PORT=3001
EXPOSE 3001
CMD ["/bin/sh", "-c", "npx prisma db push --accept-data-loss && npm start"]