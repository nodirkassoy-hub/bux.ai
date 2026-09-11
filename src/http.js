'use strict';
/**
 * BUXAI — HTTP yordamchilari: body parsing (JSON + multipart), cookie, javob, xatolar.
 */
const U = require('./util');
const { ApiError } = U;

const MAX_BODY = 20 * 1024 * 1024; // 20 MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError('Yuborilgan ma’lumot hajmi juda katta (maks. 20 MB).', 413, 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new ApiError('Fayl yuklash formati noto‘g‘ri (boundary topilmadi).', 400, 'invalid_multipart');
  const boundary = `--${(m[1] || m[2]).trim()}`;
  const parts = [];
  const boundaryBuf = Buffer.from(`\r\n${boundary}`);
  const startBuf = Buffer.from(boundary);
  let index = buffer.indexOf(startBuf);
  if (index < 0) throw new ApiError('Fayl yuklash ma’lumotlari buzuq.', 400, 'invalid_multipart');
  index += startBuf.length;
  while (index < buffer.length) {
    // sarlavhalar \r\n\r\n gacha
    const headerEnd = buffer.indexOf('\r\n\r\n', index);
    if (headerEnd < 0) break;
    const headerText = buffer.slice(index, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    let next = buffer.indexOf(boundaryBuf, dataStart);
    let dataEnd;
    if (next < 0) { dataEnd = buffer.length; next = buffer.length; } else { dataEnd = next; }
    const data = buffer.slice(dataStart, dataEnd);
    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: fileMatch ? Buffer.from(fileMatch[1], 'latin1').toString('utf8') : null,
      contentType: typeMatch ? typeMatch[1].trim() : null,
      data: fileMatch ? data : data.toString('utf8'),
    });
    index = next + boundaryBuf.length;
    if (buffer.slice(index, index + 2).toString() === '--') break;
    index += 2;
  }
  const fields = {};
  const files = {};
  for (const p of parts) {
    if (p.filename) files[p.name || 'file'] = { filename: p.filename, contentType: p.contentType || 'application/octet-stream', data: p.data };
    else fields[p.name] = p.data;
  }
  return { fields, files };
}

async function parseBody(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('json') && !contentType.includes('form-urlencoded') && !contentType.includes('multipart')) {
    const raw = await readBody(req);
    if (!raw.length) return { body: {}, files: {} };
    try { return { body: JSON.parse(raw.toString('utf8')), files: {} }; } catch (e) { return { body: {}, files: {} }; }
  }
  const raw = await readBody(req);
  if (contentType.includes('application/json')) {
    if (!raw.length) return { body: {}, files: {} };
    try { return { body: JSON.parse(raw.toString('utf8')), files: {} }; } catch (e) {
      throw new ApiError('JSON formati noto‘g‘ri.', 400, 'invalid_json');
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw.toString('utf8'));
    const body = {};
    for (const [k, v] of params.entries()) body[k] = v;
    return { body, files: {} };
  }
  return parseMultipart(raw, contentType);
}

function sendJSON(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err instanceof ApiError ? err.status : (err && err.status) || 500;
  const payload = {
    error: err && err.message ? err.message : 'Ichki xatolik yuz berdi.',
    code: err && err.code ? err.code : 'internal_error',
    details: err && err.details ? err.details : null,
  };
  if (status >= 500) console.error('[api]', err && err.stack ? err.stack : err);
  sendJSON(res, status, payload);
}

function sendFile(res, { buffer, filename, contentType, download = false, cache = false }) {
  const asciiName = String(filename).replace(/[^\x20-\x7E]/g, '_');
  res.writeHead(200, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': cache ? 'private, max-age=600' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buffer);
}

/** Cookie o'rnatish uchun xavfsiz atributlar */
function cookieString(name, value, { maxAge = null, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Oddiy token-bucket rate limiter (IP bo'yicha) */
class RateLimiter {
  constructor({ windowMs = 60000, max = 300, blockMs = 30000 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.blockMs = blockMs;
    this.buckets = new Map();
  }
  check(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) { b = { count: 0, reset: now + this.windowMs, blockedUntil: 0 }; this.buckets.set(key, b); }
    if (b.blockedUntil && b.blockedUntil > now) return { allowed: false, retryAfter: Math.ceil((b.blockedUntil - now) / 1000) };
    if (now > b.reset) { b.count = 0; b.reset = now + this.windowMs; b.blockedUntil = 0; }
    b.count++;
    if (b.count > this.max) {
      b.blockedUntil = now + this.blockMs;
      return { allowed: false, retryAfter: Math.ceil(this.blockMs / 1000) };
    }
    if (this.buckets.size > 5000) this.prune();
    return { allowed: true, remaining: this.max - b.count };
  }
  prune() {
    const now = Date.now();
    for (const [k, v] of this.buckets) if (now > v.reset && (!v.blockedUntil || v.blockedUntil < now)) this.buckets.delete(k);
  }
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { readBody, parseBody, parseCookies, parseMultipart, sendJSON, sendError, sendFile, cookieString, RateLimiter, clientIp, MAX_BODY };
