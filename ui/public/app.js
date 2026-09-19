'use strict';
/* =============================================================================
 *  Consola de pruebas - TFU UT2
 *
 *  Reemplaza a Postman para ejercitar la API y observar las tres tacticas:
 *   - Mantener multiples copias de computo  (que replica respondio, reparto,
 *     comparacion de throughput)
 *   - Autenticar actores                    (login, JWT, token adulterado)
 *   - Limitar el acceso                     (rol, bloqueo de cuenta, rate limit)
 *
 *  Se sirve desde el mismo gateway que la API, por lo que todas las llamadas
 *  son del mismo origen: no hace falta CORS y las cabeceras de respuesta
 *  (X-Served-By) son legibles desde JavaScript.
 * ========================================================================== */

const estado = {
  token: localStorage.getItem('tfu_token') || null,
  usuario: localStorage.getItem('tfu_usuario') || null,
  rol: localStorage.getItem('tfu_rol') || null,
  registro: [],
};

/* ------------------------------------------------------------------ utiles */
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const claseCodigo = (c) => `c${Math.floor(c / 100) || 0}xx`;

function decodificarJWT(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(p))));
  } catch { return null; }
}

/* ----------------------------------------------------------------- red ---- */
/**
 * Envia una peticion y registra el resultado.
 * Devuelve { codigo, cuerpo, texto, servidaPor, origen, ms }.
 *   origen = 'app'      -> la respuesta la genero una replica (trae X-Served-By)
 *   origen = 'gateway'  -> la corto el borde (rate limit, verbo no permitido)
 */
async function pedir(metodo, ruta, opciones = {}) {
  const { cuerpo = null, token = estado.token, sinToken = false, silencioso = false } = opciones;
  const cabeceras = {};
  if (cuerpo !== null) cabeceras['Content-Type'] = 'application/json';
  if (token && !sinToken) cabeceras['Authorization'] = `Bearer ${token}`;

  const t0 = performance.now();
  let resp, texto = '', codigo = 0;
  try {
    resp = await fetch(ruta, {
      method: metodo,
      headers: cabeceras,
      body: cuerpo === null ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    });
    codigo = resp.status;
    texto = await resp.text();
  } catch (e) {
    texto = `error de red: ${e.message}`;
  }
  const ms = Math.round(performance.now() - t0);

  const servidaPor = resp ? resp.headers.get('X-Served-By') : null;
  const origen = servidaPor ? 'app' : (resp ? 'gateway' : 'red');

  let datos = null;
  try { datos = JSON.parse(texto); } catch { /* la respuesta no siempre es JSON */ }

  const r = { codigo, cuerpo: datos, texto, servidaPor, origen, ms, metodo, ruta };
  if (!silencioso) anotar(r);
  return r;
}

/* -------------------------------------------------------------- registro -- */
function anotar(r) {
  estado.registro.unshift(r);
  if (estado.registro.length > 300) estado.registro.pop();
  pintarRegistro();
}

function pintarRegistro() {
  $('#log-n').textContent = estado.registro.length;
  $('#registro').innerHTML = estado.registro.map((r, i) => `
    <div class="log" data-i="${i}">
      <div class="l1">
        <span class="chip ${claseCodigo(r.codigo)}">${r.codigo || 'ERR'}</span>
        <span class="met">${r.metodo}</span>
        <span class="ruta">${esc(r.ruta)}</span>
        <span class="ms">${r.ms} ms</span>
      </div>
      <div class="l2">
        <span class="origen-${r.origen === 'app' ? 'app' : 'gw'}">
          ${r.origen === 'app' ? `replica ${r.servidaPor}` : r.origen === 'gateway' ? 'cortada por el gateway' : 'sin respuesta'}
        </span>
      </div>
      ${r.abierto ? `<pre>${esc(r.texto || '(sin cuerpo)')}</pre>` : ''}
    </div>`).join('');
}

document.addEventListener('click', (e) => {
  const fila = e.target.closest('.log');
  if (!fila) return;
  const r = estado.registro[Number(fila.dataset.i)];
  r.abierto = !r.abierto;
  pintarRegistro();
});

/* --------------------------------------------------------------- sesion --- */
function guardarSesion(token, usuario, rol) {
  estado.token = token; estado.usuario = usuario; estado.rol = rol;
  if (token) {
    localStorage.setItem('tfu_token', token);
    localStorage.setItem('tfu_usuario', usuario);
    localStorage.setItem('tfu_rol', rol);
  } else {
    ['tfu_token', 'tfu_usuario', 'tfu_rol'].forEach((k) => localStorage.removeItem(k));
  }
  pintarEstadoSesion();
}

function pintarEstadoSesion() {
  const claims = estado.token ? decodificarJWT(estado.token) : null;
  const vigente = claims && claims.exp * 1000 > Date.now();
  $('#pt-sesion').className = 'punto' + (vigente ? ' vivo' : estado.token ? ' muerto' : '');
  $('#txt-sesion').textContent = !estado.token ? 'sin sesión'
    : vigente ? `${claims.sub} (${claims.rol})` : 'token vencido';
}

/* ---------------------------------------------------------- lote paralelo - */
/** Ejecuta n tareas con un maximo de `conc` en vuelo simultaneamente. */
async function correrLote(n, conc, tarea, alAvanzar) {
  const resultados = [];
  let siguiente = 0, terminadas = 0;
  async function trabajador() {
    while (siguiente < n) {
      const i = siguiente++;
      resultados[i] = await tarea(i);
      if (alAvanzar) alAvanzar(++terminadas, n);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, n) }, trabajador));
  return resultados;
}

/* ================================ VISTAS ================================== */
const vistas = {};

/* -------------------------------------------------------------- 1. sesion  */
vistas.sesion = () => {
  const claims = estado.token ? decodificarJWT(estado.token) : null;
  const vigente = claims && claims.exp * 1000 > Date.now();

  $('#vista').innerHTML = `
    <div class="tarjeta">
      <h2>Autenticación <span class="etiqueta-tactica seg">Autenticar actores</span></h2>
      <p class="desc">La contraseña se verifica contra un hash scrypt y, si es correcta,
         el servidor emite un JWT HS256 firmado con expiración. Ese token es lo único
         que viaja después: cualquier réplica puede validarlo sin consultar a nadie.</p>

      <div class="rejilla" style="grid-template-columns:1fr 1fr;max-width:520px">
        <div><label>Usuario</label><input id="in-usuario" value="alice" autocomplete="off"></div>
        <div><label>Contraseña</label><input id="in-password" type="password" value="alice123"></div>
      </div>
      <div class="fila" style="margin-top:14px">
        <button class="b" id="btn-login">Iniciar sesión</button>
        <button class="b sec" id="btn-alice">alice / admin</button>
        <button class="b sec" id="btn-bob">bob / user</button>
        <button class="b sec" id="btn-mal">contraseña incorrecta</button>
        ${estado.token ? '<button class="b peligro" id="btn-salir">Cerrar sesión</button>' : ''}
      </div>
      <pre class="salida" id="out-login">${estado.ultimoLogin
        ? `<span class="chip ${claseCodigo(estado.ultimoLogin.codigo)}">${estado.ultimoLogin.codigo}</span>  ${esc(estado.ultimoLogin.texto)}`
        : '<span class="vacio">Sin peticiones todavía.</span>'}</pre>
    </div>

    <div class="tarjeta">
      <h2>Token actual</h2>
      <p class="desc">Contenido del JWT tal como lo lee el servidor en cada petición protegida.</p>
      ${claims ? `
        <table class="datos">
          <tr><th>Sujeto</th><td><code>${esc(claims.sub)}</code></td></tr>
          <tr><th>Rol</th><td><code>${esc(claims.rol)}</code></td></tr>
          <tr><th>Emisor</th><td><code>${esc(claims.iss)}</code></td></tr>
          <tr><th>Emitido</th><td>${new Date(claims.iat * 1000).toLocaleString('es-UY')}</td></tr>
          <tr><th>Expira</th><td>${new Date(claims.exp * 1000).toLocaleString('es-UY')}
              &nbsp;<span class="chip ${vigente ? 'c2xx' : 'c4xx'}" id="cuenta-atras"></span></td></tr>
        </table>
        <pre class="salida">${esc(estado.token)}</pre>`
      : '<p class="vacio">No hay ninguna sesión iniciada.</p>'}
    </div>`;

  const entrar = async (usuario, password) => {
    const r = await pedir('POST', '/auth/login', { cuerpo: { usuario, password }, sinToken: true });
    estado.ultimoLogin = r;
    $('#out-login').innerHTML =
      `<span class="chip ${claseCodigo(r.codigo)}">${r.codigo}</span>  ${esc(r.texto)}`;
    if (r.codigo === 200 && r.cuerpo?.token) {
      guardarSesion(r.cuerpo.token, usuario, r.cuerpo.rol);
      setTimeout(() => vistas.sesion(), 550);
    }
  };

  $('#btn-login').onclick = () => entrar($('#in-usuario').value, $('#in-password').value);
  $('#btn-alice').onclick = () => entrar('alice', 'alice123');
  $('#btn-bob').onclick = () => entrar('bob', 'bob123');
  $('#btn-mal').onclick = () => entrar('alice', 'clave-equivocada');
  if ($('#btn-salir')) $('#btn-salir').onclick = () => { guardarSesion(null); vistas.sesion(); };

  if (claims) {
    const tic = () => {
      const el = $('#cuenta-atras');
      if (!el) return clearInterval(id);
      const s = Math.max(0, Math.round(claims.exp - Date.now() / 1000));
      el.textContent = s > 0 ? `vence en ${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : 'vencido';
    };
    const id = setInterval(tic, 1000); tic();
  }
};

/* ------------------------------------------------------------ 2. recursos  */
vistas.recursos = () => {
  $('#vista').innerHTML = `
    <div class="tarjeta">
      <h2>Recursos protegidos <span class="etiqueta-tactica seg">Autenticar actores</span></h2>
      <p class="desc">Todo lo que cuelga de <code>/api/</code> exige un token válido.
         El servidor rechaza la petición antes de ejecutar lógica de negocio.</p>
      <div class="fila">
        <button class="b" id="btn-listar">GET /api/products</button>
        <button class="b sec" id="btn-listar-sin">GET sin token</button>
      </div>
      <div id="tabla-productos"></div>
      <pre class="salida" id="out-productos"><span class="vacio">Sin peticiones todavía.</span></pre>
    </div>

    <div class="tarjeta">
      <h2>Alta de producto <span class="etiqueta-tactica seg">Limitar el acceso</span></h2>
      <p class="desc">La escritura está reservada al rol <code>admin</code>. Con
         <code>bob</code> (rol <code>user</code>) la misma petición responde 403:
         el rol viaja firmado dentro del token, así que no se puede alterar.</p>
      <div class="rejilla" style="grid-template-columns:2fr 1fr 1fr;max-width:560px">
        <div><label>Nombre</label><input id="in-nombre" value="Webcam 4K"></div>
        <div><label>Precio</label><input id="in-precio" type="number" value="150"></div>
        <div><label>Stock</label><input id="in-stock" type="number" value="7"></div>
      </div>
      <div class="fila" style="margin-top:14px">
        <button class="b" id="btn-crear">POST /api/products</button>
      </div>
      <pre class="salida" id="out-crear"><span class="vacio">Sin peticiones todavía.</span></pre>
    </div>`;

  const mostrar = (sel, r) => {
    $(sel).innerHTML = `<span class="chip ${claseCodigo(r.codigo)}">${r.codigo}</span>` +
      (r.servidaPor ? `  <span style="color:var(--ok)">${r.servidaPor}</span>` : '  <span style="color:var(--alerta)">gateway</span>') +
      `  ${r.ms} ms\n\n${esc(r.texto)}`;
  };

  const listar = async (sinToken) => {
    const r = await pedir('GET', '/api/products', { sinToken });
    mostrar('#out-productos', r);
    $('#tabla-productos').innerHTML = r.cuerpo?.productos ? `
      <table class="datos">
        <tr><th>Id</th><th>Nombre</th><th>Precio</th><th>Stock</th></tr>
        ${r.cuerpo.productos.map((p) => `<tr><td>${p.id}</td><td>${esc(p.nombre)}</td>
           <td>${p.precio}</td><td>${p.stock}</td></tr>`).join('')}
      </table>` : '';
  };

  $('#btn-listar').onclick = () => listar(false);
  $('#btn-listar-sin').onclick = () => listar(true);
  $('#btn-crear').onclick = async () => {
    const r = await pedir('POST', '/api/products', {
      cuerpo: {
        nombre: $('#in-nombre').value,
        precio: Number($('#in-precio').value),
        stock: Number($('#in-stock').value),
      },
    });
    mostrar('#out-crear', r);
  };
};

/* --------------------------------------------------------- 3. rendimiento  */
vistas.rendimiento = () => {
  $('#vista').innerHTML = `
    <div class="tarjeta">
      <h2>Reparto de carga <span class="etiqueta-tactica">Múltiples copias de cómputo</span></h2>
      <p class="desc">Cada respuesta trae la cabecera <code>X-Served-By</code> con la réplica
         que la atendió. El gateway usa <code>least_conn</code>: manda cada petición a la
         réplica con menos conexiones activas.</p>
      <div class="fila">
        <button class="b" id="btn-sondear">Enviar 12 peticiones a /whoami</button>
        <button class="b sec" id="btn-stats">Ver contadores acumulados</button>
        <button class="b sec" id="btn-reset">Reiniciar contadores</button>
      </div>
      <div id="barras-sondeo" style="margin-top:18px"></div>
    </div>

    <div class="tarjeta">
      <h2>Prueba de carga <span class="etiqueta-tactica">Múltiples copias de cómputo</span></h2>
      <p class="desc"><code>GET /api/report</code> ejecuta un cálculo intensivo en CPU.
         Como el trabajo de cada petición no se puede acelerar, la única forma de bajar el
         tiempo del lote es atender varias en paralelo, en réplicas distintas.</p>

      <div class="aviso">
        <b>Techo del navegador:</b> Chrome y Firefox abren como máximo ~6 conexiones
        simultáneas por origen, así que la concurrencia real se topa ahí. Para medir sin
        ese límite, usá <code>./scripts/demo-rendimiento.sh</code> desde la terminal.
      </div>

      <div class="rejilla" style="grid-template-columns:repeat(3,1fr);max-width:560px">
        <div><label>Peticiones</label><input id="in-n" type="number" value="30" min="1" max="300"></div>
        <div><label>Concurrencia</label><input id="in-c" type="number" value="6" min="1" max="12"></div>
        <div><label>Iteraciones por petición</label><input id="in-i" type="number" value="150000" step="10000"></div>
      </div>
      <div class="fila" style="margin-top:14px">
        <button class="b" id="btn-cargar">Ejecutar lote</button>
        <span id="txt-progreso" style="color:var(--tenue);font-size:12.5px"></span>
      </div>
      <div class="progreso"><div id="barra-progreso"></div></div>

      <div class="rejilla" style="margin-top:18px" id="metricas"></div>
      <div id="barras-carga" style="margin-top:16px"></div>

      <p class="desc" style="margin:18px 0 0">
        Para ver el efecto de perder capacidad: detené dos réplicas con
        <code>docker compose stop api2 api3</code>, volvé a correr el lote y compará.
        Restaurá con <code>docker compose start api2 api3</code>.
      </p>
    </div>`;

  const barras = (destino, conteo, titulo) => {
    const total = Object.values(conteo).reduce((a, b) => a + b, 0);
    const nombres = Object.keys(conteo).sort();
    $(destino).innerHTML = !total ? '' : `
      <label>${titulo}</label>
      ${nombres.map((n) => {
        const pct = (conteo[n] * 100) / total;
        return `<div class="barra-fila">
          <span class="nom">${esc(n)}</span>
          <span class="barra-pista"><span class="barra-val" style="width:${pct}%"></span></span>
          <span class="cnt">${conteo[n]} · ${pct.toFixed(1)}%</span>
        </div>`;
      }).join('')}`;
  };

  $('#btn-sondear').onclick = async () => {
    const conteo = {};
    const rs = await correrLote(12, 4, () => pedir('GET', '/whoami', { silencioso: true }));
    rs.forEach((r) => { const k = r.servidaPor || 'gateway'; conteo[k] = (conteo[k] || 0) + 1; });
    anotar(rs[rs.length - 1]);
    barras('#barras-sondeo', conteo, 'Reparto de 12 peticiones');
  };

  $('#btn-stats').onclick = async () => {
    const r = await pedir('GET', '/stats');
    if (r.cuerpo?.por_instancia) barras('#barras-sondeo', r.cuerpo.por_instancia,
      `Contadores acumulados en Redis (${r.cuerpo.total_requests} peticiones)`);
  };

  $('#btn-reset').onclick = async () => {
    await pedir('POST', '/stats/reset');
    $('#barras-sondeo').innerHTML = '';
  };

  $('#btn-cargar').onclick = async (ev) => {
    if (!estado.token) { alert('Primero iniciá sesión en la pestaña "Sesión".'); return; }
    const n = Number($('#in-n').value), c = Number($('#in-c').value), iter = Number($('#in-i').value);
    ev.target.disabled = true;
    $('#metricas').innerHTML = '';
    await pedir('POST', '/stats/reset', { silencioso: true });

    const t0 = performance.now();
    const rs = await correrLote(n, c,
      () => pedir('GET', `/api/report?iter=${iter}`, { silencioso: true }),
      (hechas) => {
        $('#barra-progreso').style.width = `${(hechas * 100) / n}%`;
        $('#txt-progreso').textContent = `${hechas} / ${n}`;
      });
    const seg = (performance.now() - t0) / 1000;

    const conteo = {}, latencias = [];
    let errores = 0;
    rs.forEach((r) => {
      const k = r.servidaPor || 'gateway';
      conteo[k] = (conteo[k] || 0) + 1;
      if (r.codigo === 200) latencias.push(r.ms); else errores++;
    });
    latencias.sort((a, b) => a - b);
    const p50 = latencias[Math.floor(latencias.length * 0.5)] || 0;
    const p95 = latencias[Math.floor(latencias.length * 0.95)] || 0;
    const replicas = Object.keys(conteo).filter((k) => k !== 'gateway').length;

    $('#metricas').innerHTML = [
      ['Tiempo total', `${seg.toFixed(2)} s`, ''],
      ['Throughput', `${(n / seg).toFixed(1)}`, 'req/s'],
      ['Latencia p50', `${p50}`, 'ms'],
      ['Latencia p95', `${p95}`, 'ms'],
      ['Réplicas usadas', `${replicas}`, ''],
      ['Errores', `${errores}`, ''],
    ].map(([t, v, u]) => `<div class="metrica">
        <div class="n" style="${t === 'Errores' && errores ? 'color:var(--error)' : ''}">${v}<span style="font-size:12px;color:var(--tenue)"> ${u}</span></div>
        <div class="t">${t}</div></div>`).join('');

    barras('#barras-carga', conteo, `Reparto del lote (${n} peticiones, concurrencia ${c})`);
    anotar(rs[rs.length - 1]);
    ev.target.disabled = false;
  };
};

/* ----------------------------------------------------------- 4. seguridad  */
vistas.seguridad = () => {
  $('#vista').innerHTML = `
    <div class="tarjeta">
      <h2>Autenticar actores <span class="etiqueta-tactica seg">Resistir ataques</span></h2>
      <p class="desc">Cada escenario intenta acceder a un recurso protegido con una
         credencial distinta. Solo el token legítimo pasa.</p>
      <div class="fila">
        <button class="b sec" data-esc="sin-token">Sin token</button>
        <button class="b sec" data-esc="adulterado">Token adulterado</button>
        <button class="b sec" data-esc="ajeno">Token de otro emisor</button>
        <button class="b" data-esc="valido">Token válido</button>
      </div>
      <pre class="salida" id="out-auth"><span class="vacio">Elegí un escenario.</span></pre>
    </div>

    <div class="tarjeta">
      <h2>Limitar el acceso <span class="etiqueta-tactica seg">Resistir ataques</span></h2>
      <p class="desc">Dos frenos independientes: la aplicación bloquea la
         <b>cuenta</b> tras 5 fallos, y el gateway limita la <b>tasa por IP</b>.
         Uno frena el ataque concentrado, el otro el distribuido.</p>
      <div class="fila">
        <button class="b sec" data-esc="rol">Escritura con rol insuficiente</button>
        <button class="b sec" data-esc="fuerza-bruta">Fuerza bruta (8 intentos)</button>
        <button class="b sec" data-esc="rafaga">Ráfaga de 40 peticiones</button>
        <button class="b sec" data-esc="verbo">Verbo DELETE</button>
      </div>
      <pre class="salida" id="out-limite"><span class="vacio">Elegí un escenario.</span></pre>
    </div>`;

  const linea = (r, nota = '') =>
    `[${String(r.codigo).padEnd(3)}] ${r.metodo.padEnd(6)} ${r.ruta.padEnd(26)} ` +
    `${(r.origen === 'app' ? r.servidaPor : 'GATEWAY').padEnd(9)} ${nota}`;

  const escenarios = {
    'sin-token': async (out) => {
      const r = await pedir('GET', '/api/products', { sinToken: true });
      out(`${linea(r)}\n\n${r.texto}`);
    },
    'adulterado': async (out) => {
      if (!estado.token) return out('Iniciá sesión primero para tener un token que adulterar.');
      const falso = estado.token.slice(0, -2) + 'XX';
      const r = await pedir('GET', '/api/products', { token: falso });
      out(`Se alteraron los 2 últimos caracteres de la firma.\n\n${linea(r)}\n\n${r.texto}`);
    },
    'ajeno': async (out) => {
      const r = await pedir('GET', '/api/products', {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
               'eyJzdWIiOiJhdGFjYW50ZSIsInJvbCI6ImFkbWluIiwiaXNzIjoidXQyLXRmdS1hcGkifQ.firma-falsa',
      });
      out(`Token que dice rol "admin" pero está firmado con otra clave.\n\n${linea(r)}\n\n${r.texto}`);
    },
    'valido': async (out) => {
      if (!estado.token) return out('Iniciá sesión primero.');
      const r = await pedir('GET', '/api/products');
      out(`${linea(r)}\n\n${r.texto}`);
    },
    'rol': async (out) => {
      const l = await pedir('POST', '/auth/login',
        { cuerpo: { usuario: 'bob', password: 'bob123' }, sinToken: true });
      if (l.codigo !== 200) return out(`No se pudo autenticar a bob:\n${l.texto}`);
      const r = await pedir('POST', '/api/products', {
        token: l.cuerpo.token, cuerpo: { nombre: 'Producto no autorizado', precio: 1 },
      });
      out(`bob se autentica correctamente (rol "user") y luego intenta escribir.\n\n` +
          `${linea(l)}\n${linea(r)}\n\n${r.texto}`);
    },
    'fuerza-bruta': async (out) => {
      const victima = `objetivo-${Date.now().toString().slice(-5)}`;
      let salida = `8 intentos con contraseña incorrecta contra "${victima}"\n` +
                   `umbral de la aplicación: 5 fallos en 60 s\n\n`;
      for (let i = 1; i <= 8; i++) {
        const r = await pedir('POST', '/auth/login',
          { cuerpo: { usuario: victima, password: `intento${i}` }, sinToken: true, silencioso: i > 1 && i < 8 });
        const detalle = r.cuerpo?.intentos_restantes !== undefined
          ? `quedan ${r.cuerpo.intentos_restantes} intentos`
          : (r.cuerpo?.error || '');
        salida += `${String(i).padStart(2)}. ${linea(r, detalle)}\n`;
        out(salida);
      }
      out(salida + `\nEl 429 lo genera la APLICACIÓN (trae X-Served-By): a partir del\n` +
                   `sexto intento ya ni siquiera se evalúa la contraseña.`);
    },
    'rafaga': async (out) => {
      let salida = '40 logins válidos y seguidos de bob.\nComo son válidos no disparan el ' +
                   'bloqueo de cuenta:\ntodo 429 que aparezca lo generó el gateway.\n\n';
      out(salida + 'ejecutando...');
      const rs = await correrLote(40, 6, () => pedir('POST', '/auth/login',
        { cuerpo: { usuario: 'bob', password: 'bob123' }, sinToken: true, silencioso: true }));
      const resumen = { ok: 0, borde: 0, app: 0 };
      rs.forEach((r) => {
        if (r.codigo === 200) resumen.ok++;
        else if (r.codigo === 429 && r.origen === 'gateway') resumen.borde++;
        else if (r.codigo === 429) resumen.app++;
      });
      anotar(rs[rs.length - 1]);
      out(salida +
        `  200 atendidas por una réplica ...... ${resumen.ok}\n` +
        `  429 cortadas por el GATEWAY ........ ${resumen.borde}\n` +
        `  429 generadas por la APLICACIÓN .... ${resumen.app}\n\n` +
        `Las cortadas en el borde nunca llegaron a consumir CPU de las réplicas:\n` +
        `eso es lo que evita que el costo de scrypt se vuelva un vector de DoS.\n` +
        `El límite se libera solo en unos segundos.`);
    },
    'verbo': async (out) => {
      const r = await pedir('DELETE', '/api/products');
      out(`El gateway solo admite GET, POST, HEAD y OPTIONS.\n\n${linea(r)}\n\n${r.texto}`);
    },
  };

  document.querySelectorAll('[data-esc]').forEach((b) => {
    b.onclick = async () => {
      const destino = ['sin-token', 'adulterado', 'ajeno', 'valido'].includes(b.dataset.esc)
        ? '#out-auth' : '#out-limite';
      const out = (t) => { $(destino).textContent = t; };
      out('ejecutando...');
      await escenarios[b.dataset.esc](out);
    };
  });
};

/* -------------------------------------------------------------- 5. manual  */
vistas.manual = () => {
  $('#vista').innerHTML = `
    <div class="tarjeta">
      <h2>Petición manual</h2>
      <p class="desc">Equivalente a Postman o curl, contra el mismo gateway.
         El token de la sesión activa se adjunta salvo que lo desmarques.</p>

      <div class="fila" style="align-items:flex-end">
        <div style="width:120px"><label>Método</label>
          <select id="m-metodo">
            <option>GET</option><option>POST</option><option>DELETE</option><option>PUT</option>
          </select>
        </div>
        <div style="flex:1;min-width:240px"><label>Ruta</label>
          <input id="m-ruta" value="/api/products" list="rutas-sugeridas">
          <datalist id="rutas-sugeridas">
            <option value="/health"><option value="/whoami"><option value="/stats">
            <option value="/auth/login"><option value="/api/products">
            <option value="/api/report?iter=150000">
          </datalist>
        </div>
        <button class="b" id="m-enviar">Enviar</button>
      </div>

      <div style="margin-top:14px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="m-token" checked style="width:auto">
          Adjuntar <code>Authorization: Bearer &lt;token&gt;</code>
        </label>
      </div>

      <div style="margin-top:14px">
        <label>Cuerpo JSON (se ignora en GET)</label>
        <textarea id="m-cuerpo">{
  "usuario": "alice",
  "password": "alice123"
}</textarea>
      </div>

      <pre class="salida" id="m-salida"><span class="vacio">Sin peticiones todavía.</span></pre>
    </div>`;

  $('#m-enviar').onclick = async () => {
    const metodo = $('#m-metodo').value;
    const texto = $('#m-cuerpo').value.trim();
    let cuerpo = null;
    if (metodo !== 'GET' && texto) {
      try { cuerpo = JSON.parse(texto); }
      catch (e) { $('#m-salida').textContent = `El cuerpo no es JSON válido: ${e.message}`; return; }
    }
    const r = await pedir(metodo, $('#m-ruta').value, { cuerpo, sinToken: !$('#m-token').checked });
    $('#m-salida').innerHTML =
      `<span class="chip ${claseCodigo(r.codigo)}">${r.codigo}</span>  ` +
      (r.servidaPor ? `<span style="color:var(--ok)">réplica ${r.servidaPor}</span>`
                    : '<span style="color:var(--alerta)">respuesta del gateway</span>') +
      `  ${r.ms} ms\n\n${esc(r.texto || '(sin cuerpo)')}`;
  };
};

/* ------------------------------------------------------------- arranque --- */
document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.remove('activa'));
    b.classList.add('activa');
    vistas[b.dataset.vista]();
  };
});

$('#btn-limpiar').onclick = () => { estado.registro = []; pintarRegistro(); };

async function sondearGateway() {
  const r = await pedir('GET', '/health', { silencioso: true });
  $('#pt-gw').className = 'punto ' + (r.codigo === 200 ? 'vivo' : 'muerto');
}

vistas.sesion();
pintarEstadoSesion();
sondearGateway();
setInterval(sondearGateway, 8000);
