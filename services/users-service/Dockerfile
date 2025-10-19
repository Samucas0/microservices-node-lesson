FROM node:20-alpine
WORKDIR /app

COPY services/users-service/package.json ./package.json
RUN npm install --only=production

# Adiciona passos do Prisma
COPY services/users-service/prisma ./prisma
RUN npx prisma generate

COPY services/users-service/src ./src

COPY common ./common

ENV PORT=3001
EXPOSE 3001
# Altera o CMD para rodar migrações antes de iniciar
# (db push é mais simples para SQLite em dev/docker)
CMD ["npx", "prisma", "db", "push", "--accept-data-loss", "&&", "npm", "start"]