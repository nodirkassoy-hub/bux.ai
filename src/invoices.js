'use strict';
/**
 * BUXAI — Hisob-fakturalar (sotuv) va debitorlik qarzi (AR).
 * Hayotiy sikl: draft → sent → viewed → partially_paid → paid | overdue | cancelled | refunded
 * Har bir holat o'zgarishi buxgalteriya jurnaliga yozuv bilan birga bo'ladi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const STATUSES = ['draft', 'sent', 'viewed', 'partially_paid', 'paid', 'overdue', 'cancelled', 'refunded'];
const STATUS_LABELS = {
  draft: 'Qoralama', sent: 'Yuborilgan', viewed: 'Ko‘rilgan', partially_paid: 'Qismon to‘langan',
  paid: 'To‘langan', overdue: 'Muddati o‘tgan', cancelled: 'Bekor qilingan', refunded: 'Qaytarilgan',
};

function all(companyId) { return store.collection('invoices').filter(i => i.company_id === companyId); }
function find(companyId, id) {
  const inv = all(companyId).find(i => i.id === id || i.no === id);
  if (!inv) throw new ApiError('Hisob-faktura topilmadi.', 404, 'not_found');
  return inv;
}

/** Haqiqiy holat: to'lov va muddat asosida (eski holatga ishonilmaydi) */
function derivedStatus(inv, today = U.today()) {
  if (inv.status === 'cancelled') return 'cancelled';
  if (inv.status === 'draft') return 'draft';
  const open = U.round(inv.total - inv.paid_amount, 0);
  if (inv.refunded_amount > 0 && open <= 0 && inv.paid_amount - inv.refunded_amount <= 0) return 'refunded';
  if (open <= 0) return 'paid';
  if (inv.due_date < today && inv.status !== 'draft') return 'overdue';
  if (inv.paid_amount > 0) return 'partially_paid';
  return inv.viewed_at ? 'viewed' : (inv.status === 'viewed' ? 'viewed' : 'sent');
}

/**
 * To'langan summa — sanaga bog'liq.
 * Kelajak sanali to'lov/qaytarish hali "amalga oshgan" hisoblanmaydi, shu sababli
 * hujjat qoldig'i jurnaldagi AR/AP qoldig'i (as of sana) bilan bir xil bo'ladi.
 */
function paidAsOf(inv, asOf) {
  const stored = U.round(inv.paid_amount, 0);
  if (!asOf || !Array.isArray(inv.payments)) return stored;
  const hasFuture = inv.payments.some(p => p.date && p.date > asOf) || (inv.refunds || []).some(r => r.date && r.date > asOf);
  if (!hasFuture) return stored;
  const payments = U.sumBy(inv.payments.filter(p => !p.date || p.date <= asOf), p => p.amount);
  const cashRefunds = U.sumBy((inv.refunds || []).filter(r => r.to_cash && (!r.date || r.date <= asOf)), r => r.amount);
  return U.round(Math.max(0, payments - cashRefunds), 0);
}
/** Naqd bo'lmagan (AR hisobiga) kredit-notalar — mijozning qoldig'ini kamaytiradi */
function creditNotesAsOf(inv, asOf) {
  const list = (inv.refunds || []).filter(r => !r.to_cash && (!r.date || !asOf || r.date <= asOf));
  return U.round(U.sumBy(list, r => r.amount), 0);
}
function refundedAsOf(inv, asOf) {
  const stored = U.round(inv.refunded_amount || 0, 0);
  if (!asOf || !Array.isArray(inv.refunds)) return stored;
  if (!inv.refunds.some(r => r.date && r.date > asOf)) return stored;
  return U.round(U.sumBy(inv.refunds.filter(r => !r.date || r.date <= asOf), r => r.amount), 0);
}
/** Hujjat bo'yicha AR qoldig'i (qoldiq = jami − to'lov − kredit-nota) */
function openAsOf(inv, asOf) {
  return U.round(inv.total - paidAsOf(inv, asOf) - creditNotesAsOf(inv, asOf), 0);
}

function decorate(companyId, inv, { light = false, asOf = U.today() } = {}) {
  const party = store.collection('parties').find(p => p.id === inv.customer_id && p.company_id === companyId);
  const today = U.today();
  const paid = paidAsOf(inv, asOf);
  const refunded = refundedAsOf(inv, asOf);
  const open = openAsOf(inv, asOf);
  const base = (paid === U.round(inv.paid_amount, 0) && refunded === U.round(inv.refunded_amount || 0, 0))
    ? inv : { ...inv, paid_amount: paid, refunded_amount: refunded };
  const status = derivedStatus(base, today);
  return {
    ...inv,
    status,
    status_label: STATUS_LABELS[status] || status,
    is_overdue: status === 'overdue',
    overdue_days: status === 'overdue' ? U.daysBetween(inv.due_date, today) : 0,
    customer_name: party ? party.name : '—',
    customer_inn: party ? party.inn : '',
    paid_amount: paid,
    open_amount: open,
    credit_notes: creditNotesAsOf(inv, asOf),
    as_of: asOf,
    paid_percent: inv.total > 0 ? U.clamp(U.round((paid / inv.total) * 100, 1), 0, 100) : 0,
    days_to_due: U.daysBetween(today, inv.due_date),
    items: light ? undefined : inv.items,
  };
}

function list(companyId, { status, customer_id, from, to, search, aging_bucket, sort = 'issue_desc', page = 1, pageSize = 50, include_cancelled = false } = {}) {
  let rows = all(companyId);
  if (!include_cancelled) rows = rows.filter(i => i.status !== 'cancelled');
  if (customer_id) rows = rows.filter(i => i.customer_id === customer_id);
  if (from) rows = rows.filter(i => i.issue_date >= from);
  if (to) rows = rows.filter(i => i.issue_date <= to);
  let out = rows.map(i => decorate(companyId, i, { light: true }));
  if (status && status !== 'all') out = out.filter(i => i.status === status);
  if (status === 'open') out = out.filter(i => ['sent', 'viewed', 'partially_paid', 'overdue'].includes(i.status) && i.open_amount > 0.5);
  if (aging_bucket) out = out.filter(i => i.status !== 'paid' && i.open_amount > 0.5 && bucketOf(i, aging_bucket));
  if (search) {
    const q = U.norm(search);
    out = out.filter(i => U.norm(`${i.no} ${i.customer_name} ${i.notes || ''}`).includes(q));
  }
  const sorters = {
    issue_desc: (a, b) => (a.issue_date < b.issue_date ? 1 : -1),
    issue_asc: (a, b) => (a.issue_date > b.issue_date ? 1 : -1),
    due_asc: (a, b) => (a.due_date > b.due_date ? 1 : -1),
    amount_desc: (a, b) => b.total - a.total,
    overdue_desc: (a, b) => b.overdue_days - a.overdue_days,
  };
  out.sort(sorters[sort] || sorters.issue_desc);
  const pageData = U.paginate(out, { page, pageSize });
  const openRows = out.filter(i => ['sent', 'viewed', 'partially_paid', 'overdue'].includes(i.status));
  return {
    ...pageData, items: pageData.rows,
    summary: {
      total: U.sumBy(out, i => i.total),
      paid: U.sumBy(out, i => i.paid_amount),
      open: U.sumBy(openRows, i => i.open_amount),
      overdue: U.sumBy(out.filter(i => i.status === 'overdue'), i => i.open_amount),
      overdue_count: out.filter(i => i.status === 'overdue').length,
      count: out.length,
    },
  };
}
function bucketOf(inv, key) {
  const today = U.today();
  const od = inv.due_date < today ? U.daysBetween(inv.due_date, today) : 0;
  if (key === 'not_due') return od === 0;
  if (key === '0-30') return od >= 1 && od <= 30;
  if (key === '31-60') return od >= 31 && od <= 60;
  if (key === '61-90') return od >= 61 && od <= 90;
  if (key === '90+') return od > 90;
  return true;
}

/** Qatorlar bo'yicha summalarni hisoblash (yagona formula) */
function computeItems(companyId, items, { discount = 0, vatRate = null, vatEnabled = true } = {}) {
  const settings = ledger.getSettings(companyId);
  const rate = vatRate != null ? U.num(vatRate) : (settings.vat_enabled && vatEnabled ? settings.vat_rate : 0);
  const rows = [];
  let subtotal = 0, discountTotal = 0, taxTotal = 0;
  for (const raw of items || []) {
    const qty = U.num(raw.qty);
    if (!(qty > 0)) throw new ApiError('Mahsulot miqdori noldan katta bo‘lishi kerak.', 400, 'invalid_qty', { item: raw.name });
    const unitPrice = U.amount(raw.unit_price);
    if (!(unitPrice > 0)) {
      throw new ApiError(`«${raw.name || 'Qator'}» uchun narx noldan katta bo‘lishi kerak (narx kiritilmagan).`, 400, 'invalid_price', { item: raw.name, unit_price: unitPrice });
    }
    const gross = Math.round(qty * unitPrice);
    const discPct = U.clamp(U.num(raw.discount_pct || 0), 0, 100);
    const discAmt = Math.round(gross * discPct / 100);
    const lineBase = gross - discAmt;
    const lineRate = raw.tax_rate != null ? U.num(raw.tax_rate) : rate;
    const lineTax = raw.vat_included
      ? Math.round(lineBase - lineBase / (1 + lineRate / 100))
      : Math.round(lineBase * lineRate / 100);
    const lineNet = raw.vat_included ? lineBase - lineTax : lineBase;
    const product = raw.product_id ? store.collection('products').find(p => p.id === raw.product_id && p.company_id === companyId) : null;
    rows.push({
      product_id: raw.product_id || null,
      name: U.str(raw.name || (product ? product.name : ''), { max: 200, required: true, field: 'Mahsulot nomi' }),
      description: U.str(raw.description || '', { max: 500 }),
      qty, unit: U.str(raw.unit || (product ? product.unit : 'dona'), { max: 20 }),
      unit_price: unitPrice, discount_pct: discPct, discount_amount: discAmt,
      tax_rate: lineRate, tax_amount: lineTax, net: lineNet, gross: lineBase, total: lineBase + (raw.vat_included ? 0 : lineTax),
      is_service: product ? !!product.is_service : !!raw.is_service,
    });
    subtotal += lineNet;
    discountTotal += discAmt;
    taxTotal += lineTax;
  }
  // Butun hujjat bo'yicha qo'shimcha chegirma (foiz yoki summa)
  const docDiscPct = U.clamp(U.num(discount.discount_pct || 0), 0, 100);
  const docDiscAmt = discount.discount_amount != null && discount.discount_amount !== ''
    ? U.amount(discount.discount_amount) : Math.round((subtotal + taxTotal) * docDiscPct / 100);
  const grandBase = subtotal - docDiscAmt;
  const finalTax = rate > 0 ? Math.round(grandBase * rate / 100) : U.sumBy(rows, r => r.tax_amount);
  const total = grandBase + finalTax;
  return {
    items: rows, subtotal: U.round(subtotal, 0), discount_total: U.round(discountTotal + docDiscAmt, 0),
    doc_discount: docDiscAmt, tax_total: finalTax, total: U.round(total, 0), vat_rate: rate,
    net_revenue: U.round(grandBase, 0),
  };
}

function nextNumber(companyId) {
  const prefix = (store.collection('companies').find(c => c.id === companyId) || {}).invoice_prefix || 'INV';
  const year = U.today().slice(0, 4);
  const seq = store.nextSeq(`invoice_${companyId}`);
  store.save();
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

function create(companyId, input, user, { meta = {} } = {}) {
  const customer = require('./parties').find(companyId, input.customer_id);
  if (!['customer', 'both'].includes(customer.kind)) {
    throw new ApiError(`«${customer.name}» mijoz sifatida belgilanmagan. Kontragent kartochkasida «Mijoz» turini tanlang.`, 400, 'not_a_customer');
  }
  const issueDate = U.isValidDate(input.issue_date) ? input.issue_date : U.today();
  const dueDate = U.isValidDate(input.due_date) ? input.due_date
    : U.addDays(issueDate, customer.payment_terms_days || 14);
  if (dueDate < issueDate) throw new ApiError('To‘lov muddati hisob-faktura sanasidan oldin bo‘lishi mumkin emas.', 400, 'invalid_due_date');
  const computed = computeItems(companyId, input.items, { discount: input.discount || {}, vatRate: input.vat_rate, vatEnabled: input.vat_enabled !== false });
  if (!computed.items.length) throw new ApiError('Hisob-fakturaga kamida bitta qator qo‘shing.', 400, 'no_items');
  const inv = {
    id: store.uid('inv'),
    company_id: companyId,
    no: U.str(input.no || '', { max: 40 }) || nextNumber(companyId),
    customer_id: customer.id,
    issue_date: issueDate,
    due_date: dueDate,
    currency: 'UZS',
    items: computed.items,
    subtotal: computed.subtotal,
    discount_total: computed.discount_total,
    tax_total: computed.tax_total,
    total: computed.total,
    paid_amount: 0,
    refunded_amount: 0,
    status: 'draft',
    notes: U.str(input.notes || '', { max: 2000 }),
    terms: U.str(input.terms || `To‘lov muddati: ${dueDate}`, { max: 500 }),
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 8) : [],
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    entry_id: null,
    public_token: require('crypto').randomBytes(16).toString('hex'),
    created_by: user ? user.id : null,
    created_at: store.nowISO(),
    sent_at: null, viewed_at: null, paid_date: null, cancelled_at: null,
    payments: [],
    orders: input.orders || null,
  };
  if (all(companyId).some(i => i.no === inv.no)) throw new ApiError(`«${inv.no}» raqami allaqachon mavjud.`, 409, 'duplicate_number');
  store.collection('invoices').push(inv);
  store.save();
  store.touch(companyId);
  require('./companies').bump(companyId, 'invoice');
  require('./audit').log({ company_id: companyId, user, action: 'invoice.create', entity: 'invoice', entity_id: inv.id, summary: `Hisob-faktura yaratildi: ${inv.no} — ${U.fmtMoney(inv.total)} (${customer.name})`, after: { no: inv.no, total: inv.total, customer: customer.name }, meta });
  if (input.issue_now !== false) return issue(companyId, inv.id, user, { meta });
  return decorate(companyId, inv);
}

/** Hujjatni rasmiylashtirish: AR va daromad jurnalga yoziladi */
function issue(companyId, id, user, { meta = {} } = {}) {
  const inv = find(companyId, id);
  if (inv.status !== 'draft') throw new ApiError('Faqat qoralama holatidagi hisob-faktura rasmiylashtiriladi.', 409, 'not_draft');
  if (!inv.items.length) throw new ApiError('Hisob-faktura bo‘sh.', 400, 'no_items');
  const arCode = ledger.roleCode(companyId, 'ar');
  const revenueCodes = new Map();
  const lines = [];
  let netTotal = 0;
  for (const it of inv.items) {
    const revCode = it.is_service ? ledger.roleCode(companyId, 'revenue_service') : ledger.roleCode(companyId, 'revenue');
    revenueCodes.set(revCode, (revenueCodes.get(revCode) || 0) + it.net);
    netTotal += it.net;
  }
  for (const [code, amount] of revenueCodes) {
    if (amount > 0) lines.push({ account: code, credit: amount, description: `Sotuv: ${inv.no}` });
  }
  const vatCode = ledger.roleCode(companyId, 'vat_out');
  if (inv.tax_total > 0) lines.push({ account: vatCode, credit: inv.tax_total, description: `QQS ${inv.no}`, tax_code: 'QQS', tax_amount: inv.tax_total });
  lines.push({ account: arCode, debit: inv.total, party_id: inv.customer_id, description: `Hisob-faktura ${inv.no}` });

  const entry = ledger.postEntry(companyId, {
    date: inv.issue_date, memo: `Hisob-faktura ${inv.no} — ${U.fmtMoney(inv.total)}`.slice(0, 400),
    ref: inv.no, lines, source: { type: 'invoice', id: inv.id }, user,
    attachments: inv.attachments, tags: inv.tags,
  });
  inv.entry_id = entry.id;
  inv.status = 'sent';
  inv.sent_at = store.nowISO();
  store.save();
  store.touch(companyId);

  // Ombor: sotilgan tovar bo'yicha tannarx (COGS) va qoldiq chiqimi
  if (inv.track_stock !== false) {
    for (const it of inv.items) {
      if (!it.product_id || it.is_service) continue;
      const product = require('./inventory').tryProduct(companyId, it.product_id);
      if (!product || product.is_service) continue;
      try {
        require('./inventory').move(companyId, {
          product_id: it.product_id, qty: it.qty, type: 'out', date: inv.issue_date,
          party_id: inv.customer_id, memo: `Sotuv: ${inv.no}`,
          source: { type: 'invoice', id: inv.id }, counter_account: ledger.roleCode(companyId, 'cos'),
          allow_negative: true,
        }, user);
      } catch (e) {
        if (e.code === 'insufficient_stock') {
          store.collection('notifications').push({
            id: store.uid('ntf'), company_id: companyId, type: 'inventory', severity: 'medium',
            title: 'Omborda yetarli qoldiq yo‘q', body: e.message,
            link: { page: 'inventory', params: { product_id: it.product_id } },
            created_at: store.nowISO(), read: false, dedupe_key: `stock_${it.product_id}_${inv.issue_date}`,
          });
        } else { console.error('[invoice] ombor chiqimi:', e.message); }
      }
    }
  }
  require('./audit').log({ company_id: companyId, user, action: 'invoice.issue', entity: 'invoice', entity_id: inv.id, summary: `Hisob-faktura rasmiylashtirildi: ${inv.no} — ${U.fmtMoney(inv.total)}`, after: { status: 'sent', total: inv.total, entry: entry.no }, meta });
  return get(companyId, inv.id);
}

function update(companyId, id, patch, user, { meta = {} } = {}) {
  const inv = find(companyId, id);
  if (['cancelled', 'paid'].includes(inv.status) || (inv.paid_amount > 0 && patch.items)) {
    throw new ApiError('To‘langan yoki bekor qilingan hisob-fakturani tahrirlash mumkin emas. O‘zgartirish uchun qaytarish (kredit-nota) yarating.', 409, 'immutable');
  }
  if (ledger.isPeriodClosed(companyId, U.periodOf(inv.issue_date))) {
    throw new ApiError(`${U.periodLabel(U.periodOf(inv.issue_date))} davri yopilgan — o‘zgartirish uchun davrni ochish kerak.`, 409, 'period_closed');
  }
  const before = { ...inv };
  if (patch.items) {
    const computed = computeItems(companyId, patch.items, { discount: patch.discount || { discount_pct: inv.discount_pct }, vatRate: patch.vat_rate, vatEnabled: patch.vat_enabled !== false });
    if (!computed.items.length) throw new ApiError('Hisob-fakturaga kamida bitta qator qo‘shing.', 400, 'no_items');
    inv.items = computed.items; inv.subtotal = computed.subtotal; inv.discount_total = computed.discount_total;
    inv.tax_total = computed.tax_total; inv.total = computed.total;
  }
  for (const f of ['notes', 'terms']) if (patch[f] !== undefined) inv[f] = U.str(patch[f], { max: 2000 });
  if (patch.issue_date && U.isValidDate(patch.issue_date)) inv.issue_date = patch.issue_date;
  if (patch.due_date && U.isValidDate(patch.due_date)) inv.due_date = patch.due_date;
  if (patch.due_date && patch.due_date < inv.issue_date) throw new ApiError('To‘lov muddati hisob-faktura sanasidan oldin bo‘lishi mumkin emas.', 400, 'invalid_due_date');
  if (patch.tags) inv.tags = patch.tags.slice(0, 8);
  if (patch.attachments) inv.attachments = patch.attachments;
  inv.updated_at = store.nowISO();

  // Rasmiylashtirilgan hujjat o'zgarsa — jurnal yozuvi ham teskari qilinib qayta yoziladi
  if (inv.entry_id && (patch.items || patch.issue_date || patch.due_date)) {
    ledger.reverseEntry(companyId, inv.entry_id, { user, reason: 'Hisob-faktura tahrirlandi' });
    inv.status = 'draft';
    store.save();
    issue(companyId, inv.id, user, { meta });
  } else {
    store.save();
  store.touch(companyId);
  }
  require('./audit').log({
    company_id: companyId, user, action: 'invoice.update', entity: 'invoice', entity_id: id,
    summary: `Hisob-faktura tahrirlandi: ${inv.no}`,
    before: { total: before.total, due_date: before.due_date, items: before.items ? before.items.length : 0 },
    after: { total: inv.total, due_date: inv.due_date, items: inv.items.length }, meta,
  });
  return get(companyId, id);
}

function markViewed(companyId, id, user) {
  const inv = find(companyId, id);
  if (!inv.viewed_at) { inv.viewed_at = store.nowISO(); store.save(); }
  return decorate(companyId, inv);
}

/** To'lovni hisob-fakturaga taqsimlash (payments.js tomonidan chaqiriladi) */
function applyPayment(companyId, invoiceId, { amount, payment_id, date, user }) {
  const inv = find(companyId, invoiceId);
  if (inv.status === 'cancelled') throw new ApiError('Bekor qilingan hisob-fakturaga to‘lov qo‘shilmaydi.', 409, 'cancelled');
  const open = U.round(inv.total - inv.paid_amount, 0);
  if (amount > open + 0.5) {
    throw new ApiError(`To‘lov summasi ochiq qoldiqdan (${U.fmtMoney(open)}) katta. ${U.fmtMoney(amount - open)} ortiqcha summa — avans sifatida qabul qilish uchun summani kamaytiring.`, 409, 'overpayment', { open, amount });
  }
  inv.paid_amount = U.round(inv.paid_amount + amount, 0);
  inv.payments = inv.payments || [];
  inv.payments.push({ payment_id, amount, date });
  if (inv.paid_amount >= inv.total - 0.5) { inv.status = 'paid'; inv.paid_date = date || U.today(); }
  else inv.status = 'partially_paid';
  store.save();
  return inv;
}

function reversePayment(companyId, invoiceId, paymentId) {
  const inv = find(companyId, invoiceId);
  const p = (inv.payments || []).find(x => x.payment_id === paymentId);
  if (!p) return inv;
  inv.paid_amount = U.round(Math.max(0, inv.paid_amount - p.amount), 0);
  inv.payments = inv.payments.filter(x => x.payment_id !== paymentId);
  if (inv.paid_amount <= 0) inv.status = inv.sent_at ? 'sent' : 'draft';
  else inv.status = 'partially_paid';
  store.save();
  return inv;
}

function cancel(companyId, id, reason, user, { meta = {} } = {}) {
  const inv = find(companyId, id);
  if (inv.status === 'cancelled') throw new ApiError('Hisob-faktura allaqachon bekor qilingan.', 409, 'already_cancelled');
  if (inv.paid_amount > 0.5) {
    throw new ApiError(`To‘langan hisob-fakturani bekor qilish mumkin emas (to‘langan: ${U.fmtMoney(inv.paid_amount)}). Avval summani mijozga qaytaring yoki kredit-nota yarating.`, 409, 'has_payments', { paid: inv.paid_amount });
  }
  if (inv.entry_id) ledger.reverseEntry(companyId, inv.entry_id, { user, reason: reason || 'Hisob-faktura bekor qilindi' });
  inv.status = 'cancelled';
  inv.cancelled_at = store.nowISO();
  inv.cancel_reason = U.str(reason || '', { max: 400 });
  inv.cancelled_by = user ? user.id : null;
  store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'invoice.cancel', entity: 'invoice', entity_id: id, summary: `Hisob-faktura bekor qilindi: ${inv.no} — ${U.fmtMoney(inv.total)}${reason ? ` (${reason})` : ''}`, before: { status: before_status(inv) }, after: { status: 'cancelled' }, meta });
  return get(companyId, id);
}
function before_status(inv) { return inv.sent_at ? 'sent' : 'draft'; }

/** Kredit-nota / qaytarish: daromadni kamaytiradi, AR yoki kassa bo'yicha hisob-kitob qiladi */
function refund(companyId, id, { amount, date, to_cash = true, reason = '', user, account }, meta = {}) {
  const inv = find(companyId, id);
  if (inv.status === 'cancelled') throw new ApiError('Bekor qilingan hisob-faktura qaytarilmaydi.', 409, 'cancelled');
  const sum = amount != null ? U.positiveAmount(amount, 'Qaytarish summasi') : U.round(inv.total - inv.refunded_amount, 0);
  const available = U.round((inv.paid_amount - inv.refunded_amount), 0);
  if (to_cash && sum > available + 0.5) {
    throw new ApiError(`Naqd qaytarish summasi qabul qilingan to‘lovdan (${U.fmtMoney(available)}) katta. Summani kamaytiring yoki AR hisobiga qaytarishni tanlang.`, 409, 'refund_exceeds_paid', { available });
  }
  const refundDate = U.isValidDate(date) ? date : U.today();
  const settings = ledger.getSettings(companyId);
  const vatRate = settings.vat_enabled ? settings.vat_rate : (inv.tax_total > 0 ? U.round((inv.tax_total / Math.max(1, inv.subtotal)) * 100, 2) : 0);
  const net = vatRate > 0 ? Math.round(sum / (1 + vatRate / 100)) : sum;
  const vat = sum - net;
  const moneyCode = account || ledger.roleCode(companyId, 'cash');
  const lines = [
    { account: ledger.roleCode(companyId, 'returns'), debit: net, party_id: inv.customer_id, description: `Qaytarish ${inv.no}` },
    ...(vat > 0 ? [{ account: ledger.roleCode(companyId, 'vat_out'), debit: vat, description: `QQS qaytarish ${inv.no}`, tax_code: 'QQS', tax_amount: vat }] : []),
    to_cash
      ? { account: moneyCode, credit: sum, party_id: inv.customer_id, description: `Mijozga qaytarildi ${inv.no}` }
      : { account: ledger.roleCode(companyId, 'ar'), credit: sum, party_id: inv.customer_id, description: `Kredit-nota ${inv.no}` },
  ];
  const entry = ledger.postEntry(companyId, {
    date: refundDate, memo: `Qaytarish (kredit-nota) ${inv.no} — ${U.fmtMoney(sum)}${reason ? `: ${reason}` : ''}`.slice(0, 400),
    ref: inv.no, lines, source: { type: 'invoice_refund', id: inv.id }, user,
  });
  inv.refunded_amount = U.round(inv.refunded_amount + sum, 0);
  if (to_cash) inv.paid_amount = U.round(inv.paid_amount - sum, 0);
  if (inv.refunded_amount >= inv.total - 0.5) inv.status = 'refunded';
  inv.refunds = inv.refunds || [];
  inv.refunds.push({ id: entry.id, amount: sum, date: refundDate, reason, to_cash, entry_no: entry.no });
  store.save();
  store.touch(companyId);
  require('./audit').log({
    company_id: companyId, user, action: 'invoice.refund', entity: 'invoice', entity_id: id,
    summary: `Qaytarish: ${inv.no} — ${U.fmtMoney(sum)}${reason ? ` (${reason})` : ''}`,
    after: { refunded: inv.refunded_amount, entry: entry.no }, meta,
  });
  return get(companyId, id);
}

function get(companyId, id) {
  const inv = find(companyId, id);
  const party = require('./parties').withBalances(require('./parties').find(companyId, inv.customer_id));
  const payments = store.collection('payments').filter(p => p.company_id === companyId && (p.allocations || []).some(a => a.invoice_id === inv.id));
  return {
    ...decorate(companyId, inv),
    customer: party,
    payments: U.sortBy(payments, p => p.date, 'desc'),
    entry: inv.entry_id ? ledger.findEntry(companyId, inv.entry_id) : null,
    journal: inv.entry_id && ledger.findEntry(companyId, inv.entry_id) ? ledger.findEntry(companyId, inv.entry_id).lines.map(l => ({
      ...l, account_name: (ledger.tryAccount(companyId, l.account) || {}).name,
    })) : [],
    documents: (inv.attachments || []).map(d => store.collection('documents').find(x => x.id === d && x.company_id === companyId)).filter(Boolean),
    history: require('./audit').query(companyId, { entity: 'invoice', entity_id: inv.id, limit: 40 }),
  };
}

/** Debitorlik umumiy holati (AR) — jurnal + hujjatlar solishtiriladi */
function receivablesSummary(companyId, { asOf = U.today() } = {}) {
  const arAccounts = ledger.accountsOf(companyId).filter(a => a.role === 'ar');
  const ledgerBalance = U.sumBy(arAccounts, a => ledger.balanceOf(companyId, a.code, { asOf }));
  const today = asOf;
  const week = U.addDays(today, 7);
  const monthEnd = U.periodEnd(U.periodOf(today));
  // Hujjatlar bo'yicha AR: ochiq qoldiqlar + kredit-nota (manfiy qoldiq) ham kiradi
  const allLive = all(companyId).filter(i => !['cancelled', 'draft'].includes(i.status))
    .map(i => decorate(companyId, i, { light: true, asOf }));
  const openInvoices = allLive.filter(i => i.open_amount > 0.5);
  const docsTotal = U.round(U.sumBy(allLive, i => i.open_amount), 0);
  return {
    asOf,
    ledger_balance: U.round(ledgerBalance, 0),
    invoices_open: U.round(docsTotal, 0),
    difference: U.round(docsTotal - ledgerBalance, 0),
    consistent: Math.abs(docsTotal - ledgerBalance) < 1,
    total: U.round(ledgerBalance, 0),
    overdue: U.sumBy(openInvoices.filter(i => i.is_overdue), i => i.open_amount),
    overdue_count: openInvoices.filter(i => i.is_overdue).length,
    due_this_week: U.sumBy(openInvoices.filter(i => i.due_date >= today && i.due_date <= week), i => i.open_amount),
    due_this_month: U.sumBy(openInvoices.filter(i => i.due_date >= today && i.due_date <= monthEnd), i => i.open_amount),
    not_due: U.sumBy(openInvoices.filter(i => i.due_date > today), i => i.open_amount),
    open_count: openInvoices.length,
    customers: require('./parties').aging(companyId, 'ar').parties,
    aging: require('./parties').aging(companyId, 'ar').buckets,
    invoices: U.sortBy(openInvoices, i => i.due_date),
  };
}

/** AI uchun: to'lovni kechiktiruvchi mijozlar */
function latePayers(companyId, limit = 5) {
  const rows = [];
  const parties = store.collection('parties').filter(p => p.company_id === companyId && p.status !== 'archived');
  for (const p of parties) {
    const invs = all(companyId).filter(i => i.customer_id === p.id && i.status !== 'cancelled' && i.status !== 'draft');
    const paid = invs.filter(i => i.paid_amount > 0.5 && i.paid_date);
    const avg = paid.length ? U.mean(paid.map(i => U.daysBetween(i.issue_date, i.paid_date))) : null;
    const overdue = invs.filter(i => i.total - i.paid_amount > 0.5 && i.due_date < U.today());
    const overdueAmount = U.sumBy(overdue, i => i.total - i.paid_amount);
    if (overdue.length || (avg != null && avg > (p.payment_terms_days || 14) + 7)) {
      rows.push({
        party_id: p.id, name: p.name, overdue_count: overdue.length, overdue_amount: overdueAmount,
        avg_payment_days: avg == null ? null : Math.round(avg), terms_days: p.payment_terms_days || 14,
        open_amount: U.sumBy(invs.filter(i => i.total - i.paid_amount > 0.5), i => i.total - i.paid_amount),
        last_payment_date: paid.length ? U.sortBy(paid, i => i.paid_date, 'desc')[0].paid_date : null,
      });
    }
  }
  return rows.sort((a, b) => b.overdue_amount - a.overdue_amount || (b.avg_payment_days || 0) - (a.avg_payment_days || 0)).slice(0, limit);
}

module.exports = {
  STATUSES, STATUS_LABELS, all, list, get, create, update, issue, markViewed, applyPayment, reversePayment,
  cancel, refund, computeItems, derivedStatus, decorate, receivablesSummary, latePayers, find, nextNumber,
};
