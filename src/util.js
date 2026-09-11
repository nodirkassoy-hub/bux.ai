'use strict';
/**
 * BUXAI — umumiy yordamchi funksiyalar.
 * Barcha pul summalari butun son (tiyin emas, so'm) ko'rinishida saqlanadi.
 * Bu double-entry balanslashda float xatolarini oldini oladi.
 */

class ApiError extends Error {
  constructor(message, status = 400, code = 'bad_request', details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MONTHS_UZ = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
const MONTHS_SHORT_UZ = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyn', 'Iyl', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek'];
const WEEKDAYS_UZ = ['Yak', 'Dush', 'Sesh', 'Chor', 'Pay', 'Jum', 'Shan'];

function pad(n, len = 2) { return String(n).padStart(len, '0'); }

/** ISO sana (YYYY-MM-DD) — mahalliy vaqt bo'yicha */
function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function today() { return isoDate(new Date()); }

/** ISO davr (YYYY-MM) */
function periodOf(dateStr) { return String(dateStr || today()).slice(0, 7); }
function currentPeriod() { return today().slice(0, 7); }

function parseDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}
function isValidDate(s) { return !!parseDate(s); }
function isValidPeriod(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || '')); }

function addDays(dateStr, days) {
  const d = parseDate(dateStr) || new Date();
  d.setDate(d.getDate() + days);
  return isoDate(d);
}
function addMonths(period, delta) {
  const [y, m] = String(period).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function daysBetween(a, b) {
  const da = parseDate(a), dbb = parseDate(b);
  if (!da || !dbb) return 0;
  return Math.round((dbb - da) / 86400000);
}
function periodStart(p) { return `${p}-01`; }
function periodEnd(p) {
  const [y, m] = p.split('-').map(Number);
  return isoDate(new Date(y, m, 0));
}
function periodLabel(p) {
  const [y, m] = String(p).split('-').map(Number);
  return `${MONTHS_UZ[(m || 1) - 1]} ${y}`;
}
function lastNPeriods(n, endPeriod = currentPeriod()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addMonths(endPeriod, -i));
  return out;
}
function startOfWeek(dateStr = today()) {
  const d = parseDate(dateStr) || new Date();
  const day = (d.getDay() + 6) % 7; // Dushanba = 0
  d.setDate(d.getDate() - day);
  return isoDate(d);
}

/**
 * Dashboard/report davr filtri. Qaytaradi: {from,to,label,key}
 * key: today | week | month | last_month | quarter | year | custom | all
 */
function resolveRange(input = {}, now = today()) {
  const key = String(input.range || input.key || 'month');
  const p = currentPeriod();
  if (key === 'today') return { key, from: now, to: now, label: 'Bugun' };
  if (key === 'week') return { key, from: startOfWeek(now), to: now, label: 'Bu hafta' };
  if (key === 'month') return { key, from: periodStart(p), to: periodEnd(p), label: periodLabel(p) };
  if (key === 'last_month') { const lp = addMonths(p, -1); return { key, from: periodStart(lp), to: periodEnd(lp), label: periodLabel(lp) }; }
  if (key === 'quarter') {
    const [y, m] = p.split('-').map(Number);
    const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
    const qs = `${y}-${pad(qStartMonth)}`;
    const qe = addMonths(qs, 2);
    return { key, from: periodStart(qs), to: periodEnd(qe), label: `${Math.floor((m - 1) / 3) + 1}-chorak ${y}` };
  }
  if (key === 'year') { const y = p.split('-')[0]; return { key, from: `${y}-01-01`, to: `${y}-12-31`, label: `${y} yil` }; }
  if (key === 'all') return { key, from: '1900-01-01', to: '2999-12-31', label: 'Butun davr' };
  // custom
  const from = isValidDate(input.from) ? input.from : periodStart(p);
  const to = isValidDate(input.to) ? input.to : periodEnd(p);
  if (from > to) throw new ApiError('Sana oralig‘i noto‘g‘ri: boshlanish sanasi tugash sanasidan keyin.', 400, 'invalid_range');
  return { key: 'custom', from, to, label: `${from} — ${to}` };
}

/** Oldingi davr (solishtirish uchun) — bir xil uzunlikdagi oldingi oraliq */
function previousRange(range) {
  if (range.key === 'today') { const y = addDays(range.from, -1); return { from: y, to: y, label: 'Kecha' }; }
  if (range.key === 'week') return { from: addDays(range.from, -7), to: addDays(range.to, -7), label: 'O‘tgan hafta' };
  if (range.key === 'month') { const lp = addMonths(range.from.slice(0, 7), -1); return { from: periodStart(lp), to: periodEnd(lp), label: periodLabel(lp) }; }
  if (range.key === 'last_month') { const lp = addMonths(range.from.slice(0, 7), -2); return { from: periodStart(lp), to: periodEnd(lp), label: periodLabel(lp) }; }
  if (range.key === 'quarter') { const qs = addMonths(range.from.slice(0, 7), -3); const qe = addMonths(qs, 2); return { from: periodStart(qs), to: periodEnd(qe), label: 'O‘tgan chorak' }; }
  if (range.key === 'year') { const y = Number(range.from.slice(0, 4)) - 1; return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y} yil` }; }
  const days = Math.max(1, daysBetween(range.from, range.to) + 1);
  return { from: addDays(range.from, -days), to: addDays(range.from, -1), label: 'O‘tgan davr' };
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const cleaned = v.replace(/\s/g, '').replace(/[’‘'`]/g, '').replace(/,/g, '.').replace(/[^\d.\-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
/** Pul summasini butun songa keltiradi (manfiy summalarga yo'l qo'yilmaydi) */
function amount(v, field = 'Summa') {
  const n = Math.round(num(v));
  if (!Number.isFinite(n)) throw new ApiError(`${field} raqam bo‘lishi kerak.`, 400, 'invalid_amount', { field });
  return n;
}
function positiveAmount(v, field = 'Summa') {
  const n = amount(v, field);
  if (n <= 0) throw new ApiError(`${field} noldan katta bo‘lishi kerak.`, 400, 'invalid_amount', { field });
  return n;
}

function fmtMoney(v, currency = 'UZS') {
  const n = Math.round(num(v));
  const sign = n < 0 ? '−' : '';
  const s = new Intl.NumberFormat('uz-UZ').format(Math.abs(n));
  return `${sign}${s} ${currency === 'USD' ? 'USD' : 'so‘m'}`;
}
function fmtCompact(v) {
  const n = Math.abs(Math.round(num(v)));
  const sign = num(v) < 0 ? '−' : '';
  if (n >= 1e9) return `${sign}${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} mlrd`;
  if (n >= 1e6) return `${sign}${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} mln`;
  if (n >= 1e3) return `${sign}${(n / 1e3).toFixed(0)} ming`;
  return `${sign}${n}`;
}
function pct(a, b, digits = 1) {
  if (!b) return null;
  return Number(((a / b) * 100).toFixed(digits));
}
function growth(current, previous) {
  if (previous === 0 || previous == null) return null;
  return Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
}

/** Matnni qidiruv/normalizatsiya uchun tozalash */
function norm(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[‘’ʻʼ'`]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}
function slug(s) {
  return norm(s).replace(/[^a-z0-9\u0400-\u04ff]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}
function str(v, { max = 300, required = false, field = 'Maydon' } = {}) {
  const s = String(v == null ? '' : v).trim();
  if (required && !s) throw new ApiError(`${field} to‘ldirilishi shart.`, 400, 'required', { field });
  if (s.length > max) throw new ApiError(`${field} juda uzun (maks. ${max} belgi).`, 400, 'too_long', { field });
  return s;
}
function isEmail(s) { return !s || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s); }
/** O'zbekiston STIR/INN: 9 raqam (yuridik), 14 raqam (jismoniy) */
function isINN(s) { return !s || /^\d{9}$/.test(s) || /^\d{14}$/.test(s); }
function isMFO(s) { return !s || /^\d{5}$/.test(s); }
function isBankAccount(s) { return !s || /^\d{20}$/.test(String(s).replace(/\s/g, '')); }

function uniq(arr) { return [...new Set(arr)]; }
function groupBy(arr, fn) {
  const out = new Map();
  for (const item of arr) {
    const k = fn(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}
function sumBy(arr, fn) { let t = 0; for (const i of arr) t += num(fn(i)); return t; }
function sortBy(arr, fn, dir = 'asc') {
  const s = [...arr].sort((a, b) => {
    const x = fn(a), y = fn(b);
    if (x === y) return 0;
    return (x > y ? 1 : -1) * (dir === 'desc' ? -1 : 1);
  });
  return s;
}
function round(n, d = 2) { const f = Math.pow(10, d); return Math.round(n * f) / f; }
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function mean(arr) { return arr.length ? sumBy(arr, x => x) / arr.length : 0; }
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, x) => a + Math.pow(x - m, 2), 0) / (arr.length - 1));
}
function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
/** Matn o'xshashligi (token asosida Jaccard) — 0..1 */
function similarity(a, b) {
  const ta = new Set(norm(a).split(/[^a-z0-9\u0400-\u04ff]+/).filter(t => t.length > 2));
  const tb = new Set(norm(b).split(/[^a-z0-9\u0400-\u04ff]+/).filter(t => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function paginate(items, { page = 1, pageSize = 50 } = {}) {
  const total = items.length;
  const ps = clamp(Number(pageSize) || 50, 1, 500);
  const totalPages = Math.max(1, Math.ceil(total / ps));
  const p = clamp(Number(page) || 1, 1, totalPages);
  const start = (p - 1) * ps;
  return { rows: items.slice(start, start + ps), page: p, pageSize: ps, total, totalPages };
}

function money(n) { return fmtMoney(n); }

module.exports = {
  ApiError, MONTHS_UZ, MONTHS_SHORT_UZ, WEEKDAYS_UZ, pad,
  isoDate, today, periodOf, currentPeriod, parseDate, isValidDate, isValidPeriod,
  addDays, addMonths, daysBetween, periodStart, periodEnd, periodLabel, lastNPeriods, startOfWeek,
  resolveRange, previousRange, previousPeriod: (p) => addMonths(p, -1),
  num, amount, positiveAmount, fmtMoney, fmtCompact, pct, growth,
  norm, slug, str, isEmail, isINN, isMFO, isBankAccount,
  uniq, groupBy, sumBy, sortBy, round, clamp, mean, stddev, median, similarity, paginate, money,
};
