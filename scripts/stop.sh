#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"
titulo "Deteniendo el sistema"
docker compose down --remove-orphans
ok "Contenedores y redes eliminados."
