# Interfaz grafica de pruebas. Contenido estatico servido por nginx.
# No forma parte de la API: es un subproyecto independiente que se publica
# detras del mismo gateway, por lo que no necesita CORS ni un puerto propio.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
