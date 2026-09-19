FROM node:20-alpine

# Utilidad minima para el HEALTHCHECK
RUN apk add --no-cache wget

WORKDIR /app

# El proyecto no tiene dependencias externas: el build no necesita red ni npm install.
COPY package.json ./
COPY src ./src

# "Limitar el acceso" / minimo privilegio: el proceso no corre como root.
USER node

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "src/server.js"]
