'use strict';
/**
 * Cliente Redis minimalista (RESP2) sobre sockets TCP.
 * Se implementa a mano para que la imagen no necesite `npm install`
 * (cero dependencias externas => build reproducible y offline).
 *
 * Si Redis no esta disponible, las operaciones fallan de forma controlada
 * y la API sigue respondiendo (degradacion elegante).
 */
const net = require('node:net');

function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const s = String(a);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return Buffer.from(out, 'utf8');
}

// Devuelve { value, next } o null si el buffer aun no tiene la respuesta completa.
function parse(buf, off) {
  if (off >= buf.length) return null;
  const type = buf[off];
  const eol = buf.indexOf('\r\n', off, 'utf8');
  if (eol === -1) return null;
  const head = buf.toString('utf8', off + 1, eol);
  const next = eol + 2;

  switch (type) {
    case 0x2b: return { value: head, next };                       // +simple
    case 0x2d: return { value: new Error(head), next };            // -error
    case 0x3a: return { value: Number(head), next };               // :integer
    case 0x24: {                                                   // $bulk
      const len = Number(head);
      if (len === -1) return { value: null, next };
      if (buf.length < next + len + 2) return null;
      return { value: buf.toString('utf8', next, next + len), next: next + len + 2 };
    }
    case 0x2a: {                                                   // *array
      const n = Number(head);
      if (n === -1) return { value: null, next };
      const arr = [];
      let cur = next;
      for (let i = 0; i < n; i++) {
        const item = parse(buf, cur);
        if (!item) return null;
        arr.push(item.value);
        cur = item.next;
      }
      return { value: arr, next: cur };
    }
    default:
      throw new Error('RESP: tipo desconocido ' + String.fromCharCode(type));
  }
}

class RedisClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.pending = [];
    this.buf = Buffer.alloc(0);
    this.sock = null;
    this.connected = false;
    this._connect();
  }

  _connect() {
    this.sock = net.createConnection({ host: this.host, port: this.port });
    this.sock.setNoDelay(true);
    this.sock.on('connect', () => { this.connected = true; });
    this.sock.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        let res;
        try { res = parse(this.buf, 0); } catch (e) { this.sock.destroy(); return; }
        if (!res) break;
        this.buf = this.buf.subarray(res.next);
        const p = this.pending.shift();
        if (!p) continue;
        if (res.value instanceof Error) p.reject(res.value); else p.resolve(res.value);
      }
    });
    this.sock.on('error', () => {});
    this.sock.on('close', () => {
      this.connected = false;
      const q = this.pending; this.pending = []; this.buf = Buffer.alloc(0);
      for (const p of q) p.reject(new Error('conexion a Redis cerrada'));
      setTimeout(() => this._connect(), 1000).unref();
    });
  }

  cmd(...args) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Redis no disponible'));
      this.pending.push({ resolve, reject });
      this.sock.write(encode(args));
    });
  }

  // Variante tolerante a fallos: nunca rechaza, devuelve `fallback`.
  async safe(fallback, ...args) {
    try { return await this.cmd(...args); } catch { return fallback; }
  }
}

module.exports = { RedisClient };
