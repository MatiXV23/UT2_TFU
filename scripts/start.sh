#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Levanta todo el sistema (gateway + 3 replicas + Redis) en Docker.
# -----------------------------------------------------------------------------
source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

titulo "TFU UT2 - Levantando el sistema"

command -v docker >/dev/null || { falla "Docker no esta instalado"; exit 1; }
docker info >/dev/null 2>&1 || { falla "El demonio de Docker no esta corriendo"; exit 1; }

# --- Eleccion de puerto: 8080 por defecto, o el primero libre a partir de ahi.
puerto_libre() {
  local p="$1"
  for _ in $(seq 1 20); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "$p"; return; fi
    exec 3<&- 2>/dev/null || true
    p=$((p + 1))
  done
  echo "$1"
}

if [ -z "${PUERTO_HOST:-}" ]; then
  PUERTO_HOST="$(puerto_libre 8080)"
fi
printf 'PUERTO_HOST=%s\n' "$PUERTO_HOST" > .env
[ "$PUERTO_HOST" != "8080" ] && nota "El puerto 8080 estaba ocupado; se usara el $PUERTO_HOST."

paso "Construyendo las imagenes (la de la API se comparte entre las 3 replicas)"
docker compose build api1 ui

paso "Iniciando servicios"
docker compose up -d --wait

BASE="http://localhost:${PUERTO_HOST}"

paso "Verificando el gateway"
for i in $(seq 1 30); do
  if [ "$(codigo_http GET "$BASE/nginx-health")" = "200" ]; then break; fi
  sleep 1
done

titulo "Sistema operativo"
docker compose ps --format 'table {{.Name}}\t{{.Service}}\t{{.Status}}\t{{.Ports}}'

printf "\n${NEG}Interfaz grafica de pruebas:${FIN}  %s\n" "$BASE"
printf "${NEG}API (mismo origen):${FIN}           %s/api/...\n" "$BASE"
cat <<AYUDA

Abri la consola en el navegador para probar todo sin Postman:
  $BASE

Prueba rapida por linea de comandos:
  curl -s ${BASE}/whoami
  curl -s -X POST ${BASE}/auth/login -H 'Content-Type: application/json' \\
       -d '{"usuario":"alice","password":"alice123"}'

Demostraciones:
  ./scripts/demo-rendimiento.sh   (multiples copias de computo)
  ./scripts/demo-seguridad.sh     (autenticar actores + limitar el acceso)
  ./scripts/demo-todo.sh          (ambas, en secuencia)

Para detener todo:
  ./scripts/stop.sh
AYUDA
