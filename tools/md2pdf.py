#!/usr/bin/env python3
"""
Convierte el documento Markdown de la Parte 1 en un PDF con formato academico.

Pipeline:  Markdown --(python-markdown)--> HTML+CSS --(Chromium)--> PDF
           --(pypdf/reportlab)--> PDF con pie de pagina numerado

Uso:  python3 tools/md2pdf.py entrada.md salida.pdf
"""
import io
import re
import sys
import subprocess
from pathlib import Path
from datetime import date

import markdown

MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
         'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre']

CSS = """
@page { size: A4; margin: 20mm 18mm 20mm 18mm; }
@page :first { margin: 0; }

* { box-sizing: border-box; }

html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

body {
  font-family: "Open Sans", "FreeSans", sans-serif;
  font-size: 9.6pt;
  line-height: 1.55;
  color: #1c2226;
  margin: 0;
  hyphens: auto;
  text-align: justify;
}

/* ---------------------------------------------------------------- portada */
.portada {
  height: 297mm;
  padding: 45mm 24mm 24mm 24mm;
  page-break-after: always;
  position: relative;
  text-align: left;
}
.portada .barra { width: 58mm; height: 4.5pt; background: #1f4e79; margin-bottom: 13mm; }
.portada .materia {
  font-size: 10pt; letter-spacing: .18em; text-transform: uppercase;
  color: #5a6b78; font-weight: 600; margin-bottom: 5mm;
}
.portada h1 {
  font-size: 27pt; line-height: 1.18; font-weight: 800;
  color: #14293c; margin: 0 0 6mm 0; letter-spacing: -0.4pt;
}
.portada .bajada {
  font-size: 12.5pt; color: #3d5666; font-weight: 300;
  line-height: 1.45; margin-bottom: 16mm; max-width: 128mm;
}
.portada .tacticas {
  border-left: 3pt solid #1f4e79; padding: 1mm 0 1mm 6mm;
  margin-bottom: 20mm; font-size: 10pt; color: #2c3e4c;
}
.portada .tacticas b { color: #14293c; }
.portada .ficha { position: absolute; bottom: 30mm; left: 24mm; right: 24mm; }
.portada .ficha table { width: auto; border: 0; font-size: 10pt; }
.portada .ficha td { border: 0; padding: 1.4mm 14mm 1.4mm 0; vertical-align: top; }
.portada .ficha td.et {
  color: #7d8b96; font-size: 8.4pt; letter-spacing: .1em;
  text-transform: uppercase; font-weight: 600; white-space: nowrap;
}
.portada .ficha td.va { color: #14293c; font-weight: 600; }
.portada .ficha tbody tr:nth-child(even) td { background: none; }

/* -------------------------------------------------------------------- toc */
.toc { page-break-after: always; }
.toc h2 { border: 0; margin-top: 0; }
.toc ol { list-style: none; padding-left: 0; counter-reset: none; }
.toc li { margin: 2.6mm 0; font-size: 10pt; }
.toc li.n2 { font-weight: 600; color: #14293c; }
.toc li.n3 { padding-left: 8mm; font-weight: 400; font-size: 9.2pt; color: #3d5666; }

/* --------------------------------------------------------------- titulos */
h2 {
  font-size: 15pt; font-weight: 700; color: #14293c;
  margin: 11mm 0 4mm 0; padding-bottom: 2mm;
  border-bottom: 1.2pt solid #1f4e79;
  page-break-after: avoid; text-align: left; letter-spacing: -0.2pt;
}
h3 {
  font-size: 11.6pt; font-weight: 700; color: #1f4e79;
  margin: 7mm 0 2.5mm 0; page-break-after: avoid; text-align: left;
}
h4 {
  font-size: 10pt; font-weight: 700; color: #2c3e4c;
  margin: 5mm 0 2mm 0; page-break-after: avoid; text-align: left;
}
p { margin: 0 0 2.8mm 0; orphans: 3; widows: 3; }
strong { color: #14293c; font-weight: 700; }

/* --------------------------------------------------------------- tablas */
table {
  width: 100%; border-collapse: collapse; margin: 3.5mm 0 5mm 0;
  font-size: 8.5pt; line-height: 1.42; page-break-inside: avoid;
  text-align: left;
}
th {
  background: #1f4e79; color: #fff; font-weight: 600;
  text-align: left; padding: 2mm 2.6mm; border: 0.5pt solid #1f4e79;
  font-size: 8.3pt; letter-spacing: .02em;
}
td {
  padding: 1.9mm 2.6mm; border: 0.5pt solid #c8d4dd;
  vertical-align: top; text-align: left;
}
tbody tr:nth-child(even) td { background: #f4f7f9; }
td strong { color: #14293c; }

/* Tablas de escenario (2 columnas): etiqueta angosta a la izquierda */
table.escenario td:first-child { width: 30mm; background: #eef3f7; }
table.escenario tbody tr:nth-child(even) td:first-child { background: #e7eef4; }

/* --------------------------------------------------------------- codigo */
pre {
  background: #f6f8fa; border: 0.5pt solid #d6dee5; border-left: 2.5pt solid #1f4e79;
  padding: 3mm 4mm; margin: 3.5mm 0 4.5mm 0; border-radius: 1.5pt;
  font-family: "FreeMono", monospace; font-size: 7.6pt; line-height: 1.42;
  color: #22303a; overflow: hidden; page-break-inside: avoid; text-align: left;
}
code {
  font-family: "FreeMono", monospace; font-size: 8.4pt;
  background: #eef2f5; padding: 0.3mm 1mm; border-radius: 1.5pt; color: #1f4e79;
}
pre code { background: none; padding: 0; font-size: inherit; color: inherit; }
td code, th code { font-size: 7.6pt; }

/* ----------------------------------------------------------- citas/listas */
blockquote {
  border-left: 2.5pt solid #b9c9d6; background: #f7fafc;
  margin: 3.5mm 0; padding: 2.5mm 4mm; color: #3d5666;
  font-size: 9pt; page-break-inside: avoid;
}
blockquote p:last-child { margin-bottom: 0; }
ul, ol { margin: 0 0 3mm 0; padding-left: 6mm; }
li { margin-bottom: 1.4mm; }
hr { border: 0; border-top: 0.5pt solid #d6dee5; margin: 7mm 0; }
a { color: #1f4e79; text-decoration: none; }
"""


def construir_portada(front_matter, hoy):
    """Arma la portada a partir del encabezado del Markdown."""
    titulo = re.search(r'^#\s+(.+)$', front_matter, re.M).group(1)
    campos = dict(re.findall(r'\*\*(.+?):\*\*\s*(.+)', front_matter))
    autor = campos.get('Autor', '')

    materia, _, tema = titulo.partition(':')
    filas = ''.join(
        f'<tr><td class="et">{et}</td><td class="va">{va}</td></tr>'
        for et, va in [
            ('Autor', autor),
            ('Entrega', 'Parte 1 &mdash; Requerimientos y tácticas'),
            ('Fecha', f'{hoy.day} de {MESES[hoy.month - 1]} de {hoy.year}'),
        ] if va
    )
    return f"""
<div class="portada">
  <div class="barra"></div>
  <div class="materia">{materia.strip()}</div>
  <h1>{tema.strip()}</h1>
  <div class="bajada">Requerimientos no-funcionales y justificación de las
     tácticas de arquitectura seleccionadas, con su implementación verificable
     en una API REST desplegada en Docker.</div>
  <div class="tacticas">
     <b>Rendimiento</b> &middot; Mantener múltiples copias de cómputo<br>
     <b>Seguridad</b> &middot; Autenticar actores<br>
     <b>Seguridad</b> &middot; Limitar el acceso
  </div>
  <div class="ficha"><table><tbody>{filas}</tbody></table></div>
</div>"""


def construir_toc(cuerpo_html):
    """Indice a partir de los h2/h3, numerando y enlazando cada seccion."""
    entradas = re.findall(r'<h([23]) id="([^"]+)">(.*?)</h[23]>', cuerpo_html, re.S)
    items = []
    for nivel, ancla, texto in entradas:
        limpio = re.sub(r'<[^>]+>', '', texto).strip()
        items.append(f'<li class="n{nivel}"><a href="#{ancla}">{limpio}</a></li>')
    return '<div class="toc"><h2>Contenido</h2><ol>' + ''.join(items) + '</ol></div>'


def marcar_escenarios(html):
    """Marca las tablas de 2 columnas (escenarios de atributo de calidad)."""
    def reemplazo(m):
        tabla = m.group(0)
        primera = re.search(r'<tr>.*?</tr>', tabla, re.S)
        columnas = len(re.findall(r'<t[hd][ >]', primera.group(0))) if primera else 0
        return tabla.replace('<table>', '<table class="escenario">', 1) if columnas == 2 else tabla
    return re.sub(r'<table>.*?</table>', reemplazo, html, flags=re.S)


def numerar_paginas(pdf_bytes, pie):
    """Estampa 'pie' y 'X / N' al pie de cada pagina, salvo la portada."""
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.colors import HexColor

    lector = PdfReader(io.BytesIO(pdf_bytes))
    total = len(lector.pages)
    escritor = PdfWriter()

    for i, pagina in enumerate(lector.pages):
        if i > 0:
            buf = io.BytesIO()
            c = canvas.Canvas(buf, pagesize=A4)
            ancho, _ = A4
            c.setStrokeColor(HexColor('#d6dee5'))
            c.setLineWidth(0.4)
            c.line(51, 40, ancho - 51, 40)
            c.setFont('Helvetica', 7.5)
            c.setFillColor(HexColor('#7d8b96'))
            c.drawString(51, 30, pie)
            c.drawRightString(ancho - 51, 30, f'{i + 1} / {total}')
            c.save()
            buf.seek(0)
            pagina.merge_page(PdfReader(buf).pages[0])
        escritor.add_page(pagina)

    escritor.add_metadata({
        '/Title': 'TFU UT2 - Tacticas de Arquitectura (Parte 1)',
        '/Author': 'Matias Perez',
        '/Subject': 'Requerimientos no-funcionales y justificacion de las '
                    'tacticas de arquitectura seleccionadas',
        '/Keywords': 'arquitectura de software; tacticas; rendimiento; seguridad; '
                     'multiples copias de computo; autenticar actores; limitar el acceso',
        '/Creator': 'md2pdf.py (Chromium + pypdf)',
    })

    salida = io.BytesIO()
    escritor.write(salida)
    return salida.getvalue()


def main():
    entrada = Path(sys.argv[1]).resolve()
    salida = Path(sys.argv[2]).resolve()
    hoy = date.today()

    texto = entrada.read_text(encoding='utf-8')
    front_matter, _, cuerpo_md = texto.partition('\n---\n')

    cuerpo_html = markdown.markdown(
        cuerpo_md, extensions=['tables', 'fenced_code', 'attr_list', 'toc'],
        extension_configs={'toc': {'anchorlink': False}},
    )
    cuerpo_html = marcar_escenarios(cuerpo_html)

    html = (f'<!doctype html><html lang="es"><head><meta charset="utf-8">'
            f'<title>{entrada.stem}</title><style>{CSS}</style></head><body>'
            f'{construir_portada(front_matter, hoy)}'
            f'{construir_toc(cuerpo_html)}'
            f'{cuerpo_html}</body></html>')

    trabajo = salida.parent
    tmp_html = trabajo / '.md2pdf.html'
    tmp_pdf = trabajo / '.md2pdf.pdf'
    tmp_html.write_text(html, encoding='utf-8')

    # Chromium corre en Docker: no hace falta instalar nada en el host.
    subprocess.run([
        'docker', 'run', '--rm', '-v', f'{trabajo}:/data', '-w', '/data',
        'zenika/alpine-chrome:latest',
        '--no-sandbox', '--headless', '--disable-gpu',
        '--virtual-time-budget=10000',
        f'--print-to-pdf=/data/{tmp_pdf.name}', '--no-pdf-header-footer',
        f'file:///data/{tmp_html.name}',
    ], check=True, capture_output=True)

    pie = 'TFU UT2 — Tácticas de Arquitectura · Matias Perez'
    salida.write_bytes(numerar_paginas(tmp_pdf.read_bytes(), pie))
    tmp_html.unlink(missing_ok=True)
    tmp_pdf.unlink(missing_ok=True)
    print(f'PDF generado: {salida}')


if __name__ == '__main__':
    main()
