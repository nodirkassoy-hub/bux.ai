'use strict';
/**
 * BUXAI — server (HTTP + statik fayllar + API).
 * Xavfsizlik: HttpOnly cookie sessiyalari, CSRF himoyasi (custom header),
 * server tomonidagi ruxsat tekshiruvi, kompaniya darajasidagi izolyatsiya,
 * rate limiting va xatolar jurnali.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./src/store');
const U = require('./src/util');
const auth = require('./src/auth');
const audit = require('./src/audit');
const httpUtil = require('./src/http');
const { API } = require('./src/api');
const { ApiError } = U;

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const IS_HTTPS = process.env.BUXAI_HTTPS === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

const limiter = new httpUtil.RateLimiter({ windowMs: 60000, max: 600, blockMs: 20000 });
const authLimiter = new httpUtil.RateLimiter({ windowMs: 60000, max: 25, blockMs: 60000 });

// ───────────────────────────── Route kompilyatsiyasi ────────────────────────

const compiled = API.map(r => {
  const parts = r.path.split('/').filter(Boolean);
  return { ...r, parts, params: parts.filter(p => p.startsWith(':')).map(p => p.slice(1)) };
});

function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  let pathMatched = false;
  for (const route of compiled) {
    if (route.parts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const rp = route.parts[i];
      if (rp.startsWith(':')) { params[rp.slice(1)] = decodeURIComponent(parts[i]); continue; }
      if (rp !== parts[i]) { ok = false; break; }
    }
    if (!ok) continue;
    pathMatched = true;
    if (route.method === method) return { route, params };
  }
  return pathMatched ? { methodMismatch: true } : null;
}

// ────────────────────────────── Statik fayllar ──────────────────────────────

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  if (file.endsWith('/')) file += 'index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, file));
  if (!target.startsWith(PUBLIC_DIR)) return httpUtil.sendJSON(res, 403, { error: 'Ruxsat yo‘q', code: 'forbidden' });
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA yo'nalishlari uchun index.html
      if (!path.extname(file)) {
        const idx = path.join(PUBLIC_DIR, 'index.html');
        return fs.readFile(idx, (e2, data) => {
          if (e2) return httpUtil.sendJSON(res, 404, { error: 'Sahifa topilmadi', code: 'not_found' });
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          res.end(data);
        });
      }
      return httpUtil.sendJSON(res, 404, { error: 'Fayl topilmadi', code: 'not_found' });
    }
    const ext = path.extname(target).toLowerCase();
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(target).pipe(res);
  });
}

// ──────────────────────────────── Server ───────────────────────────────────

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const ip = httpUtil.clientIp(req);
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-BUXAI,X-Company-Id' });
      return res.end();
    }

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return httpUtil.sendJSON(res, 405, { error: 'Metod qo‘llab-quvvatlanmaydi', code: 'method_not_allowed' });
      return serveStatic(req, res, pathname);
    }

    // ── Rate limit ──
    const global = limiter.check(`ip:${ip}`);
    if (!global.allowed) {
      res.setHeader('Retry-After', String(global.retryAfter));
      return httpUtil.sendJSON(res, 429, { error: 'Juda ko‘p so‘rov yuborildi. Birozdan so‘ng qayta urinib ko‘ring.', code: 'rate_limited' });
    }

    const match = matchRoute(req.method, pathname);
    if (!match) return httpUtil.sendJSON(res, 404, { error: 'API manzili topilmadi', code: 'not_found' });
    if (match.methodMismatch) return httpUtil.sendJSON(res, 405, { error: 'HTTP metodi noto‘g‘ri', code: 'method_not_allowed' });
    const { route, params } = match;

    const cookies = httpUtil.parseCookies(req.headers.cookie);
    const sessionToken = cookies[auth.COOKIE];

    // ── CSRF: o'zgaruvchi metodlar uchun custom header talab qilamiz ──
    const mutating = ['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method);
    if (mutating && !req.headers['x-buxai'] && !req.headers['x-requested-with']) {
      return httpUtil.sendJSON(res, 403, {
        error: 'Xavfsizlik tekshiruvidan o‘tmadi (CSRF). Sahifani yangilab, qaytadan urinib ko‘ring.',
        code: 'csrf_failed',
      });
    }

    // ── Auth ──
    const sessionInfo = auth.userFromToken(sessionToken);
    const user = sessionInfo ? sessionInfo.user : null;
    if (!route.public && !user) {
      return httpUtil.sendJSON(res, 401, { error: 'Tizimga kirish talab qilinadi.', code: 'unauthorized' });
    }

    // ── Rate limit: login/registratsiya ──
    if (route.path.includes('/auth/login') || route.path.includes('/auth/register')) {
      const rl = authLimiter.check(`auth:${ip}`);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfter));
        return httpUtil.sendJSON(res, 429, { error: 'Kirish urinishlari juda ko‘p. 1 daqiqadan so‘ng qayta urinib ko‘ring.', code: 'rate_limited' });
      }
    }

    // ── Body ──
    let body = {}, files = {};
    if (mutating) {
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('multipart') || contentType.includes('json') || contentType.includes('urlencoded') || req.headers['content-length']) {
        const parsed = await httpUtil.parseBody(req);
        body = parsed.body || {};
        files = parsed.files || {};
      }
    }

    // ── Kompaniya konteksti va ruxsat ──
    let companyId = req.headers['x-company-id'] || url.searchParams.get('company_id') || body.company_id || null;
    let company = null, role = null;
    if (user) {
      const available = auth.companiesFor(user);
      if (!companyId) companyId = (sessionInfo && sessionInfo.session.active_company_id) || user.last_company_id || (available[0] ? available[0].id : null);
      if (companyId) {
        const access = auth.requireCompanyAccess(user, companyId);
        company = access.company;
        role = access.role;
      } else if (!route.public && !['/api/auth/me', '/api/companies', '/api/meta', '/api/health', '/api/auth/password', '/api/auth/logout', '/api/platform/overview', '/api/platform/users', '/api/platform/companies', '/api/platform/errors', '/api/platform/tickets'].includes(route.path)) {
        return httpUtil.sendJSON(res, 409, {
          error: 'Kompaniya tanlanmagan. Yangi kompaniya yaratishingiz kerak.',
          code: 'company_required',
        });
      }
      if (route.permission && companyId) auth.requirePermission(user, route.permission, companyId);
      if (route.permission && !companyId && !user.is_platform_admin) {
        return httpUtil.sendJSON(res, 403, { error: 'Bu amal uchun kompaniya konteksti kerak.', code: 'company_required' });
      }
    }

    const ctx = {
      req, res, url, params, query: Object.fromEntries(url.searchParams.entries()),
      body, files, user, company, companyId, role,
      session: sessionInfo ? sessionInfo.session : null, sessionToken,
      ip, ua: req.headers['user-agent'] || '',
      meta: { ip, ua: (req.headers['user-agent'] || '').slice(0, 120) },
      setCookie: (token) => res.setHeader('Set-Cookie', httpUtil.cookieString(auth.COOKIE, token, { maxAge: auth.SESSION_TTL_HOURS * 3600, secure: IS_HTTPS || req.headers['x-forwarded-proto'] === 'https' })),
      clearCookie: () => res.setHeader('Set-Cookie', httpUtil.cookieString(auth.COOKIE, '', { maxAge: 0 })),
    };

    const result = await route.handler(ctx);
    if (result && result._file) return httpUtil.sendFile(res, result._file);
    return httpUtil.sendJSON(res, req.method === 'POST' && route.path.endsWith('/api/transactions') ? 201 : 200, result ?? { ok: true });
  } catch (err) {
    const status = err instanceof ApiError ? err.status : (err.status || 500);
    if (status >= 500) {
      try {
        require('./src/platform').logError({
          message: err.message, code: err.code || 'internal_error', stack: (err.stack || '').split('\n').slice(0, 6).join(' | '),
          method: req.method, path: pathname, ip, user: null,
        });
      } catch (_) { /* ignore */ }
    }
    return httpUtil.sendError(res, err);
  } finally {
    if (process.env.BUXAI_LOG_REQUESTS === '1') {
      console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

// ───────────────────────────── Ishga tushirish ──────────────────────────────

function bootstrap() {
  store.load();
  auth.cleanupSessions();

  // Birinchi ishga tushirishda SuperAdmin yaratish
  const users = store.collection('users');
  if (!users.length) {
    const email = process.env.BUXAI_ADMIN_EMAIL || 'admin@bux.ai';
    const password = process.env.BUXAI_ADMIN_PASSWORD || `Buxai-${crypto.randomBytes(3).toString('hex')}!`;
    const admin = auth.createUser({ name: 'Platforma administratori', email, password, role: 'director', is_platform_admin: true });
    console.log('──────────────────────────────────────────────────────');
    console.log(' BUXAI birinchi ishga tushirish — SuperAdmin yaratildi');
    console.log(`   Email:  ${email}`);
    console.log(`   Parol:  ${password}`);
    console.log('   (BUXAI_ADMIN_EMAIL / BUXAI_ADMIN_PASSWORD orqali o‘zgartiriladi)');
    console.log('──────────────────────────────────────────────────────');
    audit.log({ company_id: null, user: admin, action: 'platform.bootstrap', entity: 'user', entity_id: admin.id, summary: 'Platforma administratori yaratildi (birinchi ishga tushirish)' });
  }
  // Demo kompaniya (ixtiyoriy): BUXAI_SEED_DEMO=1
  if (process.env.BUXAI_SEED_DEMO === '1') {
    const companies = store.collection('companies');
    if (!companies.length) {
      const admin = users.find(u => u.is_platform_admin) || users[0];
      const company = require('./src/companies').createCompany({
        name: 'BuxAI Demo — Orient Textile MChJ',
        legal_form: 'mchj', inn: '305987123', tax_mode: 'vat',
        address: 'Toshkent sh., Yakkasaroy tumani, Shota Rustaveli 12',
        director_name: 'Aziz Karimov', accountant_name: 'Nilufar Yusupova',
        phone: '+998 71 200 10 10', email: 'info@orient-textile.uz',
        bank_name: 'Tashkent City Bank', mfo: '00401', bank_account: '20208000904567890123',
      }, admin, { seed: true });
      console.log(`Demo kompaniya yaratildi: ${company.name}`);
    }
  }
  store.flushSync();
  server.listen(PORT, HOST, () => {
    const seeded = store.collection('users').length ? '' : ' (birinchi ishga tushirish)';
    console.log(`BUXAI server ishga tushdi: http://${HOST}:${PORT}${seeded}`);
    console.log(`Ma’lumotlar: ${store.DB_FILE}`);
  });
}

process.on('SIGINT', () => { store.flushSync(); console.log('\nBUXAI to‘xtatildi. Ma’lumotlar saqlandi.'); process.exit(0); });
process.on('SIGTERM', () => { store.flushSync(); process.exit(0); });
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e);
  try { require('./src/platform').logError({ message: e.message, stack: (e.stack || '').split('\n').slice(0, 5).join(' | '), code: 'uncaught' }); } catch (_) {}
  store.flushSync();
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && e.message ? e.message : e);
  try { require('./src/platform').logError({ message: String(e && e.message || e), code: 'unhandled_rejection' }); } catch (_) {}
});

if (require.main === module) bootstrap();

module.exports = { server, bootstrap };
