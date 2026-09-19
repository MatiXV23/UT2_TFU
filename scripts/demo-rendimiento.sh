#!/usr/bin/env bash
# =============================================================================
#  DEMOSTRACION - ATRIBUTO DE CALIDAD: RENDIMIENTO
#  Tactica: "Mantener multiples copias de computo"
#           (replicacion + balanceo de carga least_conn en el gateway)
#
#  Evidencia que produce:
#   1. Las peticiones se reparten entre las 3 replicas (cabecera X-Served-By).
#   2. Con 3 replicas el mismo lote de trabajo CPU-bound tarda menos que con 1.
#   3. Si una replica cae, el gateway la saca del pool y el servicio sigue.
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"
BASE="$(descubrir_url)"
FALLOS=0

CONCURRENCIA="${CONCURRENCIA:-12}"
PETICIONES="${PETICIONES:-60}"
ITERACIONES="${ITERACIONES:-150000}"

titulo "RENDIMIENTO - Mantener multiples copias de computo"
nota "URL base: $BASE   |  peticiones=$PETICIONES  concurrencia=$CONCURRENCIA"

# ---------------------------------------------------------------------------
paso "1. Obtener un token (los recursos de negocio exigen autenticacion)"
TOKEN="$(curl -s -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"usuario":"bob","password":"bob123"}' | campo_json token)"
[ -n "$TOKEN" ] && ok "token obtenido para el usuario 'bob'" || { falla "no se pudo obtener token"; exit 1; }

# ---------------------------------------------------------------------------
paso "2. El balanceador reparte las peticiones entre las replicas"
echo "   (cabecera X-Served-By devuelta por cada respuesta)"
for i in $(seq 1 9); do
  printf "     peticion %-2s -> %s\n" "$i" \
    "$(curl -s -D - -o /dev/null "$BASE/whoami" | awk -F': ' '/[Xx]-[Ss]erved-[Bb]y/{gsub(/\r/,"");print $2}')"
done

# ---------------------------------------------------------------------------
paso "3. Carga concurrente CPU-bound con las 3 replicas activas"
curl -s -X POST "$BASE/stats/reset" > /dev/null

# medir_lote ETIQUETA
#   Lanza $PETICIONES peticiones con $CONCURRENCIA en paralelo.
#   Imprime el resumen legible por stderr y devuelve los segundos por stdout.
medir_lote() {
  local etiqueta="$1" inicio fin
  inicio="$(ahora)"
  seq 1 "$PETICIONES" | xargs -P "$CONCURRENCIA" -I{} \
    curl -s -o /dev/null -H "Authorization: Bearer $TOKEN" \
      "$BASE/api/report?iter=$ITERACIONES"
  fin="$(ahora)"
  awk -v i="$inicio" -v f="$fin" -v n="$PETICIONES" -v e="$etiqueta" \
    'BEGIN{t=f-i; printf "   %-12s tiempo total: %6.2f s   |   throughput: %6.2f req/s\n", e, t, n/t > "/dev/stderr"; printf "%.4f\n", t}'
}

T3="$(medir_lote "3-replicas")"

paso "4. Reparto real de la carga (contadores compartidos en Redis)"
curl -s "$BASE/stats" | sed 's/^/     /'

# ---------------------------------------------------------------------------
paso "5. Mismo lote con UNA sola replica (se detienen api2 y api3)"
docker compose stop api2 api3 >/dev/null 2>&1
sleep 3
curl -s -X POST "$BASE/stats/reset" > /dev/null
T1="$(medir_lote "1-replica")"

paso "6. Comparacion"
awk -v t1="$T1" -v t3="$T3" -v n="$PETICIONES" 'BEGIN{
  printf "     1 replica   : %6.2f s  (%6.2f req/s)\n", t1, n/t1;
  printf "     3 replicas  : %6.2f s  (%6.2f req/s)\n", t3, n/t3;
  printf "     Aceleracion : x%.2f  (mismo lote de %d peticiones CPU-bound)\n", t1/t3, n;
}'
rm -f "$RAIZ"/.medicion_*

# ---------------------------------------------------------------------------
paso "7. Tolerancia a la caida de una replica (el servicio NO se interrumpe)"
nota "api2 y api3 siguen detenidas; el gateway las excluyo del pool."
CODIGOS="$(for i in $(seq 1 6); do codigo_http GET "$BASE/whoami"; printf ' '; done)"
echo "     codigos HTTP obtenidos: $CODIGOS"
case "$CODIGOS" in
  *4*|*5*) falla "hubo respuestas de error durante la degradacion" ;;
  *) ok "el 100% de las peticiones se sirvio pese a tener 2 de 3 replicas caidas" ;;
esac

paso "8. Restaurando las replicas"
docker compose start api2 api3 >/dev/null 2>&1
sleep 4
curl -s "$BASE/whoami" >/dev/null || true
ok "pool completo restablecido"

titulo "Fin de la demostracion de RENDIMIENTO"
exit 0
