'use strict';
/**
 * BUXAI — Kontragentlar (mijozlar, yetkazib beruvchilar, xodimlar).
 * Har bir kontragentning moliyaviy profili yagona jurnaldan hisoblanadi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const KINDS = [
  { key: 'customer', label: 'Mijoz', role: 'ar' },
  { key: 'supplier', label: 'Yetkazib beruvchi', role: 'ap' },
  { key: 'both', label: 'Mijoz va yetkazib beruvchi', role: 'both' },
  { key: 'employee', label: 'Xodim', role: null },
];

function list(companyId, { kind, search, status = 'active', sort = 'name' } = {}) {
  let rows = store.collection('parties').filter(p => p.company_id === companyId);
  if (status === 'active') rows = rows.filter(p => p.status !== 'archived');
  if (status === 'archived') rows = rows.filter(p => p.status === 'archived');
  if (kind && kind !== 'all') rows = rows.filter(p => p.kind === kind || p.kind === 'both');
  if (search) {
    const q = U.norm(search);
    rows = rows.filter(p => U.norm(`${p.name} ${p.inn || ''} ${p.phone || ''} ${p.email || ''} ${p.contact_person || ''}`).includes(q));
  }
  const withBalance = rows.map(p => withBalances(p));
  if (sort === 'balance') return withBalance.sort((a, b) => (b.balance || 0) - (a.balance || 0));
  if (sort === 'overdue') return withBalance.sort((a, b) => (b.overdue || 0) - (a.overdue || 0));
  return withBalance.sort((a, b) => String(a.name).localeCompare(String(b.name), 'uz'));
}

function find(companyId, id) {
  const p = store.collection('parties').find(x => x.id === id && x.company_id === companyId);
  if (!p) throw new ApiError('Kontragent topilmadi.', 404, 'not_found');
  return p;
}
function tryFind(companyId, id) {
  return store.collection('parties').find(x => x.id === id && x.company_id === companyId) || null;
}

/** Kontragent qoldig'i — yagona jurnaldan (AR/AP hisoblari bo'yicha) */
function ledgerBalance(companyId, partyId, role = 'ar') {
  const accounts = ledger.accountsOf(companyId).filter(a => a.role === role || (role === 'ar' && a.role === 'advance_paid') || (role === 'ap' && a.role === 'advance_received'));
  const codes = new Set(accounts.map(a => a.code));
  let balance = 0;
  for (const e of ledger.entries(companyId)) {
    for (const l of e.lines) {
      if (l.party_id !== partyId || !codes.has(l.account)) continue;
      const acc = ledger.tryAccount(companyId, l.account) || {};
      const isContra = role === 'ap' && acc.role === 'advance_received';
      const normal = acc.normal || (acc.type === 'asset' ? 'debit' : 'credit');
      const signed = normal === 'debit' ? (l.debit - l.credit) : (l.credit - l.debit);
      balance += isContra ? -signed : signed;
    }
  }
  return balance;
}

function withBalances(party) {
  const companyId = party.company_id;
  const ar = ledgerBalance(companyId, party.id, 'ar');
  const ap = ledgerBalance(companyId, party.id, 'ap');
  const invoices = store.collection('invoices').filter(i => i.company_id === companyId && i.customer_id === party.id && !['cancelled', 'draft'].includes(i.status));
  const bills = store.collection('bills').filter(b => b.company_id === companyId && b.supplier_id === party.id && b.status !== 'cancelled');
  const today = U.today();
  const overdueInv = invoices.filter(i => i.total - i.paid_amount > 0 && i.due_date < today);
  const overdueBills = bills.filter(b => b.total - b.paid_amount > 0 && b.due_date < today);
  const isCustomer = party.kind === 'customer' || party.kind === 'both';
  const isSupplier = party.kind === 'supplier' || party.kind === 'both';
  return {
    ...party,
    ar_balance: isCustomer ? ar : 0,
    ap_balance: isSupplier ? ap : 0,
    balance: isCustomer ? ar : isSupplier ? -ap : 0,
    overdue: (isCustomer ? U.sumBy(overdueInv, i => i.total - i.paid_amount) : 0) + (isSupplier ? U.sumBy(overdueBills, b => b.total - b.paid_amount) : 0),
    overdue_count: overdueInv.length + overdueBills.length,
    invoice_count: invoices.length,
    bill_count: bills.length,
    sales_total: U.sumBy(invoices.filter(i => i.status !== 'cancelled'), i => i.total),
    purchase_total: U.sumBy(bills.filter(b => b.status !== 'cancelled'), b => b.total),
    last_activity: latestActivity(companyId, party.id),
  };
}

function latestActivity(companyId, partyId) {
  let last = null;
  for (const e of ledger.entries(companyId)) {
    if (e.lines.some(l => l.party_id === partyId)) { if (!last || e.date > last) last = e.date; }
  }
  return last;
}

function create(companyId, input, user) {
  const kind = KINDS.some(k => k.key === input.kind) ? input.kind : 'customer';
  const party = {
    id: store.uid('pty'),
    company_id: companyId,
    kind,
    name: U.str(input.name, { max: 160, required: true, field: 'Nomi' }),
    contact_person: U.str(input.contact_person || '', { max: 120 }),
    inn: U.str(input.inn || '', { max: 20 }),
    phone: U.str(input.phone || '', { max: 40 }),
    email: U.str(input.email || '', { max: 160 }),
    address: U.str(input.address || '', { max: 250 }),
    bank_account: U.str(input.bank_account || '', { max: 30 }),
    mfo: U.str(input.mfo || '', { max: 10 }),
    bank_name: U.str(input.bank_name || '', { max: 120 }),
    category: U.str(input.category || '', { max: 60 }),
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 8) : [],
    notes: U.str(input.notes || '', { max: 2000 }),
    payment_terms_days: Math.max(0, Math.min(365, Math.round(U.num(input.payment_terms_days ?? 14)))),
    credit_limit: Math.max(0, U.amount(input.credit_limit || 0)),
    status: 'active',
    created_at: store.nowISO(),
    created_by: user ? user.id : null,
  };
  if (party.inn && !U.isINN(party.inn)) throw new ApiError('STIR/INN 9 yoki 14 raqamdan iborat bo‘lishi kerak.', 400, 'invalid_inn', { field: 'inn' });
  if (party.mfo && !U.isMFO(party.mfo)) throw new ApiError('MFO 5 raqamdan iborat bo‘lishi kerak.', 400, 'invalid_mfo', { field: 'mfo' });
  if (party.email && !U.isEmail(party.email)) throw new ApiError('Email manzil noto‘g‘ri.', 400, 'invalid_email');
  if (store.collection('parties').some(p => p.company_id === companyId && p.status !== 'archived' && U.norm(p.name) === U.norm(party.name))) {
    throw new ApiError(`«${party.name}» nomli kontragent allaqachon mavjud. Dublikat yaratmaslik uchun mavjudini tanlang.`, 409, 'duplicate_party');
  }
  store.collection('parties').push(party);
  store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'party.create', entity: 'party', entity_id: party.id, summary: `Kontragent qo‘shildi: ${party.name}`, after: party });
  return party;
}

function update(companyId, id, patch, user) {
  const p = find(companyId, id);
  const before = { ...p };
  const fields = ['name', 'contact_person', 'inn', 'phone', 'email', 'address', 'bank_account', 'mfo', 'bank_name', 'category', 'notes', 'kind', 'status'];
  for (const f of fields) if (patch[f] !== undefined) p[f] = U.str(patch[f], { max: f === 'notes' ? 2000 : 160 });
  if (patch.payment_terms_days !== undefined) p.payment_terms_days = Math.max(0, Math.min(365, Math.round(U.num(patch.payment_terms_days))));
  if (patch.credit_limit !== undefined) p.credit_limit = Math.max(0, U.amount(patch.credit_limit));
  if (patch.tags !== undefined && Array.isArray(patch.tags)) p.tags = patch.tags.slice(0, 8);
  if (p.inn && !U.isINN(p.inn)) throw new ApiError('STIR/INN 9 yoki 14 raqamdan iborat bo‘lishi kerak.', 400, 'invalid_inn');
  if (p.mfo && !U.isMFO(p.mfo)) throw new ApiError('MFO 5 raqamdan iborat bo‘lishi kerak.', 400, 'invalid_mfo');
  p.updated_at = store.nowISO();
  store.save();
  store.touch(companyId);
  const changes = require('./audit').diff(before, p, Object.keys(before).filter(k => !['created_at'].includes(k)));
  require('./audit').log({ company_id: companyId, user, action: 'party.update', entity: 'party', entity_id: id, summary: `Kontragent tahrirlandi: ${p.name}`, before, after: { ...p }, meta: { changes } });
  return p;
}

function archive(companyId, id, user) {
  const p = find(companyId, id);
  const ar = ledgerBalance(companyId, id, 'ar'), ap = ledgerBalance(companyId, id, 'ap');
  if (Math.abs(ar) > 0.5 || Math.abs(ap) > 0.5) {
    throw new ApiError(`Kontragentning yopilmagan qoldig‘i bor (debitorlik ${U.fmtMoney(ar)}, kreditorlik ${U.fmtMoney(ap)}). Avval hisob-kitobni yakunlang.`, 409, 'party_has_balance', { ar, ap });
  }
  p.status = 'archived';
  p.archived_at = store.nowISO();
  store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'party.archive', entity: 'party', entity_id: id, summary: `Kontragent arxivlandi: ${p.name}` });
  return p;
}

/** To'liq moliyaviy profil: yozuvlar, hisob-fakturalar, to'lovlar, qoldiqlar, AI tahlili */
function profile(companyId, id, { limit = 100 } = {}) {
  const party = find(companyId, id);
  const accounts = ledger.accountsOf(companyId);
  const arCodes = new Set(accounts.filter(a => a.role === 'ar' || a.role === 'advance_paid').map(a => a.code));
  const apCodes = new Set(accounts.filter(a => a.role === 'ap' || a.role === 'advance_received').map(a => a.code));
  const entries = [];
  for (const e of ledger.entries(companyId, { includeVoid: true })) {
    for (const l of e.lines) {
      if (l.party_id !== id) continue;
      const isAr = arCodes.has(l.account), isAp = apCodes.has(l.account);
      entries.push({
        id: `${e.id}-${l.account}`, entry_id: e.id, no: e.no, date: e.date, memo: l.description || e.memo,
        account: l.account, account_name: (ledger.tryAccount(companyId, l.account) || {}).name,
        debit: l.debit, credit: l.credit, status: e.status, source: e.source,
        direction: isAr || isAp ? (isAr ? (l.debit - l.credit > 0 ? 'charge' : 'settle') : (l.credit - l.debit > 0 ? 'charge' : 'settle')) : null,
        is_ar: isAr, is_ap: isAp,
      });
    }
  }
  const sorted = U.sortBy(entries, e => `${e.date} ${e.no}`, 'desc').slice(0, limit);
  const invoices = store.collection('invoices').filter(i => i.company_id === companyId && i.customer_id === id);
  const bills = store.collection('bills').filter(b => b.company_id === companyId && b.supplier_id === id);
  const payments = store.collection('payments').filter(p => p.company_id === companyId && p.party_id === id);
  const documents = store.collection('documents').filter(d => d.company_id === companyId && d.party_id === id && !d.deleted_at);
  const monthly = [];
  for (const p of U.lastNPeriods(6)) {
    const inRange = entries.filter(e => e.date >= U.periodStart(p) && e.date <= U.periodEnd(p));
    monthly.push({
      period: p, label: U.MONTHS_SHORT_UZ[Number(p.slice(5, 7)) - 1],
      charged: U.sumBy(inRange.filter(e => e.is_ar || e.is_ap), e => e.is_ar ? e.debit - e.credit : e.credit - e.debit),
      settled: U.sumBy(inRange.filter(e => e.is_ar || e.is_ap), e => e.is_ar ? e.credit - e.debit : e.debit - e.credit),
    });
  }
  return {
    party: withBalances(party),
    entries: sorted,
    invoices: U.sortBy(invoices, i => i.issue_date, 'desc'),
    bills: U.sortBy(bills, b => b.issue_date, 'desc'),
    payments: U.sortBy(payments, p => p.date, 'desc'),
    documents,
    monthly,
    risk: partyRisk(companyId, party, invoices, bills),
  };
}

/** Kontragent risk tahlili — real raqamlarga asoslanadi */
function partyRisk(companyId, party, invoices, bills) {
  const today = U.today();
  const open = invoices.filter(i => i.total - i.paid_amount > 0.5 && i.status !== 'cancelled' && i.status !== 'draft');
  const overdue = open.filter(i => i.due_date < today);
  const paid = invoices.filter(i => i.paid_amount > 0.5 && i.paid_date);
  const avgDays = paid.length ? U.mean(paid.map(i => U.daysBetween(i.issue_date, i.paid_date))) : null;
  const series = monthlySalesSeries(companyId, party.id, 6);
  const meanSales = U.mean(series);
  const sd = U.stddev(series);
  const latest = series[series.length - 1] || 0;
  const drop = meanSales > 0 ? U.round(((latest - meanSales) / meanSales) * 100, 1) : null;
  const concentrationRisk = sd > 0 && meanSales > 0 ? U.round((sd / meanSales) * 100, 0) : null;
  const signals = [];
  if (overdue.length) {
    signals.push({
      severity: overdue.length > 2 ? 'high' : 'medium',
      text: `${overdue.length} ta hisob-faktura muddati o‘tgan — jami ${U.fmtMoney(U.sumBy(overdue, i => i.total - i.paid_amount))}.`,
      evidence: overdue.slice(0, 5).map(i => ({ label: i.no, value: U.fmtMoney(i.total - i.paid_amount), hint: `muddat: ${i.due_date}` })),
    });
  }
  if (avgDays != null && avgDays > (party.payment_terms_days || 14) + 7) {
    signals.push({ severity: 'medium', text: `O‘rtacha to‘lov muddati ${Math.round(avgDays)} kun — shartnomadagi ${party.payment_terms_days || 14} kundan uzoq.`, evidence: [{ label: 'O‘rtacha to‘lov muddati', value: `${Math.round(avgDays)} kun` }, { label: 'Shartnoma muddati', value: `${party.payment_terms_days || 14} kun` }] });
  }
  if (drop != null && drop < -25 && meanSales > 0) {
    signals.push({ severity: 'low', text: `Oxirgi oydagi savdo o‘rtachadan ${Math.abs(drop)}% past.`, evidence: series.map((v, i) => ({ label: U.MONTHS_SHORT_UZ[i], value: U.fmtMoney(v) })) });
  }
  const balance = ledgerBalance(companyId, party.id, 'ar');
  if (party.credit_limit && balance > party.credit_limit) {
    signals.push({ severity: 'high', text: `Kredit limiti oshib ketgan: qoldiq ${U.fmtMoney(balance)}, limit ${U.fmtMoney(party.credit_limit)}.`, evidence: [{ label: 'Qoldiq', value: U.fmtMoney(balance) }, { label: 'Limit', value: U.fmtMoney(party.credit_limit) }] });
  }
  return {
    open_count: open.length,
    overdue_count: overdue.length,
    overdue_amount: U.sumBy(overdue, i => i.total - i.paid_amount),
    open_amount: U.sumBy(open, i => i.total - i.paid_amount),
    avg_payment_days: avgDays == null ? null : Math.round(avgDays),
    monthly_sales: series,
    sales_trend_pct: drop,
    volatility_pct: concentrationRisk,
    signals,
  };
}

function monthlySalesSeries(companyId, partyId, n = 6) {
  const invoices = store.collection('invoices').filter(i => i.company_id === companyId && i.customer_id === partyId && i.status !== 'cancelled' && i.status !== 'draft');
  const bills = store.collection('bills').filter(b => b.company_id === companyId && b.supplier_id === partyId && b.status !== 'cancelled');
  return U.lastNPeriods(n).map(p => {
    const inv = U.sumBy(invoices.filter(i => U.periodOf(i.issue_date) === p), i => i.total);
    const bil = U.sumBy(bills.filter(b => U.periodOf(b.issue_date) === p), b => b.total);
    return inv || bil;
  });
}

/** Aging (qarzdorlik yoshi) tahlili */
function aging(companyId, role = 'ar') {
  const today = U.today();
  const buckets = [
    { key: '0-30', label: '0–30 kun', from: 0, to: 30, amount: 0, count: 0 },
    { key: '31-60', label: '31–60 kun', from: 31, to: 60, amount: 0, count: 0 },
    { key: '61-90', label: '61–90 kun', from: 61, to: 90, amount: 0, count: 0 },
    { key: '90+', label: '90+ kun', from: 91, to: 100000, amount: 0, count: 0 },
    { key: 'not_due', label: 'Muddati kelmagan', from: -100000, to: -1, amount: 0, count: 0 },
  ];
  const docs = role === 'ar'
    ? store.collection('invoices').filter(i => i.company_id === companyId && i.status !== 'cancelled' && i.status !== 'draft')
    : store.collection('bills').filter(b => b.company_id === companyId && b.status !== 'cancelled' && b.status !== 'draft');
  const rows = [];
  for (const d of docs) {
    // Hujjat qoldig'i — sanaga bog'liq (kelajak sanali to'lovlar hisobga olinmaydi),
    // shunda aging jurnaldagi AR/AP qoldig'i bilan bir xil bo'ladi.
    let open = U.round(d.total - d.paid_amount, 0);
    if (Array.isArray(d.payments)) {
      const paid = U.sumBy(d.payments.filter(x => !x.date || x.date <= today), x => x.amount);
      const cashRefunds = role === 'ar' ? U.sumBy((d.refunds || []).filter(r => r.to_cash && (!r.date || r.date <= today)), r => r.amount) : 0;
      const creditNotes = role === 'ar' ? U.sumBy((d.refunds || []).filter(r => !r.to_cash && (!r.date || r.date <= today)), r => r.amount) : 0;
      open = U.round(d.total - Math.max(0, paid - cashRefunds) - creditNotes, 0);
    }
    if (open <= 0.5) continue;
    const overdueDays = U.daysBetween(d.due_date, today);
    const bucketKey = overdueDays <= 0 ? 'not_due' : overdueDays <= 30 ? '0-30' : overdueDays <= 60 ? '31-60' : overdueDays <= 90 ? '61-90' : '90+';
    const party = store.collection('parties').find(p => p.id === (role === 'ar' ? d.customer_id : d.supplier_id));
    rows.push({
      id: d.id, no: d.no, date: d.issue_date, due_date: d.due_date, total: d.total, paid: d.paid_amount, open,
      overdue_days: Math.max(0, overdueDays), bucket: bucketKey,
      party_id: party ? party.id : null, party_name: party ? party.name : '—',
      status: d.status,
    });
    const b = buckets.find(x => x.key === bucketKey);
    b.amount += open; b.count += 1;
  }
  const total = U.sumBy(rows, r => r.open);
  const byParty = U.groupBy(rows, r => r.party_id || 'none');
  const parties = [...byParty.entries()].map(([pid, items]) => ({
    party_id: pid === 'none' ? null : pid,
    party_name: items[0].party_name,
    total: U.sumBy(items, i => i.open),
    overdue: U.sumBy(items.filter(i => i.overdue_days > 0), i => i.open),
    count: items.length,
    max_overdue_days: Math.max(0, ...items.map(i => i.overdue_days)),
  })).sort((a, b) => b.total - a.total);
  return { role, buckets, rows: U.sortBy(rows, r => r.overdue_days, 'desc'), total, parties, overdue_total: U.sumBy(rows.filter(r => r.overdue_days > 0), r => r.open) };
}

module.exports = { KINDS, list, find, tryFind, create, update, archive, profile, ledgerBalance, withBalances, aging, monthlySalesSeries, partyRisk };
