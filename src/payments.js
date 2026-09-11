'use strict';
/**
 * BUXAI — To'lovlar (kirim/chiqim) va taqsimlash (allocation).
 * To'lov hisob-fakturaga yoki xarid hisobiga bog'lanadi; bog'lanmagan qism avans bo'ladi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const METHODS = [
  { key: 'bank', label: 'Bank o‘tkazmasi' },
  { key: 'cash', label: 'Naqd pul' },
  { key: 'card', label: 'Plastik karta' },
  { key: 'online', label: 'Onlayn to‘lov' },
  { key: 'other', label: 'Boshqa' },
];

function all(companyId) { return store.collection('payments').filter(p => p.company_id === companyId); }
function find(companyId, id) {
  const p = all(companyId).find(x => x.id === id || x.no === id);
  if (!p) throw new ApiError('To‘lov topilmadi.', 404, 'not_found');
  return p;
}
function decorate(companyId, p) {
  const party = store.collection('parties').find(x => x.id === p.party_id && x.company_id === companyId);
  const lines = (p.allocations || []).map(a => {
    if (a.invoice_id) {
      const inv = store.collection('invoices').find(i => i.id === a.invoice_id);
      return { ...a, doc_no: inv ? inv.no : '—', doc_type: 'invoice', doc_total: inv ? inv.total : 0 };
    }
    if (a.bill_id) {
      const b = store.collection('bills').find(x => x.id === a.bill_id);
      return { ...a, doc_no: b ? b.no : '—', doc_type: 'bill', doc_total: b ? b.total : 0 };
    }
    return { ...a, doc_no: '—', doc_type: 'other' };
  });
  return {
    ...p, allocations: lines,
    party_name: party ? party.name : '—',
    direction: p.type === 'incoming' ? 'in' : 'out',
    type_label: p.type === 'incoming' ? 'Kirim to‘lovi' : 'Chiqim to‘lovi',
  };
}

function nextNumber(companyId, type) {
  const seq = store.nextSeq(`payment_${companyId}`);
  store.save();
  return `${type === 'incoming' ? 'PAY-IN' : 'PAY-OUT'}-${U.today().slice(0, 4)}-${String(seq).padStart(4, '0')}`;
}

/**
 * To'lovni yaratish.
 * @param {Object} input {type:'incoming'|'outgoing', party_id, amount, date, method, account, allocations:[{invoice_id|bill_id, amount}], memo, reference, attachments}
 */
function create(companyId, input, user, { meta = {} } = {}) {
  const type = input.type === 'outgoing' ? 'outgoing' : 'incoming';
  const party = require('./parties').find(companyId, input.party_id);
  if (type === 'incoming' && !['customer', 'both'].includes(party.kind)) {
    throw new ApiError(`«${party.name}» mijoz emas — kirim to‘lovini qabul qilish uchun kontragent turini «Mijoz» qilib belgilang.`, 400, 'not_a_customer');
  }
  if (type === 'outgoing' && !['supplier', 'both', 'employee'].includes(party.kind)) {
    throw new ApiError(`«${party.name}» yetkazib beruvchi emas — chiqim to‘lovi uchun turini o‘zgartiring.`, 400, 'not_a_supplier');
  }
  const date = U.isValidDate(input.date) ? input.date : U.today();
  if (ledger.isPeriodClosed(companyId, U.periodOf(date)) && !input.allow_closed_period) {
    throw new ApiError(`${U.periodLabel(U.periodOf(date))} davri yopilgan — to‘lov kiritish uchun davrni qayta ochish kerak.`, 409, 'period_closed');
  }
  const amount = U.positiveAmount(input.amount, 'To‘lov summasi');
  const allocations = (input.allocations || []).map(a => ({
    invoice_id: a.invoice_id || null, bill_id: a.bill_id || null, amount: U.round(U.num(a.amount), 0),
  })).filter(a => a.amount > 0 && (a.invoice_id || a.bill_id));
  const allocated = U.sumBy(allocations, a => a.amount);
  if (allocated > amount + 0.5) {
    throw new ApiError(`Taqsimlangan summa (${U.fmtMoney(allocated)}) to‘lov summasidan (${U.fmtMoney(amount)}) katta.`, 422, 'over_allocated', { allocated, amount });
  }
  // Hujjatlar bo'yicha tekshiruv
  for (const a of allocations) {
    if (a.invoice_id) {
      const inv = require('./invoices').find(companyId, a.invoice_id);
      if (inv.status === 'cancelled') throw new ApiError(`${inv.no} bekor qilingan — to‘lovni taqsimlash mumkin emas.`, 409, 'cancelled_doc');
      if (inv.customer_id !== party.id) throw new ApiError(`${inv.no} boshqa mijozga tegishli (${inv.customer_id === party.id ? '' : 'kontragent mos emas'}).`, 422, 'party_mismatch');
      const open = U.round(inv.total - inv.paid_amount, 0);
      if (a.amount > open + 0.5) throw new ApiError(`${inv.no} uchun ochiq qoldiq ${U.fmtMoney(open)}, lekin ${U.fmtMoney(a.amount)} taqsimlanmoqda.`, 422, 'over_document', { open, amount: a.amount });
    }
    if (a.bill_id) {
      const bill = require('./bills').find(companyId, a.bill_id);
      if (bill.status === 'cancelled') throw new ApiError(`${bill.no} bekor qilingan.`, 409, 'cancelled_doc');
      if (bill.supplier_id !== party.id) throw new ApiError(`${bill.no} boshqa yetkazib beruvchiga tegishli.`, 422, 'party_mismatch');
      const open = U.round(bill.total - bill.paid_amount, 0);
      if (a.amount > open + 0.5) throw new ApiError(`${bill.no} uchun ochiq qoldiq ${U.fmtMoney(open)}, lekin ${U.fmtMoney(a.amount)} taqsimlanmoqda.`, 422, 'over_document', { open, amount: a.amount });
    }
  }
  const accountCode = input.account || ledger.roleCode(companyId, input.method === 'cash' ? 'cash' : 'bank');
  const account = ledger.getAccount(companyId, accountCode);
  if (!account.is_cash && !account.is_bank) throw new ApiError('To‘lov hisobi kassa yoki bank hisobi bo‘lishi kerak.', 400, 'invalid_account', { account: accountCode });
  const arCode = ledger.roleCode(companyId, 'ar');
  const apCode = ledger.roleCode(companyId, 'ap');
  const advanceCode = ledger.roleCode(companyId, type === 'incoming' ? 'advance_received' : 'advance_paid');

  const unallocated = U.round(amount - allocated, 0);
  const lines = [];
  if (type === 'incoming') {
    lines.push({ account: accountCode, debit: amount, party_id: party.id, description: input.memo || 'Mijoz to‘lovi' });
    if (allocated > 0) lines.push({ account: arCode, credit: allocated, party_id: party.id, description: `To‘lov taqsimlandi (${allocations.length} hujjat)` });
    if (unallocated > 0) lines.push({ account: advanceCode, credit: unallocated, party_id: party.id, description: 'Avans (taqsimlanmagan qism)' });
  } else {
    if (allocated > 0) lines.push({ account: apCode, debit: allocated, party_id: party.id, description: `To‘lov taqsimlandi (${allocations.length} hujjat)` });
    if (unallocated > 0) lines.push({ account: advanceCode, debit: unallocated, party_id: party.id, description: 'Berilgan avans' });
    lines.push({ account: accountCode, credit: amount, party_id: party.id, description: input.memo || 'Yetkazib beruvchiga to‘lov' });
  }

  const entry = ledger.postEntry(companyId, {
    date, memo: U.str(input.memo || (type === 'incoming' ? 'Mijoz to‘lovi' : 'Yetkazib beruvchiga to‘lov'), { max: 400, required: true, field: 'Izoh' }),
    ref: U.str(input.reference || '', { max: 100 }),
    lines, source: { type: 'payment', id: null }, user,
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 8) : [],
  });

  const payment = {
    id: store.uid('pay'), company_id: companyId, no: nextNumber(companyId, type), type,
    party_id: party.id, amount, currency: 'UZS', date, period: U.periodOf(date),
    method: METHODS.some(m => m.key === input.method) ? input.method : (account.is_cash ? 'cash' : 'bank'),
    account: accountCode, allocations, unallocated,
    memo: entry.memo, reference: entry.ref, attachments: entry.attachments,
    entry_id: entry.id, status: 'posted',
    created_by: user ? user.id : null, created_at: store.nowISO(),
  };
  store.collection('payments').push(payment);
  entry.source = { type: 'payment', id: payment.id };
  store.save();

  for (const a of allocations) {
    if (a.invoice_id) require('./invoices').applyPayment(companyId, a.invoice_id, { amount: a.amount, payment_id: payment.id, date, user });
    if (a.bill_id) require('./bills').applyPayment(companyId, a.bill_id, { amount: a.amount, payment_id: payment.id, date });
  }
  require('./companies').bump(companyId, 'payment');
  require('./audit').log({
    company_id: companyId, user, action: 'payment.create', entity: 'payment', entity_id: payment.id,
    summary: `${type === 'incoming' ? 'Kirim' : 'Chiqim'} to‘lovi ${payment.no} — ${U.fmtMoney(amount)} (${party.name})`,
    after: { amount, allocations, entry: entry.no }, meta,
  });
  return decorate(companyId, payment);
}

/** To'lovni bekor qilish (teskari yozuv bilan) */
function cancel(companyId, id, reason, user, { meta = {} } = {}) {
  const p = find(companyId, id);
  if (p.status === 'cancelled') throw new ApiError('To‘lov allaqachon bekor qilingan.', 409, 'already_cancelled');
  ledger.reverseEntry(companyId, p.entry_id, { user, reason: reason || 'To‘lov bekor qilindi' });
  for (const a of p.allocations || []) {
    if (a.invoice_id) require('./invoices').reversePayment(companyId, a.invoice_id, p.id);
    if (a.bill_id) require('./bills').reversePayment(companyId, a.bill_id, p.id);
  }
  p.status = 'cancelled';
  p.cancelled_at = store.nowISO();
  p.cancel_reason = U.str(reason || '', { max: 400 });
  store.save();
  require('./audit').log({ company_id: companyId, user, action: 'payment.cancel', entity: 'payment', entity_id: id, summary: `To‘lov bekor qilindi: ${p.no} — ${U.fmtMoney(p.amount)}`, after: { status: 'cancelled' }, meta });
  return decorate(companyId, p);
}

function list(companyId, { type, party_id, from, to, method, search, page = 1, pageSize = 50 } = {}) {
  let rows = all(companyId).filter(p => p.status !== 'cancelled');
  if (type) rows = rows.filter(p => p.type === type);
  if (party_id) rows = rows.filter(p => p.party_id === party_id);
  if (method) rows = rows.filter(p => p.method === method);
  if (from) rows = rows.filter(p => p.date >= from);
  if (to) rows = rows.filter(p => p.date <= to);
  let out = rows.map(p => decorate(companyId, p));
  if (search) { const q = U.norm(search); out = out.filter(p => U.norm(`${p.no} ${p.party_name} ${p.memo} ${p.reference || ''}`).includes(q)); }
  out = U.sortBy(out, p => `${p.date} ${p.created_at}`, 'desc');
  const pageData = U.paginate(out, { page, pageSize });
  return {
    ...pageData, items: pageData.rows,
    summary: {
      incoming: U.sumBy(out.filter(p => p.type === 'incoming'), p => p.amount),
      outgoing: U.sumBy(out.filter(p => p.type === 'outgoing'), p => p.amount),
      count: out.length, unallocated: U.sumBy(out, p => p.unallocated || 0),
    },
  };
}

/** To'lanmagan avanslar (taqsimlanmagan to'lovlar) */
function unallocatedAdvances(companyId) {
  return all(companyId).filter(p => p.status !== 'cancelled' && p.unallocated > 0.5).map(p => decorate(companyId, p));
}

/** Ochilgan hujjatlar (taqsimlash uchun taklif) */
function openDocuments(companyId, partyId, type = 'incoming') {
  if (type === 'incoming') {
    return require('./invoices').all(companyId)
      .filter(i => i.customer_id === partyId && !['cancelled', 'draft'].includes(i.status) && i.total - i.paid_amount > 0.5)
      .map(i => ({ id: i.id, doc_type: 'invoice', no: i.no, date: i.issue_date, due_date: i.due_date, total: i.total, paid: i.paid_amount, open: U.round(i.total - i.paid_amount, 0) }))
      .sort((a, b) => (a.due_date > b.due_date ? 1 : -1));
  }
  return require('./bills').all(companyId)
    .filter(b => b.supplier_id === partyId && !['cancelled', 'draft'].includes(b.status) && b.total - b.paid_amount > 0.5)
    .map(b => ({ id: b.id, doc_type: 'bill', no: b.no, date: b.issue_date, due_date: b.due_date, total: b.total, paid: b.paid_amount, open: U.round(b.total - b.paid_amount, 0) }))
    .sort((a, b) => (a.due_date > b.due_date ? 1 : -1));
}

module.exports = { METHODS, all, list, get: find, create, cancel, decorate, unallocatedAdvances, openDocuments };
