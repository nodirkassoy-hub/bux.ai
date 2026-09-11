'use strict';
/**
 * BUXAI — Hujjatlar markazi va OCR hujjat tahlili.
 * OCR natijasi hech qachon avtomatik buxgalteriya yozuvi yaratmaydi:
 * buxgalter tekshiradi va TASDIQLAYDI.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const U = require('./util');
const parsers = require('./parsers');
const { ApiError } = U;

const UPLOAD_DIR = process.env.BUXAI_UPLOAD_DIR || path.join(store.DATA_DIR, 'uploads');
const MAX_FILE_MB = 15;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

const DOC_TYPES = [
  { key: 'invoice', label: 'Hisob-faktura (sotuv)' },
  { key: 'bill', label: 'Yetkazib beruvchi hisobi' },
  { key: 'receipt', label: 'Kvitansiya / chek' },
  { key: 'bank_statement', label: 'Bank ko‘chirmasi' },
  { key: 'contract', label: 'Shartnoma' },
  { key: 'tax', label: 'Soliq hujjati' },
  { key: 'waybill', label: 'Yuk xati (nakladnoy)' },
  { key: 'act', label: 'Bajarilgan ishlar dalolatnomasi' },
  { key: 'other', label: 'Boshqa' },
];

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function all(companyId) { return store.collection('documents').filter(d => d.company_id === companyId && !d.deleted_at); }
function find(companyId, id) {
  const d = store.collection('documents').find(x => x.id === id && x.company_id === companyId && !x.deleted_at);
  if (!d) throw new ApiError('Hujjat topilmadi.', 404, 'not_found');
  return d;
}
function tryFind(companyId, id) { return store.collection('documents').find(x => x.id === id && x.company_id === companyId && !x.deleted_at) || null; }

function decorate(companyId, d) {
  const party = d.party_id ? store.collection('parties').find(p => p.id === d.party_id && p.company_id === companyId) : null;
  const invoice = d.invoice_id ? store.collection('invoices').find(i => i.id === d.invoice_id) : null;
  const bill = d.bill_id ? store.collection('bills').find(b => b.id === d.bill_id) : null;
  const entry = d.entry_id ? ledgerFind(companyId, d.entry_id) : null;
  const product = d.product_id ? store.collection('products').find(p => p.id === d.product_id && p.company_id === companyId) : null;
  return {
    ...d,
    size_label: d.size > 1048576 ? `${U.round(d.size / 1048576, 1)} MB` : `${Math.max(1, Math.round(d.size / 1024))} KB`,
    type_label: (DOC_TYPES.find(t => t.key === d.type) || { label: 'Boshqa' }).label,
    party_name: party ? party.name : null,
    invoice_no: invoice ? invoice.no : null,
    bill_no: bill ? bill.no : null,
    entry_no: entry ? entry.no : null,
    product_name: product ? product.name : null,
    links_count: [party, invoice, bill, entry, product].filter(Boolean).length,
    status_label: d.status === 'pending_review' ? 'Tekshirish kutilmoqda' : d.status === 'approved' ? 'Tasdiqlangan' : d.status === 'linked' ? 'Bog‘langan' : 'Yuklangan',
    url: `/api/documents/${d.id}/file`,
  };
}
function ledgerFind(companyId, id) { return require('./ledger').findEntry(companyId, id); }

function upload(companyId, { name, mime, buffer, size, type, tags, note, links = {}, source = 'manual' }, user, { meta = {} } = {}) {
  const limits = require('./companies').subscriptionFor(companyId).plan_def.limits;
  const usedMb = store.collection('documents').filter(d => d.company_id === companyId && !d.deleted_at).reduce((a, d) => a + (d.size || 0), 0) / 1048576;
  const fileSize = size || (buffer ? buffer.length : 0);
  if (!fileSize) throw new ApiError('Fayl bo‘sh yoki yuklanmadi.', 400, 'empty_file');
  if (fileSize > MAX_FILE_MB * 1048576) throw new ApiError(`Fayl hajmi ${MAX_FILE_MB} MB dan oshmasligi kerak.`, 413, 'file_too_large');
  if (usedMb + fileSize / 1048576 > limits.documents_mb) {
    throw new ApiError(`Hujjatlar saqlash limiti tugadi (${limits.documents_mb} MB). Tarifni yangilang yoki eski hujjatlarni o‘chiring.`, 402, 'storage_limit', { limit_mb: limits.documents_mb, used_mb: U.round(usedMb, 1) });
  }
  if (mime && !ALLOWED.includes(mime) && !mime.startsWith('image/')) {
    throw new ApiError(`Fayl turi qo‘llab-quvvatlanmaydi (${mime}). PDF, rasm, Excel yoki CSV yuklang.`, 415, 'unsupported_type');
  }
  const dir = path.join(UPLOAD_DIR, companyId);
  ensureDir(dir);
  const ext = path.extname(name || '').slice(0, 10).replace(/[^.\w]/g, '') || mimeToExt(mime);
  const stored = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const full = path.join(dir, stored);
  if (buffer) fs.writeFileSync(full, buffer);
  const doc = {
    id: store.uid('doc'), company_id: companyId,
    name: U.str(name || 'hujjat', { max: 200 }),
    stored_name: stored, size: fileSize, mime: mime || 'application/octet-stream',
    type: DOC_TYPES.some(t => t.key === type) ? type : 'other',
    tags: Array.isArray(tags) ? tags.slice(0, 10) : [],
    note: U.str(note || '', { max: 1000 }),
    party_id: links.party_id || null, invoice_id: links.invoice_id || null,
    bill_id: links.bill_id || null, entry_id: links.entry_id || null, product_id: links.product_id || null,
    status: 'uploaded', source,
    uploaded_by: user ? user.id : null, created_at: store.nowISO(),
    hash: buffer ? crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32) : null,
    extraction: null, deleted_at: null,
  };
  // Bir xil fayl takror yuklanishini oldini olish
  if (doc.hash) {
    const dup = store.collection('documents').find(d => d.company_id === companyId && d.hash === doc.hash && !d.deleted_at);
    if (dup) {
      if (buffer) { try { fs.unlinkSync(full); } catch (_) { /* ignore */ } }
      throw new ApiError(`Bu fayl allaqachon yuklangan: «${dup.name}». Dublikat yaratmaslik uchun mavjud hujjatdan foydalaning.`, 409, 'duplicate_file', { existing_id: dup.id });
    }
  }
  store.collection('documents').push(doc);
  store.save();
  store.touch(companyId);
  if (doc.party_id || doc.invoice_id || doc.bill_id || doc.entry_id) doc.status = 'linked';
  require('./audit').log({ company_id: companyId, user, action: 'document.upload', entity: 'document', entity_id: doc.id, summary: `Hujjat yuklandi: ${doc.name} (${Math.round(fileSize / 1024)} KB)`, after: { name: doc.name, type: doc.type, size: fileSize }, meta });
  return decorate(companyId, doc);
}
function mimeToExt(mime) {
  return ({ 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'text/csv': '.csv' })[mime] || '.bin';
}

function filePath(companyId, id) {
  const doc = find(companyId, id);
  const full = path.join(UPLOAD_DIR, companyId, doc.stored_name);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(path.join(UPLOAD_DIR, companyId)))) throw new ApiError('Fayl manzili noto‘g‘ri.', 400, 'bad_path');
  if (!fs.existsSync(resolved)) throw new ApiError('Fayl serverda topilmadi (u o‘chirilgan bo‘lishi mumkin).', 404, 'file_missing');
  return { doc, path: resolved };
}

function list(companyId, { type, party_id, search, from, to, status, page = 1, pageSize = 50 } = {}) {
  let rows = all(companyId);
  if (type && type !== 'all') rows = rows.filter(d => d.type === type);
  if (party_id) rows = rows.filter(d => d.party_id === party_id);
  if (status) rows = rows.filter(d => d.status === status);
  if (from) rows = rows.filter(d => (d.created_at || '') >= from);
  if (to) rows = rows.filter(d => (d.created_at || '') <= `${to}T23:59:59.999Z`);
  if (search) {
    const q = U.norm(search);
    rows = rows.filter(d => U.norm(`${d.name} ${d.note} ${(d.tags || []).join(' ')} ${d.type}`).includes(q));
  }
  const out = U.sortBy(rows, d => d.created_at, 'desc').map(d => decorate(companyId, d));
  const pageData = U.paginate(out, { page, pageSize });
  const totalSize = U.sumBy(rows, d => d.size);
  const limits = require('./companies').subscriptionFor(companyId).plan_def.limits;
  return {
    ...pageData, items: pageData.rows,
    summary: {
      count: out.length, size: totalSize,
      size_label: totalSize > 1048576 ? `${U.round(totalSize / 1048576, 1)} MB` : `${Math.round(totalSize / 1024)} KB`,
      limit_mb: limits.documents_mb,
      used_percent: U.clamp(U.round((totalSize / 1048576 / limits.documents_mb) * 100, 1), 0, 100),
      pending_review: out.filter(d => d.status === 'pending_review').length,
      unlinked: out.filter(d => !d.links_count).length,
    },
    by_type: DOC_TYPES.map(t => ({ ...t, count: rows.filter(d => d.type === t.key).length })).filter(t => t.count),
  };
}

function update(companyId, id, patch, user) {
  const doc = find(companyId, id);
  const before = { ...doc };
  if (patch.name !== undefined) doc.name = U.str(patch.name, { max: 200, required: true, field: 'Nomi' });
  if (patch.type !== undefined && DOC_TYPES.some(t => t.key === patch.type)) doc.type = patch.type;
  if (patch.note !== undefined) doc.note = U.str(patch.note, { max: 1000 });
  if (patch.tags !== undefined) doc.tags = (patch.tags || []).slice(0, 10);
  for (const f of ['party_id', 'invoice_id', 'bill_id', 'entry_id', 'product_id']) {
    if (patch[f] !== undefined) {
      if (patch[f]) {
        const ok = f === 'party_id' ? store.collection('parties').some(x => x.id === patch[f] && x.company_id === companyId)
          : f === 'invoice_id' ? store.collection('invoices').some(x => x.id === patch[f] && x.company_id === companyId)
          : f === 'bill_id' ? store.collection('bills').some(x => x.id === patch[f] && x.company_id === companyId)
          : f === 'entry_id' ? !!require('./ledger').findEntry(companyId, patch[f])
          : store.collection('products').some(x => x.id === patch[f] && x.company_id === companyId);
        if (!ok) throw new ApiError('Bog‘lanadigan obyekt topilmadi.', 404, 'link_not_found', { field: f });
      }
      doc[f] = patch[f] || null;
    }
  }
  if (doc.party_id || doc.invoice_id || doc.bill_id || doc.entry_id || doc.product_id) doc.status = doc.status === 'pending_review' ? doc.status : 'linked';
  doc.updated_at = store.nowISO();
  store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'document.update', entity: 'document', entity_id: id, summary: `Hujjat tahrirlandi: ${doc.name}`, before, after: { ...doc } });
  return decorate(companyId, doc);
}

function remove(companyId, id, user) {
  const doc = find(companyId, id);
  doc.deleted_at = store.nowISO();
  doc.deleted_by = user ? user.id : null;
  const archived = store.collection('archive') || null;
  store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'document.delete', entity: 'document', entity_id: id, summary: `Hujjat o‘chirildi: ${doc.name}`, before: { name: doc.name, size: doc.size }, after: { deleted: true } });
  return { deleted: true, id };
}

// ─────────────────────────────── OCR / tahlil ───────────────────────────────

/** Hujjatdan ma'lumot ajratib olish (matn qatlami / OCR). Natija tasdiqlashni kutadi. */
function extract(companyId, docId, user, { meta = {} } = {}) {
  require('./companies').checkLimit(companyId, 'ocr');
  const doc = find(companyId, docId);
  const { path: full } = filePath(companyId, docId);
  const buffer = fs.readFileSync(full);
  const ocr = parsers.ocrText({ buffer });
  if (!ocr.text || ocr.text.length < 10) {
    doc.extraction = {
      status: 'unavailable', engine: null, at: store.nowISO(),
      reason: ocr.reason || 'Hujjatdan matn ajratib bo‘lmadi. OCR xizmati sozlanmagan (BUXAI_OCR_PROVIDER muhit o‘zgaruvchisi yo‘q) — ma’lumotlarni qo‘lda kiriting.',
      fields: null,
    };
    store.save();
    return {
      available: false,
      reason: doc.extraction.reason,
      hint: 'Matnli PDF, CSV yoki Excel yuklasangiz tahlil avtomatik ishlaydi.',
      document: decorate(companyId, doc),
    };
  }
  const fields = parsers.extractDocumentFields(ocr.text);
  const partyMatch = matchParty(companyId, fields);
  doc.extraction = {
    status: 'pending_review', engine: ocr.engine, at: store.nowISO(),
    fields: {
      ...fields,
      party_id: partyMatch ? partyMatch.id : null,
      party_match: partyMatch ? { id: partyMatch.id, name: partyMatch.name, score: partyMatch.score } : null,
    },
    text_excerpt: ocr.text.slice(0, 1500),
  };
  doc.status = 'pending_review';
  store.save();
  require('./companies').bump(companyId, 'ocr');
  require('./audit').log({
    company_id: companyId, user, action: 'document.extract', entity: 'document', entity_id: docId,
    summary: `Hujjat tahlil qilindi: ${doc.name} (ishonch: ${fields.confidence})`,
    after: { engine: ocr.engine, confidence: fields.confidence, supplier: fields.supplier_name, total: fields.total }, meta,
  });
  return { available: true, engine: ocr.engine, extraction: doc.extraction, document: decorate(companyId, doc), suggestions: suggestions(companyId, fields) };
}

function matchParty(companyId, fields) {
  if (!fields.supplier_name && !fields.tax_id) return null;
  const parties = store.collection('parties').filter(p => p.company_id === companyId);
  let best = null;
  for (const p of parties) {
    let score = 0;
    if (fields.tax_id && p.inn && fields.tax_id === p.inn) score += 70;
    if (fields.supplier_name) score += Math.round(U.similarity(fields.supplier_name, p.name) * 100);
    if (score > (best ? best.score : 39)) best = { ...p, score };
  }
  return best;
}

function suggestions(companyId, fields) {
  const out = [];
  const invoiceAcc = ledgerRole(companyId, 'ap');
  if (fields.total) {
    out.push({ action: 'create_expense', label: `Xarajat sifatida kiritish — ${U.fmtMoney(fields.total)}`, amount: fields.total, date: fields.date, confidence: fields.confidence });
    out.push({ action: 'create_bill', label: `Yetkazib beruvchi hisobi (AP) sifatida kiritish — ${U.fmtMoney(fields.total)}`, amount: fields.total, date: fields.date, confidence: fields.confidence });
  }
  if (!fields.total) out.push({ action: 'link', label: 'Mavjud operatsiyaga bog‘lash', confidence: 'manual' });
  return out;
}
function ledgerRole(companyId, role) { try { return require('./ledger').roleCode(companyId, role); } catch (e) { return null; } }

/**
 * Ajratilgan ma'lumotni TASDIQLASH va buxgalteriya yozuvini yaratish.
 * @param {Object} payload {action:'create_expense'|'create_bill'|'link'|'reject', fields:{...}, links:{...}}
 */
function approveExtraction(companyId, docId, payload, user, { meta = {} } = {}) {
  const doc = find(companyId, docId);
  if (!doc.extraction || doc.extraction.status !== 'pending_review') {
    throw new ApiError('Tasdiqlash uchun tahlil natijasi yo‘q. Avval hujjatni tahlil qiling.', 409, 'no_extraction');
  }
  const f = { ...(doc.extraction.fields || {}), ...(payload.fields || {}) };
  const action = payload.action || 'link';
  let created = null;
  if (action === 'create_expense') {
    const amount = U.positiveAmount(f.total, 'Summa');
    created = require('./transactions').create(companyId, {
      type: 'expense',
      amount,
      date: U.isValidDate(f.date) ? f.date : U.today(),
      description: U.str(payload.description || `${f.supplier_name || 'Hujjat'} — ${doc.name}`, { max: 400 }),
      account: payload.account || require('./ledger').roleCode(companyId, 'bank'),
      category: payload.category || 'other',
      party_id: payload.party_id || f.party_id || null,
      reference: f.invoice_no || '',
      attachments: [doc.id],
      tags: ['ocr'],
      source: { type: 'document', id: doc.id },
    }, user, { meta });
    doc.entry_id = created.id;
  } else if (action === 'create_bill') {
    const partyId = payload.party_id || f.party_id;
    if (!partyId) throw new ApiError('Yetkazib beruvchini tanlang — hujjatdan kontragent aniqlandi emas.', 400, 'party_required', [{ code: 'party_required', message: 'Kontragent tanlanmagan.' }]);
    created = require('./bills').create(companyId, {
      supplier_id: partyId,
      issue_date: U.isValidDate(f.date) ? f.date : U.today(),
      due_date: U.addDays(U.isValidDate(f.date) ? f.date : U.today(), 14),
      supplier_invoice_no: f.invoice_no || '',
      items: [{ name: payload.item_name || f.supplier_name || doc.name, qty: 1, unit_price: f.net_amount || f.total || 0, tax_rate: f.tax_amount && f.net_amount ? U.round((f.tax_amount / f.net_amount) * 100, 2) : null }],
      notes: `OCR orqali yaratildi: ${doc.name}`,
      attachments: [doc.id],
      tags: ['ocr'],
      receive_now: payload.receive_now !== false,
    }, user, { meta });
    doc.bill_id = created.id;
  } else if (action === 'link') {
    const links = payload.links || {};
    for (const k of ['party_id', 'invoice_id', 'bill_id', 'entry_id', 'product_id']) if (links[k]) doc[k] = links[k];
  } else if (action === 'reject') {
    doc.extraction.status = 'rejected';
    doc.extraction.rejected_at = store.nowISO();
    doc.extraction.rejected_reason = U.str(payload.reason || '', { max: 300 });
    store.save();
    require('./audit').log({ company_id: companyId, user, action: 'document.extraction_reject', entity: 'document', entity_id: docId, summary: `OCR natijasi rad etildi: ${doc.name}`, meta });
    return { rejected: true, document: decorate(companyId, doc) };
  } else {
    throw new ApiError('Amal turi noto‘g‘ri.', 400, 'invalid_action');
  }
  doc.extraction.status = 'approved';
  doc.extraction.approved_at = store.nowISO();
  doc.extraction.approved_by = user ? user.id : null;
  doc.extraction.applied_action = action;
  doc.status = 'approved';
  store.save();
  store.touch(companyId);
  require('./audit').log({
    company_id: companyId, user, action: 'document.extraction_approve', entity: 'document', entity_id: docId,
    summary: `Hujjat ma’lumotlari tasdiqlandi (${action}): ${doc.name}${created ? ` → ${created.no || created.id}` : ''}`,
    after: { action, applied: created || null, fields: f }, meta,
  });
  return { approved: true, action, created, document: decorate(companyId, doc) };
}

/** Bog'lanmagan hujjatlar (Xato Radar uchun) */
function unlinked(companyId, olderThanDays = 3) {
  const limit = U.addDays(U.today(), -olderThanDays);
  return all(companyId).filter(d => !d.party_id && !d.invoice_id && !d.bill_id && !d.entry_id && !d.product_id && (d.created_at || '').slice(0, 10) <= limit);
}

module.exports = { DOC_TYPES, all, list, find, tryFind, upload, update, remove, filePath, extract, approveExtraction, decorate, unlinked, matchParty };
