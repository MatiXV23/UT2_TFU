#!/usr/bin/env bash
# Funciones y variables compartidas por los scripts de demostracion.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

# Colores (se desactivan si la salida no es una terminal)
if [ -t 1 ]; then
  ROJO='\033[0;31m'; VERDE='\033[0;32m'; AMAR='\033[0;33m'
  AZUL='\033[0;34m'; CIAN='\033[0;36m'; NEG='\033[1m'; FIN='\033[0m'
else
  ROJO=''; VERDE=''; AMAR=''; AZUL=''; CIAN=''; NEG=''; FIN=''
fi

titulo()  { printf "\n${NEG}${AZUL}==============================================================${FIN}\n${NEG}${AZUL} %s${FIN}\n${NEG}${AZUL}==============================================================${FIN}\n" "$1"; }
paso()    { printf "\n${NEG}${CIAN}-> %s${FIN}\n" "$1"; }
ok()      { printf "   ${VERDE}[OK]${FIN} %s\n" "$1"; }
falla()   { printf "   ${ROJO}[X ]${FIN} %s\n" "$1"; }
nota()    { printf "   ${AMAR}%s${FIN}\n" "$1"; }

# Descubre la URL base a partir del puerto realmente publicado por Docker.
descubrir_url() {
  if [ -n "${BASE_URL:-}" ]; then echo "$BASE_URL"; return; fi
  local mapeo
  mapeo="$(docker compose port gateway 80 2>/dev/null || true)"
  if [ -z "$mapeo" ]; then
    echo "ERROR: el stack no esta levantado. Ejecuta ./scripts/start.sh" >&2
    exit 1
  fi
  echo "http://localhost:${mapeo##*:}"
}

# codigo_http METODO URL [args curl...] -> imprime siempre 3 digitos
# (000 significa "sin respuesta": el destino no es alcanzable)
codigo_http() {
  local metodo="$1" url="$2"; shift 2
  local c
  c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X "$metodo" "$url" "$@" 2>/dev/null)" || c=""
  [ -z "$c" ] && c="000"
  printf '%s' "$c"
}

# Marca de tiempo con decimales, portable entre macOS y Linux.
ahora() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time;print(time.time())'
  elif command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%.3f", time'
  else
    date +%s
  fi
}

# Extrae un campo string de un JSON sin depender de jq.
campo_json() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
}

# Verifica que el codigo obtenido sea el esperado.
esperar() {
  local esperado="$1" obtenido="$2" descripcion="$3"
  if [ "$obtenido" = "$esperado" ]; then
    ok "$descripcion  (HTTP $obtenido)"
  else
    falla "$descripcion  (esperado HTTP $esperado, obtenido HTTP $obtenido)"
    FALLOS=$((${FALLOS:-0} + 1))
  fi
}
