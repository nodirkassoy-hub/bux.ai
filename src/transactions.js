'use strict';
/**
 * BUXAI — Operatsiyalar: kirim, chiqim, o‘tkazma, qaytarish, tuzatish, jurnal yozuvi.
 * Har bir operatsiya buxgalteriya jurnalida debet/kredit juftligini yaratadi.
 * Operatsiya summalari hech qachon «mustaqil» saqlanmaydi — hisobotlar jurnaldan olinadi.
 */
const store = require('./store');
const U = require('./util');
const COA = require('./coa');
const ledger = require('./ledger');
const { ApiError } = U;

const METHODS = [
  { key: 'bank', label: 'Bank o‘tkazmasi' },
  { key: 'cash', label: 'Naqd pul' },
  { key: 'card', label: 'Plastik karta' },
  { key: 'other', label: 'Boshqa' },
];

const TYPES = [
  { key: 'income', label: 'Kirim', direction: 'in' },
  { key: 'expense', label: 'Chiqim', direction: 'out' },
  { key: 'transfer', label: 'O‘tkazma', direction: 'neutral' },
  { key: 'payment', label: 'To‘lov', direction: 'in' },
  { key: 'refund', label: 'Qaytarish', direction: 'out' },
  { key: 'adjustment', label: 'Tuzatish', direction: 'neutral' },
  { key: 'journal', label: 'Jurnal yozuvi', direction: 'neutral' },
];

function all(companyId) { return store.collection('entries').filter(e => e.company_id === companyId); }

/**
 * Operatsiyalar ro'yxati (tranzaksiyalar + teskari mapping).
 * Har bir yozuv `txn` metadata (tur, kontragent, usul, hujjatlar) bilan boyitiladi.
 */
function list(companyId, {
  from, to, type, category, party_id, account, search, status, method, tag,
  min_amount, max_amount, sort = 'date_desc', page = 1, pageSize = 50, include_void = false,
} = {}) {
  let rows = ledger.entries(companyId, { from, to, includeVoid: include_void, includePending: true });
  if (!include_void) rows = rows.filter(e => e.status !== 'void');
  const out = rows.map(e => decorate(companyId, e));
  let filtered = out;
  if (type && type !== 'all') filtered = filtered.filter(r => r.txn_type === type || r.source_type === type);
  if (category) filtered = filtered.filter(r => r.category === category);
  if (party_id) filtered = filtered.filter(r => r.party_id === party_id || r.lines.some(l => l.party_id === party_id));
  if (account) filtered = filtered.filter(r => r.lines.some(l => l.account === account));
  if (method) filtered = filtered.filter(r => r.method === method);
  if (tag) filtered = filtered.filter(r => (r.tags || []).includes(tag));
  if (min_amount != null) filtered = filtered.filter(r => r.total >= min_amount);
  if (max_amount != null) filtered = filtered.filter(r => r.total <= max_amount);
  if (status && status !== 'all') filtered = filtered.filter(r => r.status === status);
  if (search) {
    const q = U.norm(search);
    filtered = filtered.filter(r => U.norm(`${r.no} ${r.memo} ${r.ref} ${r.counterparty_name} ${r.category_label} ${r.lines.map(l => l.description).join(' ')}`).includes(q));
  }
  const dir = sort.endsWith('asc') ? 'asc' : 'desc';
  const key = sort.startsWith('amount') ? (r => r.total) : (r => `${r.date} ${r.created_at}`);
  const sorted = U.sortBy(filtered, key, dir);
  const page_ = U.paginate(sorted, { page, pageSize });
  return {
    ...page_,
    items: page_.rows,
    summary: {
      income: U.sumBy(filtered.filter(r => r.direction === 'in'), r => r.total),
      expense: U.sumBy(filtered.filter(r => r.direction === 'out'), r => r.total),
      net: U.sumBy(filtered.filter(r => r.direction === 'in'), r => r.total) - U.sumBy(filtered.filter(r => r.direction === 'out'), r => r.total),
      count: filtered.length,
    },
  };
}

function decorate(companyId, e) {
  const txn = e.txn || {};
  const accounts = ledger.accountMap(companyId);
  const moneyLine = e.lines.find(l => {
    const a = accounts.get(l.account);
    return a && (a.is_cash || a.is_bank);
  });
  const party = txn.party_id || (e.lines.find(l => l.party_id) || {}).party_id || null;
  const partyRow = party ? store.collection('parties').find(p => p.id === party && p.company_id === companyId) : null;
  const total = U.sumBy(e.lines, l => l.debit);
  // QQS summasi — faqat QQS nazorat hisoblariga (6410/4410) yozilgan qism.
  // (Ilgari barcha qatorlardagi tax_amount qo'shilib, QQS ikki marta hisoblanardi.)
  const vatAmount = U.sumBy(e.lines.filter(l => {
    const a = accounts.get(l.account);
    return (a && (a.role === 'vat_in' || a.role === 'vat_out')) || l.tax_code === 'QQS';
  }), l => (l.debit || 0) + (l.credit || 0));
  const incomeAcc = e.lines.find(l => { const a = accounts.get(l.account); return a && a.type === 'income' && l.credit > 0; });
  const expenseAcc = e.lines.find(l => { const a = accounts.get(l.account); return a && a.type === 'expense' && l.debit > 0; });
  const catAcc = expenseAcc || incomeAcc;
  return {
    id: e.id, no: e.no, date: e.date, period: e.period, memo: e.memo, ref: e.ref,
    status: e.status, created_at: e.created_at, created_by: e.created_by, posted_at: e.posted_at,
    lines: e.lines, total, vat_amount: vatAmount, currency: 'UZS',
    txn_type: txn.type || (e.source.type === 'reversal' ? 'reversal' : e.lines.length === 2 && moneyLine ? 'journal' : 'journal'),
    type_label: (TYPES.find(t => t.key === (txn.type || '')) || { label: 'Jurnal yozuvi' }).label,
    category: txn.category || (catAcc ? catAcc.account : null),
    category_label: txn.category_label || (catAcc && accounts.get(catAcc.account) ? accounts.get(catAcc.account).name : '—'),
    account: moneyLine ? moneyLine.account : null,
    account_name: moneyLine ? (accounts.get(moneyLine.account) || {}).name : null,
    party_id: party, counterparty_name: partyRow ? partyRow.name : (txn.counterparty_name || '—'),
    classification: moneyLine ? (e.lines.find(l => l !== moneyLine) || {}).account : null,
    method: txn.method || (moneyLine ? ((accounts.get(moneyLine.account) || {}).is_cash ? 'cash' : 'bank') : null),
    attachments: e.attachments || txn.attachments || [],
    tags: e.tags || [],
    responsible_user_id: txn.responsible_user_id || e.created_by,
    direction: txn.direction || (moneyLine ? (moneyLine.debit > 0 ? 'in' : 'out') : 'neutral'),
    source_type: e.source.type, source_id: e.source.id,
    reversal_of: e.reversal_of, reversed_by: e.reversed_by, void_reason: e.void_reason || null,
  };
}

// ─────────────────────────── Yaratish / tahrirlash ──────────────────────────

function buildLines(companyId, input) {
  const settings = ledger.getSettings(companyId);
  const type = input.type;
  const entryBased = type === 'journal' || type === 'adjustment'; // qatorlar to'g'ridan-to'g'ri kiritiladi
  const amount = entryBased ? U.num(input.amount || 0) : U.positiveAmount(input.amount, 'Summa');
  const vatRate = U.clamp(U.num(input.vat_rate != null ? input.vat_rate : (settings.vat_enabled ? settings.vat_rate : 0)), 0, 100);
  const vatIncluded = input.vat_included !== false; // standart: summa QQS bilan kiritiladi
  let net = amount, vat = 0;
  if (vatRate > 0) {
    if (vatIncluded) { net = Math.round(amount / (1 + vatRate / 100)); vat = amount - net; }
    else { net = amount; vat = Math.round(amount * vatRate / 100); }
  }
  const total = net + vat;
  const moneyCode = input.account || ledger.roleCode(companyId, input.method === 'cash' ? 'cash' : 'bank');
  const moneyAccount = ledger.getAccount(companyId, moneyCode);
  const lines = [];
  const taxLine = (account, side, amountVat) => {
    if (!amountVat) return;
    lines.push({
      account, [side]: amountVat, tax_code: 'QQS', tax_rate: vatRate, tax_amount: amountVat,
      description: side === 'debit' ? 'QQS hisobga olinadi' : 'QQS hisoblanadi',
    });
  };

  if (type === 'income' || type === 'payment') {
    const cat = COA.INCOME_CATEGORIES.find(c => c.key === input.category) || COA.INCOME_CATEGORIES[0];
    const incomeCode = input.income_account || ledger.roleCode(companyId, cat.key === 'services' ? 'revenue_service' : 'revenue');
    const vatCode = ledger.roleCode(companyId, 'vat_out');
    lines.push({ account: moneyCode, debit: total, party_id: input.party_id || null, description: input.description || 'Kirim', tax_amount: vat, tax_rate: vatRate });
    lines.push({ account: incomeCode, credit: net, party_id: input.party_id || null, description: input.description || 'Daromad', tax_amount: 0, tax_rate: vatRate });
    taxLine(vatCode, 'credit', vat);
  } else if (type === 'expense' || type === 'refund') {
    const cat = COA.EXPENSE_CATEGORIES.find(c => c.key === input.category) || COA.EXPENSE_CATEGORIES.find(c => c.key === 'other');
    const expenseCode = input.expense_account || (type === 'refund' && input.income_account ? input.income_account : ledger.getAccount(companyId, cat.account) ? cat.account : ledger.roleCode(companyId, 'other_expense'));
    const vatCode = ledger.roleCode(companyId, 'vat_in');
    lines.push({ account: expenseCode, debit: net, party_id: input.party_id || null, description: input.description || 'Xarajat', tax_amount: 0, tax_rate: vatRate });
    taxLine(vatCode, 'debit', vat);
    lines.push({ account: moneyCode, credit: total, party_id: input.party_id || null, description: input.description || 'To‘lov', tax_amount: vat, tax_rate: vatRate });
  } else if (type === 'transfer') {
    const to = input.to_account;
    if (!to) throw new ApiError('O‘tkazma uchun qabul qiluvchi hisobni tanlang.', 400, 'missing_to_account', [{ code: 'missing_to_account', message: 'Qabul qiluvchi hisob tanlanmagan.' }]);
    if (to === moneyCode) throw new ApiError('O‘tkazma manbasi va qabul qiluvchi hisob bir xil bo‘lishi mumkin emas.', 400, 'same_account');
    if (!moneyAccount.is_cash && !moneyAccount.is_bank) throw new ApiError('O‘tkazma faqat kassa/bank hisoblari o‘rtasida amalga oshiriladi.', 400, 'invalid_account');
    const toAcc = ledger.getAccount(companyId, to);
    if (!toAcc.is_cash && !toAcc.is_bank) throw new ApiError('Qabul qiluvchi hisob kassa yoki bank hisobi bo‘lishi kerak.', 400, 'invalid_account');
    lines.push({ account: to, debit: total, description: input.description || 'O‘tkazma (kirim)' });
    lines.push({ account: moneyCode, credit: total, description: input.description || 'O‘tkazma (chiqim)' });
  } else if (type === 'journal' || type === 'adjustment') {
    const raw = Array.isArray(input.lines) ? input.lines : [];
    if (!raw.length) throw new ApiError('Jurnal yozuvi uchun kamida 2 qator (debet/kredit) kiritilishi kerak.', 400, 'missing_lines');
    for (const l of raw) {
      lines.push({
        account: String(l.account), debit: Math.round(U.num(l.debit)), credit: Math.round(U.num(l.credit)),
        party_id: l.party_id || input.party_id || null, description: U.str(l.description || input.description || 'Jurnal yozuvi', { max: 300 }),
        tax_code: l.tax_code || null, tax_amount: Math.round(U.num(l.tax_amount || 0)),
      });
    }
  } else {
    throw new ApiError('Operatsiya turi noto‘g‘ri.', 400, 'invalid_type');
  }
  return { lines, net, vat, total, vatRate, moneyCode };
}

function validate(companyId, input) {
  try {
    const built = buildLines(companyId, input);
    const check = ledger.validateEntry(companyId, { date: input.date || U.today(), lines: built.lines, allow_closed_period: input.allow_closed_period });
    return { ok: check.ok, errors: check.errors, totals: check.totals, preview: built };
  } catch (e) {
    if (e instanceof ApiError && e.details) return { ok: false, errors: e.details, totals: { debit: 0, credit: 0 } };
    return { ok: false, errors: [{ code: e.code || 'error', message: e.message }], totals: { debit: 0, credit: 0 } };
  }
}

const REQUIRES_APPROVAL = ['expense', 'refund', 'adjustment', 'journal'];

function create(companyId, input, user, { meta = {} } = {}) {
  if (Array.isArray(input.lines) && input.lines.length && input.type !== 'journal' && input.type !== 'adjustment') {
    throw new ApiError('Maxsus qatorlar (debet/kredit) faqat «Jurnal yozuvi» turida kiritiladi. Boshqa turlar uchun summa va kategoriyadan foydalaning.', 400, 'unexpected_lines');
  }
  const date = input.date || U.today();
  if (!U.isValidDate(date)) throw new ApiError('Sana noto‘g‘ri (YYYY-MM-DD).', 400, 'invalid_date');
  const settings = ledger.getSettings(companyId);
  const built = buildLines(companyId, input);
  const check = ledger.validateEntry(companyId, { date, lines: built.lines, allow_closed_period: !!input.allow_closed_period });
  if (!check.ok) {
    const primary = check.errors.find(e => e.code === 'unbalanced') || check.errors[0];
    throw new ApiError(primary.message, 422, 'invalid_entry', check.errors);
  }
  // Tasdiqlash zarurati: yirik xarajatlar va qo'lda kiritilgan jurnal yozuvlari
  const needsApproval = !user?.is_platform_admin &&
    REQUIRES_APPROVAL.includes(input.type) &&
    built.total >= (settings.approval_threshold || Infinity) &&
    !input.approved &&
    !(user && ['director', 'superadmin'].includes(require('./auth').roleInCompany(user, companyId) || user.role));

  const category = (input.type === 'income' || input.type === 'payment')
    ? (COA.INCOME_CATEGORIES.find(c => c.key === input.category) || COA.INCOME_CATEGORIES[0])
    : (COA.EXPENSE_CATEGORIES.find(c => c.key === input.category) || COA.EXPENSE_CATEGORIES.find(c => c.key === 'other'));
  const catAccountCode = built.lines.find(l => {
    const a = ledger.accountMap(companyId).get(l.account);
    return a && (a.type === 'income' || a.type === 'expense');
  })?.account;

  const entry = ledger.postEntry(companyId, {
    date, memo: U.str(input.description, { max: 400, required: true, field: 'Izoh' }),
    ref: U.str(input.reference || input.ref || '', { max: 100 }),
    lines: built.lines,
    source: { type: input.source?.type || 'manual', id: input.source?.id || null },
    user,
    status: needsApproval ? ledger.ENTRY_STATUS.PENDING : ledger.ENTRY_STATUS.POSTED,
    tags: input.tags,
    attachments: input.attachments,
  });
  entry.txn = {
    type: input.type, category: category.key, category_label: catAccountCode ? (ledger.tryAccount(companyId, catAccountCode) || {}).name : category.label,
    party_id: input.party_id || null,
    method: input.method || ((ledger.tryAccount(companyId, built.moneyCode) || {}).is_cash ? 'cash' : 'bank'),
    direction: input.type === 'income' || input.type === 'payment' ? 'in' : input.type === 'expense' || input.type === 'refund' ? 'out' : 'neutral',
    net: built.net, vat: built.vat, total: built.total, vat_rate: built.vatRate,
    responsible_user_id: input.responsible_user_id || (user ? user.id : null),
    money_account: built.moneyCode, to_account: input.to_account || null,
    attachments: input.attachments || [],
  };
  store.save();

  if (needsApproval) {
    require('./approvals').create(companyId, {
      type: 'transaction', entity_id: entry.id,
      title: `Yirik operatsiyani tasdiqlash: ${U.fmtMoney(built.total)}`,
      summary: `${(TYPES.find(t => t.key === input.type) || {}).label}: ${input.description}`,
      amount: built.total, requested_by: user,
      payload: { entry_id: entry.id, type: input.type },
      impact: `${category.label} hisobiga ${U.fmtMoney(built.total)} yoziladi (sanasi ${date}).`,
    });
  }

  require('./companies').bump(companyId, 'transaction');
  try { require('./notifications').onTransaction(companyId, entry, user); } catch (e) { console.error('[notify]', e.message); }
  require('./audit').log({
    company_id: companyId, user, action: `transaction.create`, entity: 'entry', entity_id: entry.id,
    summary: `${(TYPES.find(t => t.key === input.type) || {}).label} — ${U.fmtMoney(built.total)}: ${input.description}`,
    after: { date, total: built.total, lines: built.lines, memo: entry.memo }, meta,
  });
  return decorate(companyId, entry);
}

function update(companyId, id, patch, user, { meta = {} } = {}) {
  const entry = ledger.findEntry(companyId, id);
  if (!entry) throw new ApiError('Operatsiya topilmadi.', 404, 'not_found');
  if (entry.status === 'void') throw new ApiError('Bekor qilingan operatsiyani tahrirlash mumkin emas. Yangi operatsiya yarating.', 409, 'void_entry');
  if (entry.source.type !== 'manual' && entry.source.type !== 'adjustment') {
    throw new ApiError('Bu operatsiya boshqa hujjatdan (hisob-faktura/to‘lov) yaratilgan. Uni to‘g‘ridan-to‘g‘ri tahrirlash mumkin emas — asl hujjatni tahrirlang.', 409, 'derived_entry', { source: entry.source });
  }
  if (ledger.isPeriodClosed(companyId, entry.period)) {
    throw new ApiError(`${U.periodLabel(entry.period)} davri yopilgan. Tahrirlash uchun davrni qayta oching.`, 409, 'period_closed');
  }
  const before = { ...entry, lines: entry.lines.map(l => ({ ...l })) };
  const base = {
    type: (entry.txn || {}).type || 'journal',
    amount: patch.amount != null ? patch.amount : U.sumBy(entry.lines, l => l.debit),
    date: patch.date || entry.date,
    description: patch.description != null ? patch.description : entry.memo,
    account: patch.account || (entry.txn || {}).money_account || (entry.lines.find(l => { const a = ledger.tryAccount(companyId, l.account); return a && (a.is_cash || a.is_bank); }) || {}).account,
    category: patch.category || (entry.txn || {}).category,
    party_id: patch.party_id !== undefined ? patch.party_id : (entry.txn || {}).party_id,
    method: patch.method || (entry.txn || {}).method,
    reference: patch.reference != null ? patch.reference : entry.ref,
    to_account: patch.to_account || (entry.txn || {}).to_account,
    vat_rate: patch.vat_rate != null ? patch.vat_rate : (entry.txn || {}).vat_rate,
    lines: patch.lines,
    tags: patch.tags !== undefined ? patch.tags : entry.tags,
    attachments: patch.attachments !== undefined ? patch.attachments : entry.attachments,
    income_account: patch.income_account,
    expense_account: patch.expense_account,
  };
  if (base.type === 'transfer' || base.type === 'journal' || base.type === 'adjustment') {
    if (patch.amount != null && base.type === 'transfer') {
      // o'tkazma summasini yangilash
      const built = buildLines(companyId, base);
      entry.lines = built.lines;
    } else if (patch.lines) {
      const built = buildLines(companyId, { ...base, type: base.type, lines: patch.lines });
      entry.lines = built.lines;
    }
  } else {
    const built = buildLines(companyId, base);
    entry.lines = built.lines;
    entry.txn = { ...(entry.txn || {}), net: built.net, vat: built.vat, total: built.total, money_account: built.moneyCode };
  }
  const check = ledger.validateEntry(companyId, { date: base.date, lines: entry.lines, allow_closed_period: true });
  if (!check.ok) {
    Object.assign(entry, before);
    const primary = check.errors.find(e => e.code === 'unbalanced') || check.errors[0];
    throw new ApiError(primary.message, 422, 'invalid_entry', check.errors);
  }
  entry.date = base.date; entry.period = U.periodOf(base.date);
  entry.memo = U.str(base.description, { max: 400, required: true, field: 'Izoh' });
  entry.ref = U.str(base.reference || '', { max: 100 });
  entry.tags = base.tags || []; entry.attachments = base.attachments || [];
  entry.txn = { ...(entry.txn || {}), party_id: base.party_id || null, method: base.method, type: base.type };
  entry.updated_at = store.nowISO();
  entry.updated_by = user ? user.id : null;
  store.save();
  require('./audit').log({
    company_id: companyId, user, action: 'transaction.update', entity: 'entry', entity_id: id,
    summary: `Operatsiya tahrirlandi: ${entry.memo}`,
    before: { total: U.sumBy(before.lines, l => l.debit), date: before.date, memo: before.memo, lines: before.lines },
    after: { total: U.sumBy(entry.lines, l => l.debit), date: entry.date, memo: entry.memo, lines: entry.lines },
    meta,
  });
  return decorate(companyId, entry);
}

function duplicate(companyId, id, user) {
  const entry = ledger.findEntry(companyId, id);
  if (!entry) throw new ApiError('Operatsiya topilmadi.', 404, 'not_found');
  const txn = entry.txn || {};
  return create(companyId, {
    type: txn.type || 'journal',
    amount: txn.total || U.sumBy(entry.lines, l => l.debit),
    date: U.today(),
    description: `${entry.memo} (nusxa)`.slice(0, 400),
    account: txn.money_account, category: txn.category, party_id: txn.party_id, method: txn.method,
    reference: entry.ref, vat_rate: txn.vat_rate,
    lines: txn.type === 'journal' || txn.type === 'adjustment' ? entry.lines.map(l => ({ account: l.account, debit: l.debit, credit: l.credit, description: l.description })) : undefined,
  }, user, { meta: { duplicated_from: id } });
}

function reverse(companyId, id, user, reason, meta = {}) {
  const res = ledger.reverseEntry(companyId, id, { user, reason });
  store.save();
  require('./audit').log({
    company_id: companyId, user, action: 'transaction.reverse', entity: 'entry', entity_id: id,
    summary: `Operatsiya bekor qilindi (teskari yozuv): ${res.original.memo}${reason ? ` — sabab: ${reason}` : ''}`,
    before: { status: 'posted', total: U.sumBy(res.original.lines, l => l.debit) },
    after: { status: 'void', reversal_no: res.reversal.no }, meta,
  });
  return { original: decorate(companyId, res.original), reversal: decorate(companyId, res.reversal) };
}

function get(companyId, id) {
  const e = ledger.findEntry(companyId, id);
  if (!e) throw new ApiError('Operatsiya topilmadi.', 404, 'not_found');
  const row = decorate(companyId, e);
  const accounts = ledger.accountMap(companyId);
  return {
    ...row,
    journal: e.lines.map(l => ({
      account: l.account, account_name: (accounts.get(l.account) || {}).name, account_type: (accounts.get(l.account) || {}).type,
      debit: l.debit, credit: l.credit, description: l.description, party_id: l.party_id,
    })),
    history: require('./audit').query(companyId, { entity: 'entry', entity_id: id, limit: 50 }),
    documents: (e.attachments || []).map(did => store.collection('documents').find(d => d.id === did && d.company_id === companyId)).filter(Boolean),
    reversal: e.reversal_of ? ledger.findEntry(companyId, e.reversal_of) : null,
    reversed_by_entry: e.reversed_by ? ledger.findEntry(companyId, e.reversed_by) : null,
  };
}

/** Kunlik/oylik kirim-chiqim seriyasi (chart uchun) */
function series(companyId, range, group = 'day') {
  const cash = ledger.dailyCashFlow(companyId, range);
  if (group === 'day') return cash.map(r => ({ label: r.date.slice(8) + '.' + r.date.slice(5, 7), date: r.date, in: r.in, out: r.out, net: r.net }));
  const map = new Map();
  for (const r of cash) {
    const key = group === 'week' ? U.startOfWeek(r.date) : r.date.slice(0, 7);
    if (!map.has(key)) map.set(key, { label: key, date: key, in: 0, out: 0, net: 0 });
    const row = map.get(key);
    row.in += r.in; row.out += r.out; row.net += r.net;
  }
  return [...map.values()];
}

/** Kategoriya bo'yicha taqsimot (real jurnal ma'lumotidan) */
function byCategory(companyId, range, kind = 'expense') {
  const moves = ledger.accountMovements(companyId, { from: range.from, to: range.to });
  const rows = [];
  for (const row of moves.values()) {
    const a = row.account;
    if (kind === 'expense' && a.type !== 'expense') continue;
    if (kind === 'income' && a.type !== 'income') continue;
    const amount = a.type === 'expense' ? row.debit - row.credit : row.credit - row.debit;
    if (amount === 0) continue;
    rows.push({ key: a.code, code: a.code, label: a.name, amount, subtype: a.subtype, role: a.role, share: null });
  }
  const total = U.sumBy(rows, r => r.amount);
  for (const r of rows) r.share = U.pct(r.amount, total);
  return { total, rows: U.sortBy(rows, r => r.amount, 'desc') };
}

/** Kontragent bo'yicha taqsimot */
function byParty(companyId, range, role = 'supplier', limit = 20) {
  const entries = ledger.entries(companyId, { from: range.from, to: range.to });
  const map = new Map();
  for (const e of entries) {
    for (const l of e.lines) {
      if (!l.party_id) continue;
      const acc = ledger.tryAccount(companyId, l.account);
      if (!acc) continue;
      const isExpense = acc.type === 'expense';
      const isIncome = acc.type === 'income';
      if (role === 'supplier' && !isExpense) continue;
      if (role === 'customer' && !isIncome) continue;
      const amount = isExpense ? l.debit - l.credit : l.credit - l.debit;
      if (amount <= 0) continue;
      const cur = map.get(l.party_id) || { party_id: l.party_id, amount: 0, count: 0 };
      cur.amount += amount; cur.count += 1;
      map.set(l.party_id, cur);
    }
  }
  const rows = [...map.values()].map(r => {
    const p = store.collection('parties').find(x => x.id === r.party_id);
    return { ...r, name: p ? p.name : '—', kind: p ? p.kind : null };
  }).sort((a, b) => b.amount - a.amount).slice(0, limit);
  const total = U.sumBy(rows, r => r.amount);
  for (const r of rows) r.share = U.pct(r.amount, total);
  return { total, rows };
}

module.exports = { METHODS, TYPES, list, create, update, get, duplicate, reverse, validate, series, byCategory, byParty, decorate, all };
