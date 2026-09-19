'use strict';
/**
 * TACTICA DE SEGURIDAD (resistir ataques): AUTENTICAR ACTORES
 *
 * - Password hasheada con scrypt + salt por usuario (nunca en texto plano).
 * - Comparacion en tiempo constante (timingSafeEqual) para evitar timing attacks.
 * - Token JWT HS256 firmado con clave secreta, con expiracion (exp) e emisor (iss).
 * - Verificacion de firma + expiracion en cada request a un recurso protegido.
 *
 * Implementado con `node:crypto` (cero dependencias externas).
 */
const crypto = require('node:crypto');

const SECRET = process.env.JWT_SECRET || 'cambiar-esta-clave-en-produccion';
const ISSUER = 'ut2-tfu-api';
const TTL_SEGUNDOS = Number(process.env.JWT_TTL || 900); // 15 minutos

const b64url = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function firmar(data) {
  return b64url(crypto.createHmac('sha256', SECRET).update(data).digest());
}

function emitirToken({ sub, rol }) {
  const ahora = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub, rol, iss: ISSUER, iat: ahora, exp: ahora + TTL_SEGUNDOS,
  }));
  const data = `${header}.${payload}`;
  return { token: `${data}.${firmar(data)}`, expira_en: TTL_SEGUNDOS };
}

function verificarToken(token) {
  if (typeof token !== 'string') return { ok: false, error: 'token ausente' };
  const partes = token.split('.');
  if (partes.length !== 3) return { ok: false, error: 'token malformado' };

  const [header, payload, firma] = partes;
  const esperada = Buffer.from(firmar(`${header}.${payload}`));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length ||
      !crypto.timingSafeEqual(esperada, recibida)) {
    return { ok: false, error: 'firma invalida' };
  }

  let claims;
  try { claims = JSON.parse(unb64url(payload).toString('utf8')); }
  catch { return { ok: false, error: 'payload invalido' }; }

  if (claims.iss !== ISSUER) return { ok: false, error: 'emisor invalido' };
  if (Math.floor(Date.now() / 1000) >= claims.exp) return { ok: false, error: 'token expirado' };
  return { ok: true, claims };
}

// --- Almacen de usuarios (seed de demo; en produccion iria en una base) ---
function hashear(password, salt) {
  return crypto.scryptSync(password, salt, 32);
}

const SEED = [
  { usuario: 'alice', password: 'alice123', rol: 'admin' },
  { usuario: 'bob',   password: 'bob123',   rol: 'user'  },
];

const USUARIOS = new Map(SEED.map((u) => {
  const salt = crypto.randomBytes(16);
  return [u.usuario, { rol: u.rol, salt, hash: hashear(u.password, salt) }];
}));

// Hash "señuelo": se calcula igual aunque el usuario no exista, para que el
// tiempo de respuesta no revele si un usuario es valido (enumeracion de cuentas).
const SEÑUELO = { salt: crypto.randomBytes(16), hash: crypto.randomBytes(32) };

function verificarCredenciales(usuario, password) {
  const u = USUARIOS.get(usuario) || SEÑUELO;
  const calculado = hashear(String(password ?? ''), u.salt);
  const valido = calculado.length === u.hash.length &&
    crypto.timingSafeEqual(calculado, u.hash) && USUARIOS.has(usuario);
  return valido ? { ok: true, rol: u.rol } : { ok: false };
}

module.exports = { emitirToken, verificarToken, verificarCredenciales, TTL_SEGUNDOS };
