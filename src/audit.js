'use strict';
/**
 * BUXAI — Audit jurnali (audit log).
 * Har bir muhim amal: kim, qachon, nimani, eski va yangi qiymat bilan yozib boriladi.
 */
const store = require('./store');
const U = require('./util');

const SENSITIVE = ['password_hash', 'token', 'password'];

function redact(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return obj === undefined ? null : obj;
  if (Array.isArray(obj)) return obj.slice(0, 50).map(x => redact(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.includes(k)) { out[k] = '***'; continue; }
    out[k] = (v && typeof v === 'object') ? redact(v, depth + 1) : v;
  }
  return out;
}

/**
 * Audit yozuvini qo'shish.
 * @param {Object} p
 * @param {string} p.company_id
 * @param {Object} p.user        — bajaruvchi
 * @param {string} p.action      — masalan 'transaction.create'
 * @param {string} p.entity      — 'transaction' | 'invoice' | ...
 * @param {string} p.entity_id
 * @param {string} p.summary     — o'qishga qulay izoh (o'zbek tilida)
 * @param {*} p.before
 * @param {*} p.after
 * @param {Object} p.meta        — { ip, ua, ... }
 */
function log({ company_id = null, user = null, action, entity = null, entity_id = null, summary = '', before = null, after = null, meta = null }) {
  const row = {
    id: store.uid('aud'),
    company_id,
    user_id: user ? user.id : null,
    user_name: user ? user.name : 'Tizim',
    user_role: user ? user.role : 'system',
    action,
    entity, entity_id,
    summary: U.str(summary, { max: 500 }),
    before: before == null ? null : redact(before),
    after: after == null ? null : redact(after),
    ip: meta && meta.ip ? String(meta.ip).slice(0, 60) : null,
    ua: meta && meta.ua ? String(meta.ua).slice(0, 160) : null,
    at: store.nowISO(),
  };
  const col = store.collection('auditLog');
  col.unshift(row);
  // Jurnal cheksiz o'smasin: oxirgi 20 000 yozuv saqlanadi
  if (col.length > 20000) col.length = 20000;
  store.save();
  return row;
}

function query(companyId, { user_id, entity, entity_id, action, from, to, search, limit = 200 } = {}) {
  return store.collection('auditLog')
    .filter(r => (companyId === null ? true : r.company_id === companyId))
    .filter(r => !user_id || r.user_id === user_id)
    .filter(r => !entity || r.entity === entity)
    .filter(r => !entity_id || r.entity_id === entity_id)
    .filter(r => !action || r.action === action || r.action.startsWith(action))
    .filter(r => !from || (r.at || '') >= from)
    .filter(r => !to || (r.at || '') <= `${to}T23:59:59.999Z`)
    .filter(r => {
      if (!search) return true;
      const hay = U.norm(`${r.summary} ${r.action} ${r.entity} ${r.user_name}`);
      return hay.includes(U.norm(search));
    })
    .slice(0, limit);
}

/** Oldingi/yangi qiymatlardan o'qishga qulay diff tayyorlash */
function diff(before, after, fields) {
  const out = [];
  for (const f of fields) {
    const a = before ? before[f] : null;
    const b = after ? after[f] : null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: f, before: a, after: b });
  }
  return out;
}

module.exports = { log, query, diff, redact };
