#!/usr/bin/env bash
# =============================================================================
#  DEMOSTRACION - ATRIBUTO DE CALIDAD: SEGURIDAD (categoria "resistir ataques")
#  Tactica A: "Autenticar actores"  -> scrypt + JWT HS256 firmado y con expiracion
#  Tactica B: "Limitar el acceso"   -> rate limiting, bloqueo de cuenta,
#                                      superficie de red minima, control por rol
# =============================================================================
source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"
BASE="$(descubrir_url)"
FALLOS=0

titulo "SEGURIDAD - Autenticar actores + Limitar el acceso"
nota "URL base: $BASE"

# ===========================================================================
titulo "TACTICA A - AUTENTICAR ACTORES"
# ===========================================================================

paso "A.1 Un recurso protegido rechaza peticiones sin credenciales"
esperar 401 "$(codigo_http GET "$BASE/api/products")" "GET /api/products sin token"
curl -s "$BASE/api/products" | sed 's/^/     /'

paso "A.2 Credenciales invalidas no otorgan token"
esperar 401 "$(codigo_http POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"usuario":"alice","password":"password-incorrecta"}')" "login con clave incorrecta"

paso "A.3 Credenciales validas -> se emite un JWT firmado con expiracion"
RESP="$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"usuario":"alice","password":"alice123"}')"
TOKEN_ADMIN="$(echo "$RESP" | campo_json token)"
echo "$RESP" | sed 's/^/     /'
[ -n "$TOKEN_ADMIN" ] && ok "token emitido" || { falla "no se emitio token"; exit 1; }

paso "A.4 Con el token, el recurso protegido responde 200"
esperar 200 "$(codigo_http GET "$BASE/api/products" -H "Authorization: Bearer $TOKEN_ADMIN")" \
  "GET /api/products con token valido"

paso "A.5 Un token MANIPULADO es rechazado (verificacion de firma HMAC)"
TOKEN_FALSO="${TOKEN_ADMIN%??}XX"
esperar 401 "$(codigo_http GET "$BASE/api/products" -H "Authorization: Bearer $TOKEN_FALSO")" \
  "GET con token alterado"
curl -s "$BASE/api/products" -H "Authorization: Bearer $TOKEN_FALSO" | sed 's/^/     /'

paso "A.6 Un token inventado (firmado con otra clave) tambien es rechazado"
esperar 401 "$(codigo_http GET "$BASE/api/products" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJoYWNrZXIiLCJyb2wiOiJhZG1pbiJ9.firmafalsa")" \
  "GET con token de un emisor no confiable"

# ===========================================================================
titulo "TACTICA B - LIMITAR EL ACCESO"
# ===========================================================================

paso "B.1 Autorizacion por rol: 'bob' (rol user) no puede crear productos"
TOKEN_USER="$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"usuario":"bob","password":"bob123"}' | campo_json token)"
esperar 403 "$(codigo_http POST "$BASE/api/products" \
  -H "Authorization: Bearer $TOKEN_USER" -H 'Content-Type: application/json' \
  -d '{"nombre":"Producto pirata","precio":1}')" "POST /api/products como rol 'user'"
curl -s -X POST "$BASE/api/products" -H "Authorization: Bearer $TOKEN_USER" \
  -H 'Content-Type: application/json' -d '{"nombre":"Producto pirata","precio":1}' | sed 's/^/     /'

paso "B.2 El mismo recurso SI esta permitido para el rol 'admin'"
esperar 201 "$(codigo_http POST "$BASE/api/products" \
  -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' \
  -d '{"nombre":"Webcam 4K","precio":150,"stock":7}')" "POST /api/products como rol 'admin'"

paso "B.3 Bloqueo de cuenta tras intentos fallidos (control en la APLICACION)"
VICTIMA="carlos-$$"
echo "     7 intentos con clave incorrecta contra el usuario '$VICTIMA'"
echo "     (umbral configurado: 5 fallos en 60 s)"
for i in $(seq 1 7); do
  CUERPO="$(curl -s -w '\n%{http_code}' -X POST "$BASE/auth/login" \
      -H 'Content-Type: application/json' \
      -d "{\"usuario\":\"$VICTIMA\",\"password\":\"intento$i\"}")"
  COD="$(echo "$CUERPO" | tail -1)"
  RESTANTES="$(echo "$CUERPO" | sed -n 's/.*"intentos_restantes"[^0-9]*\([0-9]*\).*/\1/p')"
  MOTIVO="$(echo "$CUERPO" | campo_json error)"
  printf "       intento %s -> HTTP %-3s  %s%s\n" "$i" "$COD" "$MOTIVO" \
    "$([ -n "$RESTANTES" ] && echo " (quedan $RESTANTES)")"
done
ULT="$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
        -d "{\"usuario\":\"$VICTIMA\",\"password\":\"x\"}")"
echo "$ULT" | sed 's/^/     /'
if echo "$ULT" | grep -q 'bloqueada'; then
  ok "la cuenta quedo bloqueada por la aplicacion; ya no se evalua la contrasena"
else
  falla "no se activo el bloqueo de cuenta"
  FALLOS=$((FALLOS + 1))
fi

paso "B.4 Limitacion de tasa en el GATEWAY sobre /auth/login (60 req/min por IP)"
echo "     50 logins VALIDOS y seguidos de 'bob' (no disparan el bloqueo de cuenta,"
echo "     asi que todo 429 que aparezca proviene del borde, no de la aplicacion)"
APP=0; BORDE=0; OK200=0
for i in $(seq 1 50); do
  SALIDA="$(curl -s -D - -o /dev/null -X POST "$BASE/auth/login" \
      -H 'Content-Type: application/json' \
      -d '{"usuario":"bob","password":"bob123"}')"
  COD="$(echo "$SALIDA" | awk 'NR==1{print $2}')"
  # Solo las respuestas generadas por una replica llevan X-Served-By.
  if echo "$SALIDA" | grep -qi '^x-served-by'; then ORIGEN=app; else ORIGEN=gateway; fi
  case "$COD:$ORIGEN" in
    200:*)       OK200=$((OK200 + 1)) ;;
    429:gateway) BORDE=$((BORDE + 1)) ;;
    429:app)     APP=$((APP + 1)) ;;
  esac
done
printf "       200 (atendidas por una replica) : %s\n" "$OK200"
printf "       429 cortadas por el GATEWAY     : %s\n" "$BORDE"
printf "       429 generadas por la APLICACION : %s\n" "$APP"
curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"usuario":"bob","password":"bob123"}' | sed 's/^/     /'; echo
if [ "$BORDE" -gt 0 ]; then
  ok "el gateway absorbio $BORDE peticiones antes de que llegaran a las replicas"
else
  falla "no se observo limitacion de tasa en el gateway"
  FALLOS=$((FALLOS + 1))
fi

paso "B.5 Superficie de red minima: las replicas y Redis NO son alcanzables"
nota "Puertos publicados por el stack (solo el gateway debe aparecer):"
docker compose ps --format 'table {{.Name}}\t{{.Ports}}' | sed 's/^/     /'
if docker compose ps --format '{{.Name}} {{.Ports}}' | grep -qE 'ut2-(api|redis).*0\.0\.0\.0'; then
  falla "hay componentes internos publicados al host"
  FALLOS=$((FALLOS + 1))
else
  ok "ni las replicas ni Redis publican puertos: solo se entra por el gateway"
fi
nota "Comprobacion directa contra los puertos internos desde el host:"
for pr in 3000 6379; do
  printf "       http://localhost:%s -> %s   (000 = sin respuesta: inalcanzable)\n" \
    "$pr" "$(codigo_http GET "http://localhost:$pr/whoami")"
done

paso "B.6 Metodos HTTP no previstos son rechazados en el borde"
esperar 405 "$(codigo_http DELETE "$BASE/api/products" -H "Authorization: Bearer $TOKEN_ADMIN")" \
  "DELETE bloqueado por el gateway"

paso "B.7 El gateway no revela su version (menos informacion para el atacante)"
curl -s -D - -o /dev/null "$BASE/nginx-health" | grep -i '^server' | sed 's/^/     /'

# ===========================================================================
titulo "RESUMEN"
if [ "$FALLOS" -eq 0 ]; then
  ok "Todas las comprobaciones de seguridad se cumplieron."
else
  falla "$FALLOS comprobacion(es) no se cumplieron."
fi
nota "El bloqueo de 'carlos' y el rate limit se liberan solos en ~60 s."
exit "$FALLOS"
