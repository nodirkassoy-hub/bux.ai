'use strict';
/**
 * BUXAI — ma'lumotlar ombori.
 * Jednostav JSON fayl ombori (atomik yozish, tranzaksiyalar, sxema migratsiyasi).
 * Ishlab chiqarishga chiqarishda shu interfeys saqlangan holda PostgreSQL'ga o'tkaziladi.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.BUXAI_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.BUXAI_DB_FILE || path.join(DATA_DIR, 'db.json');
const SCHEMA = 2;

const COLLECTIONS = [
  'users', 'companies', 'memberships', 'sessions', 'accounts', 'entries', 'parties', 'invoices',
  'bills', 'payments', 'products', 'stockMoves', 'documents', 'bankImports', 'bankRows',
  'approvals', 'notifications', 'auditLog', 'goals', 'radarStates', 'usage', 'subscriptions',
  'closes', 'settings', 'tasks', 'chatMessages', 'taxMarks', 'errorLog', 'supportTickets', 'meta',
];

let db = null;
let dirty = false;
let writing = false;
let writeTimer = null;
let lastWriteError = null;
let txDepth = 0;
let txSnapshot = null;

function emptyDB() {
  const d = { schema: SCHEMA, createdAt: new Date().toISOString(), seq: {} };
  for (const c of COLLECTIONS) d[c] = [];
  d.settings = [];
  return d;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readFromDisk() {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    // Buzilgan fayl — zaxiraga o'tkazamiz va bo'sh bazadan boshlaymiz (jimgina yo'qotmaslik uchun)
    const bak = `${DB_FILE}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(DB_FILE, bak); } catch (_) { /* ignore */ }
    console.error(`[store] db.json o‘qilmadi (${e.message}). Zaxira: ${bak}`);
    return null;
  }
}

function normalize(d) {
  const base = emptyDB();
  const out = { ...base, ...d };
  for (const c of COLLECTIONS) if (!Array.isArray(out[c])) out[c] = [];
  if (!out.seq || typeof out.seq !== 'object') out.seq = {};
  out.schema = SCHEMA;
  return out;
}

function load() {
  if (db) return db;
  ensureDir();
  db = normalize(readFromDisk() || emptyDB());
  return db;
}

function flushSync() {
  if (!dirty) return;
  load();
  const tmp = `${DB_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
    dirty = false;
    lastWriteError = null;
  } catch (e) {
    lastWriteError = e;
    console.error('[store] yozishda xatolik:', e.message);
  }
}

function persist() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (writing) return;
    writing = true;
    try { flushSync(); } finally { writing = false; }
  }, 40);
  if (writeTimer.unref) writeTimer.unref();
}

function save() { persist(); }

/** Tranzaksiya: xatolik bo'lsa barcha o'zgarishlar qaytariladi. */
function transaction(fn) {
  const d = load();
  if (txDepth > 0) return fn(d); // ichki tranzaksiya — tashqi tranzaksiyaga qo'shiladi
  txDepth++;
  txSnapshot = JSON.parse(JSON.stringify(d));
  try {
    const result = fn(d);
    txDepth--;
    txSnapshot = null;
    persist();
    return result;
  } catch (e) {
    const snap = txSnapshot;
    txDepth--;
    txSnapshot = null;
    if (snap) {
      for (const k of Object.keys(db)) delete db[k];
      for (const k of Object.keys(snap)) db[k] = snap[k];
    }
    throw e;
  }
}

function nextSeq(name) {
  const d = load();
  const key = String(name || 'id');
  if (!key.startsWith('_')) d.seq[key] = (d.seq[key] || 0) + 1;
  return d.seq[key];
}
function nextNumber(name, pad = 6) {
  return String(nextSeq(name)).padStart(pad, '0');
}
function uid(prefix = '') {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
function nowISO() { return new Date().toISOString(); }

function collection(name) {
  const d = load();
  if (!COLLECTIONS.includes(name)) throw new Error(`Noma'lum kolleksiya: ${name}`);
  return d[name];
}

/**
 * Ma'lumot o'zgarganda hosilaviy keshlarni (Xato Radar) bekor qiladi.
 * Har bir mutatsiyadan keyin chaqiriladi — aks holda UI eski topilmalarni ko'rsatadi.
 */
function touch(companyId) {
  if (!companyId) return;
  try { require('./radar').invalidate(companyId); } catch (_) { /* modul hali yuklanmagan */ }
}

module.exports = {
  DB_FILE, DATA_DIR, SCHEMA, COLLECTIONS,
  load, save, persist, flushSync, transaction, uid, touch, nextSeq, nextNumber, nowISO, collection,
  get db() { return load(); },
  get writeError() { return lastWriteError; },
};
