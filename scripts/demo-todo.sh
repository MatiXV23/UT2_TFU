#!/usr/bin/env bash
# Ejecuta las dos demostraciones en secuencia.
source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"
"$RAIZ/scripts/demo-rendimiento.sh"
printf "\n\n"
nota "Esperando 60 s para que expiren los bloqueos previos de rate limiting..."
sleep 60
"$RAIZ/scripts/demo-seguridad.sh"
