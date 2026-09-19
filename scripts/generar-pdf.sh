#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Regenera el PDF de la Parte 1 a partir del Markdown fuente.
#
#   Markdown --(python-markdown)--> HTML --(Chromium en Docker)--> PDF
#            --(pypdf)--> PDF con pie de pagina numerado y metadatos
#
# Requiere python3 y Docker. Las dependencias de Python se instalan en un
# entorno virtual local (.venv-pdf), no en el sistema.
# -----------------------------------------------------------------------------
source "$(dirname "${BASH_SOURCE[0]}")/comun.sh"

ENTRADA="$RAIZ/docs/Parte1-Requerimientos-y-Tacticas.md"
SALIDA="$RAIZ/docs/Parte1-Requerimientos-y-Tacticas.pdf"
VENV="$RAIZ/.venv-pdf"

titulo "Generando el PDF de la Parte 1"

command -v python3 >/dev/null || { falla "python3 no esta instalado"; exit 1; }
docker info >/dev/null 2>&1 || { falla "El demonio de Docker no esta corriendo"; exit 1; }

if [ ! -x "$VENV/bin/python" ]; then
  paso "Creando el entorno virtual e instalando dependencias"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet markdown pypdf reportlab
fi

paso "Convirtiendo $(basename "$ENTRADA")"
"$VENV/bin/python" "$RAIZ/tools/md2pdf.py" "$ENTRADA" "$SALIDA"

ok "$(basename "$SALIDA")  ($(du -h "$SALIDA" | cut -f1))"
