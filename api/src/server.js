'use strict';
/**
 * API REST - TFU UT2 (Tacticas de Arquitectura)
 *
 * Tacticas implementadas en esta capa:
 *  - RENDIMIENTO / "Mantener multiples copias de computo": el servicio es
 *    STATELESS (todo el estado compartido vive en Redis), condicion necesaria
 *    para que N replicas identicas puedan atender cualquier request detras
 *    del balanceador.
 *  - SEGURIDAD / "Autenticar actores": login con scrypt + JWT HS256 (auth.js).
 *  - SEGURIDAD / "Limitar el acceso": bloqueo temporal de cuenta tras N
 *    intentos fallidos, control de rol por recurso y superficie de red minima
 *    (el proceso solo es alcanzable desde el gateway).
 *
 * Sin dependencias externas: solo modulos nativos de Node.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { RedisClient } = require('./redis');
const { emitirToken, verificarToken, verificarCredenciales, TTL_SEGUNDOS } = require('./auth');

const PUERTO = Number(process.env.PORT || 3000);
const INSTANCIA = process.env.INSTANCE_ID || 'api-desconocida';
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);

// "Limitar el acceso": umbral de intentos fallidos antes de bloquear la cuenta.
const MAX_INTENTOS = Number(process.env.MAX_INTENTOS_LOGIN || 5);
const VENTANA_BLOQUEO = Number(process.env.VENTANA_BLOQUEO_SEG || 60);

const redis = new RedisClient(REDIS_HOST, REDIS_PORT);

// ---------------------------------------------------------------- datos demo
const PRODUCTOS = [
  { id: 1, nombre: 'Teclado mecanico', precio: 89.9,  stock: 12 },
  { id: 2, nombre: 'Monitor 27"',      precio: 320.0, stock: 5  },
  { id: 3, nombre: 'Mouse inalambrico', precio: 45.5, stock: 30 },
];
let proximoId = 4;

// ------------------------------------------------------------------ helpers
function responder(res, codigo, cuerpo, extra = {}) {
  const json = JSON.stringify(cuerpo, null, 2);
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'X-Served-By': INSTANCIA,          // <- evidencia de que replica respondio
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(json);
}

function leerCuerpo(req, limiteBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limiteBytes) { reject(new Error('cuerpo demasiado grande')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      const txt = Buffer.concat(partes).toString('utf8');
      if (!txt) return resolve({});
      try { resolve(JSON.parse(txt)); } catch { reject(new Error('JSON invalido')); }
    });
    req.on('error', reject);
  });
}

/** Middleware de autenticacion: exige Bearer token valido. */
function autenticar(req, res) {
  const cabecera = req.headers['authorization'] || '';
  const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : null;
  const r = verificarToken(token);
  if (!r.ok) {
    responder(res, 401, { error: 'no autenticado', detalle: r.error },
      { 'WWW-Authenticate': 'Bearer realm="ut2-tfu"' });
    return null;
  }
  return r.claims;
}

/** Control de acceso por rol (complementa a "limitar el acceso"). */
function exigirRol(res, claims, rol) {
  if (claims.rol !== rol) {
    responder(res, 403, { error: 'acceso denegado', requiere_rol: rol, rol_actual: claims.rol });
    return false;
  }
  return true;
}

/** Trabajo CPU-bound sintetico: sirve para evidenciar la ganancia de replicar. */
function calculoCostoso(iteraciones) {
  let h = Buffer.from('tfu-ut2');
  for (let i = 0; i < iteraciones; i++) h = crypto.createHash('sha256').update(h).digest();
  return h.toString('hex').slice(0, 16);
}

// --------------------------------------------------------------------- rutas
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ruta = url.pathname;
  const metodo = req.method;
  const inicio = process.hrtime.bigint();

  // Contadores compartidos en Redis -> permiten ver el reparto de carga
  // entre replicas (stateless + estado externalizado).
  if (ruta !== '/health') {
    redis.safe(null, 'HINCRBY', 'stats:requests', INSTANCIA, 1);
  }

  try {
    // --- publicos -----------------------------------------------------------
    if (metodo === 'GET' && ruta === '/health') {
      return responder(res, 200, { estado: 'ok', instancia: INSTANCIA });
    }

    if (metodo === 'GET' && ruta === '/whoami') {
      return responder(res, 200, {
        instancia: INSTANCIA,
        pid: process.pid,
        redis: redis.connected ? 'conectado' : 'desconectado',
        hora: new Date().toISOString(),
      });
    }

    if (metodo === 'GET' && ruta === '/stats') {
      const plano = await redis.safe([], 'HGETALL', 'stats:requests');
      const porInstancia = {};
      for (let i = 0; i < plano.length; i += 2) porInstancia[plano[i]] = Number(plano[i + 1]);
      const total = Object.values(porInstancia).reduce((a, b) => a + b, 0);
      return responder(res, 200, {
        total_requests: total,
        por_instancia: porInstancia,
        reparto_pct: Object.fromEntries(Object.entries(porInstancia)
          .map(([k, v]) => [k, total ? +((v * 100) / total).toFixed(1) : 0])),
        respondio: INSTANCIA,
      });
    }

    if (metodo === 'POST' && ruta === '/stats/reset') {
      await redis.safe(null, 'DEL', 'stats:requests');
      return responder(res, 200, { mensaje: 'contadores reiniciados' });
    }

    // --- autenticacion ------------------------------------------------------
    if (metodo === 'POST' && ruta === '/auth/login') {
      const { usuario, password } = await leerCuerpo(req);
      const claveBloqueo = `login:fallidos:${usuario}`;

      // "Limitar el acceso": si la cuenta esta bloqueada no se evalua la clave.
      const fallidos = Number(await redis.safe(0, 'GET', claveBloqueo)) || 0;
      if (fallidos >= MAX_INTENTOS) {
        const ttl = await redis.safe(VENTANA_BLOQUEO, 'TTL', claveBloqueo);
        return responder(res, 429, {
          error: 'cuenta bloqueada temporalmente',
          motivo: `mas de ${MAX_INTENTOS} intentos fallidos`,
          reintentar_en_segundos: Math.max(0, Number(ttl)),
        }, { 'Retry-After': String(Math.max(1, Number(ttl))) });
      }

      const r = verificarCredenciales(usuario, password);
      if (!r.ok) {
        const n = await redis.safe(fallidos + 1, 'INCR', claveBloqueo);
        if (Number(n) === 1) await redis.safe(null, 'EXPIRE', claveBloqueo, VENTANA_BLOQUEO);
        return responder(res, 401, {
          error: 'credenciales invalidas',
          intentos_restantes: Math.max(0, MAX_INTENTOS - Number(n)),
        });
      }

      await redis.safe(null, 'DEL', claveBloqueo);
      const { token, expira_en } = emitirToken({ sub: usuario, rol: r.rol });
      return responder(res, 200, { token, tipo: 'Bearer', expira_en, rol: r.rol });
    }

    // --- protegidos ---------------------------------------------------------
    if (ruta.startsWith('/api/')) {
      const claims = autenticar(req, res);
      if (!claims) return;

      if (metodo === 'GET' && ruta === '/api/products') {
        return responder(res, 200, { usuario: claims.sub, productos: PRODUCTOS });
      }

      if (metodo === 'POST' && ruta === '/api/products') {
        if (!exigirRol(res, claims, 'admin')) return;
        const body = await leerCuerpo(req);
        if (!body.nombre || typeof body.precio !== 'number') {
          return responder(res, 400, { error: 'se requieren "nombre" (string) y "precio" (number)' });
        }
        const nuevo = { id: proximoId++, nombre: String(body.nombre).slice(0, 80),
                        precio: body.precio, stock: Number(body.stock) || 0 };
        PRODUCTOS.push(nuevo);
        return responder(res, 201, { creado_por: claims.sub, producto: nuevo, instancia: INSTANCIA });
      }

      if (metodo === 'GET' && ruta === '/api/report') {
        const iter = Math.min(Number(url.searchParams.get('iter')) || 120000, 2000000);
        const huella = calculoCostoso(iter);
        const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
        return responder(res, 200, {
          reporte: 'consumo-cpu-sintetico', iteraciones: iter, huella,
          duracion_ms: +ms.toFixed(1), instancia: INSTANCIA, solicitado_por: claims.sub,
        });
      }

      return responder(res, 404, { error: 'recurso no encontrado', ruta });
    }

    return responder(res, 404, { error: 'recurso no encontrado', ruta });
  } catch (e) {
    return responder(res, 400, { error: e.message });
  }
});

servidor.headersTimeout = 10000;
servidor.requestTimeout = 30000;

servidor.listen(PUERTO, '0.0.0.0', () => {
  console.log(`[${INSTANCIA}] escuchando en :${PUERTO} | JWT ttl=${TTL_SEGUNDOS}s | redis=${REDIS_HOST}:${REDIS_PORT}`);
});

// Apagado ordenado: deja de aceptar conexiones y termina las en curso.
for (const señal of ['SIGTERM', 'SIGINT']) {
  process.on(señal, () => {
    console.log(`[${INSTANCIA}] recibida ${señal}, cerrando...`);
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
