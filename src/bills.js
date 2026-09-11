'use strict';
/**
 * BUXAI — Yetkazib beruvchi hisob-fakturalari (bills / xaridlar) va kreditorlik qarz (AP).
 */
const store = require('./store');
const U = require('./util');
const COA = require('./coa');
const ledger = require('./ledger');
const { ApiError } = U;

const STATUSES = ['draft', 'received', 'partially_paid', 'paid', 'overdue', 'cancelled'];
const STATUS_LABELS = { draft: 'Qoralama', received: 'Qabul qilingan', partially_paid: 'Qismon to‘langan', paid: 'To‘langan', overdue: 'Muddati o‘tgan', cancelled: 'Bekor qilingan' };

function all(companyId) { return store.collection('bills').filter(b => b.company_id === companyId); }
function find(companyId, id) {
  const b = all(companyId).find(x => x.id === id || x.no === id);
  if (!b) throw new ApiError('Hisob (bill) topilmadi.', 404, 'not_found');
  return b;
}

function derivedStatus(b, today = U.today()) {
  if (b.status === 'cancelled') return 'cancelled';
  if (b.status === 'draft') return 'draft';
  const open = U.round(b.total - b.paid_amount, 0);
  if (open <= 0) return 'paid';
  if (b.due_date < today) return 'overdue';
  if (b.paid_amount > 0) return 'partially_paid';
  return 'received';
}

/** To'langan summa — sanaga bog'liq (kelajak sanali to'lovlar hisobga olinmaydi) */
function paidAsOf(b, asOf) {
  const stored = U.round(b.paid_amount, 0);
  if (!asOf || !Array.isArray(b.payments)) return stored;
  if (!b.payments.some(p => p.date && p.date > asOf)) return stored;
  return U.round(U.sumBy(b.payments.filter(p => !p.date || p.date <= asOf), p => p.amount), 0);
}
function decorate(companyId, b, { asOf = U.today() } = {}) {
  const party = store.collection('parties').find(p => p.id === b.supplier_id && p.company_id === companyId);
  const today = U.today();
  const paid = paidAsOf(b, asOf);
  const doc = paid === U.round(b.paid_amount, 0) ? b : { ...b, paid_amount: paid };
  const status = derivedStatus(doc, today);
  const open = U.round(b.total - paid, 0);
  return {
    ...b, status, status_label: STATUS_LABELS[status] || status,
    supplier_name: party ? party.name : '—', supplier_inn: party ? party.inn : '',
    paid_amount: paid, open_amount: open, as_of: asOf, is_overdue: status === 'overdue',
    overdue_days: status === 'overdue' ? U.daysBetween(b.due_date, today) : 0,
    days_to_due: U.daysBetween(today, b.due_date),
    paid_percent: b.total > 0 ? U.clamp(U.round((paid / b.total) * 100, 1), 0, 100) : 0,
  };
}

function nextNumber(companyId) {
  const seq = store.nextSeq(`bill_${companyId}`);
  store.save();
  return `BILL-${U.today().slice(0, 4)}-${String(seq).padStart(4, '0')}`;
}

/** Xarid qatorlarini hisoblash: xarajat hisobi yoki ombor (tovar) */
function computeItems(companyId, items, { vatRate = null } = {}) {
  const settings = ledger.getSettings(companyId);
  const rate = vatRate != null ? U.num(vatRate) : (settings.vat_enabled ? settings.vat_rate : 0);
  const rows = [];
  let subtotal = 0, taxTotal = 0, netTotal = 0;
  for (const raw of items || []) {
    const qty = U.num(raw.qty);
    if (!(qty > 0)) throw new ApiError('Miqdor noldan katta bo‘lishi kerak.', 400, 'invalid_qty');
    const unitPrice = U.amount(raw.unit_price);
    if (!(unitPrice > 0)) throw new ApiError(`«${raw.name || 'Qator'}» uchun narx noldan katta bo‘lishi kerak.`, 400, 'invalid_price', { item: raw.name });
    const lineBase = Math.round(qty * unitPrice);
    const lineRate = raw.tax_rate != null ? U.num(raw.tax_rate) : rate;
    const lineTax = raw.vat_included
      ? Math.round(lineBase - lineBase / (1 + lineRate / 100))
      : Math.round(lineBase * lineRate / 100);
    const lineNet = raw.vat_included ? lineBase - lineTax : lineBase;
    const product = raw.product_id ? store.collection('products').find(p => p.id === raw.product_id && p.company_id === companyId) : null;
    const categoryKey = raw.category || (product ? (product.is_service ? 'professional' : 'cos') : 'other');
    const cat = COA.EXPENSE_CATEGORIES.find(c => c.key === categoryKey) || COA.EXPENSE_CATEGORIES.find(c => c.key === 'other');
    rows.push({
      product_id: raw.product_id || null,
      name: U.str(raw.name || (product ? product.name : ''), { max: 200, required: true, field: 'Nomi' }),
      description: U.str(raw.description || '', { max: 500 }),
      qty, unit: U.str(raw.unit || (product ? product.unit : 'dona'), { max: 20 }),
      unit_price: unitPrice,
      tax_rate: lineRate, tax_amount: lineTax, net: lineNet, total: lineBase + (raw.vat_included ? 0 : lineTax),
      expense_account: raw.expense_account || cat.account,
      category: cat.key, category_label: cat.label,
      is_inventory: !!(product && !product.is_service),
      is_service: product ? !!product.is_service : !product,
    });
    subtotal += lineBase; taxTotal += lineTax; netTotal += lineNet;
  }
  return { items: rows, subtotal, tax_total: taxTotal, total: subtotal + taxTotal, net_total: netTotal, vat_rate: rate };
}

function create(companyId, input, user, { meta = {} } = {}) {
  const supplier = require('./parties').find(companyId, input.supplier_id);
  if (!['supplier', 'both'].includes(supplier.kind)) {
    throw new ApiError(`«${supplier.name}» yetkazib beruvchi sifatida belgilanmagan. Kontragent kartochkasida turni o‘zgartiring.`, 400, 'not_a_supplier');
  }
  const issueDate = U.isValidDate(input.issue_date) ? input.issue_date : U.today();
  const dueDate = U.isValidDate(input.due_date) ? input.due_date : U.addDays(issueDate, supplier.payment_terms_days || 14);
  const computed = computeItems(companyId, input.items, { vatRate: input.vat_rate });
  if (!computed.items.length) throw new ApiError('Hisobga kamida bitta qator qo‘shing.', 400, 'no_items');
  const bill = {
    id: store.uid('bil'), company_id: companyId,
    no: U.str(input.no || '', { max: 60 }) || nextNumber(companyId),
    supplier_invoice_no: U.str(input.supplier_invoice_no || '', { max: 60 }),
    supplier_id: supplier.id,
    issue_date: issueDate, due_date: dueDate, currency: 'UZS',
    items: computed.items, subtotal: computed.subtotal, tax_total: computed.tax_total, total: computed.total,
    paid_amount: 0, status: 'draft',
    notes: U.str(input.notes || '', { max: 2000 }),
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 8) : [],
    entry_id: null, created_by: user ? user.id : null, created_at: store.nowISO(),
    payments: [], received_at: null,
  };
  if (all(companyId).some(b => b.no === bill.no)) throw new ApiError(`«${bill.no}» raqami allaqachon mavjud.`, 409, 'duplicate_number');
  store.collection('bills').push(bill);
  store.save();
  store.touch(companyId);
  require('./companies').bump(companyId, 'bill');
  require('./audit').log({ company_id: companyId, user, action: 'bill.create', entity: 'bill', entity_id: bill.id, summary: `Xarid hisobi yaratildi: ${bill.no} — ${U.fmtMoney(bill.total)} (${supplier.name})`, after: { no: bill.no, total: bill.total }, meta });
  if (input.receive_now !== false) return receiveBill(companyId, bill.id, user, { meta });
  return get(companyId, bill.id);
}

/** Xarid hisobini qabul qilish: xarajat/ombor va AP jurnalga yoziladi */
function receiveBill(companyId, id, user, { meta = {} } = {}) {
  const bill = find(companyId, id);
  if (bill.status !== 'draft') throw new ApiError('Faqat qoralama holatidagi hisob qabul qilinadi.', 409, 'not_draft');
  const apCode = ledger.roleCode(companyId, 'ap');
  const lines = [];
  let inventoryTotal = 0;
  const expenseMap = new Map();
  for (const it of bill.items) {
    if (it.is_inventory && it.product_id) {
      inventoryTotal += it.net;
      const inventoryCode = ledger.roleCode(companyId, 'inventory');
      lines.push({ account: inventoryCode, debit: it.net, party_id: bill.supplier_id, description: `${it.name} (${it.qty} ${it.unit})`, product_id: it.product_id, qty: it.qty });
    } else {
      const code = it.expense_account || ledger.roleCode(companyId, 'other_expense');
      expenseMap.set(code, (expenseMap.get(code) || 0) + it.net);
    }
  }
  for (const [code, amount] of expenseMap) lines.push({ account: code, debit: amount, party_id: bill.supplier_id, description: `Xarid: ${bill.no}` });
  if (bill.tax_total > 0) lines.push({ account: ledger.roleCode(companyId, 'vat_in'), debit: bill.tax_total, description: `QQS (kirim) ${bill.no}`, tax_code: 'QQS', tax_amount: bill.tax_total });
  lines.push({ account: apCode, credit: bill.total, party_id: bill.supplier_id, description: `Hisob ${bill.no}` });

  const entry = ledger.postEntry(companyId, {
    date: bill.issue_date, memo: `Xarid hisobi ${bill.no} — ${U.fmtMoney(bill.total)}`.slice(0, 400),
    ref: bill.no, lines, source: { type: 'bill', id: bill.id }, user, attachments: bill.attachments, tags: bill.tags,
  });
  bill.entry_id = entry.id;
  bill.status = 'received';
  bill.received_at = store.nowISO();
  store.save();

  // Omborga kirim (tovar qatorlari)
  for (const it of bill.items) {
    if (!it.is_inventory || !it.product_id) continue;
    try {
      require('./inventory').move(companyId, {
        product_id: it.product_id, qty: it.qty, type: 'in', date: bill.issue_date,
        unit_cost: U.round(it.net / Math.max(1, it.qty), 0), party_id: bill.supplier_id,
        memo: `Xarid: ${bill.no}`, source: { type: 'bill', id: bill.id },
        counter_account: apCode, post_to_ledger: false,
      }, user);
    } catch (e) { console.error('[bill] ombor kirimi:', e.message); }
  }
  require('./audit').log({ company_id: companyId, user, action: 'bill.receive', entity: 'bill', entity_id: bill.id, summary: `Xarid hisobi qabul qilindi: ${bill.no} — ${U.fmtMoney(bill.total)}`, after: { status: 'received', entry: entry.no }, meta });
  return get(companyId, bill.id);
}

function update(companyId, id, patch, user, { meta = {} } = {}) {
  const bill = find(companyId, id);
  if (bill.paid_amount > 0.5) throw new ApiError('To‘langan hisobni tahrirlash mumkin emas.', 409, 'immutable');
  const before = { ...bill };
  if (patch.items) {
    const computed = computeItems(companyId, patch.items, { vatRate: patch.vat_rate });
    bill.items = computed.items; bill.subtotal = computed.subtotal; bill.tax_total = computed.tax_total; bill.total = computed.total;
  }
  for (const f of ['notes', 'supplier_invoice_no']) if (patch[f] !== undefined) bill[f] = U.str(patch[f], { max: 2000 });
  if (U.isValidDate(patch.issue_date)) bill.issue_date = patch.issue_date;
  if (U.isValidDate(patch.due_date)) bill.due_date = patch.due_date;
  if (patch.tags) bill.tags = patch.tags.slice(0, 8);
  if (patch.attachments) bill.attachments = patch.attachments;
  bill.updated_at = store.nowISO();
  if (bill.entry_id && patch.items) {
    ledger.reverseEntry(companyId, bill.entry_id, { user, reason: 'Xarid hisobi tahrirlandi' });
    bill.status = 'draft'; bill.entry_id = null;
    store.save();
    receiveBill(companyId, bill.id, user, { meta });
  } else store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'bill.update', entity: 'bill', entity_id: id, summary: `Xarid hisobi tahrirlandi: ${bill.no}`, before: { total: before.total }, after: { total: bill.total }, meta });
  return get(companyId, id);
}

function applyPayment(companyId, billId, { amount, payment_id, date }) {
  const bill = find(companyId, billId);
  if (bill.status === 'cancelled') throw new ApiError('Bekor qilingan hisobga to‘lov qo‘shilmaydi.', 409, 'cancelled');
  const open = U.round(bill.total - bill.paid_amount, 0);
  if (amount > open + 0.5) throw new ApiError(`To‘lov ochiq qoldiqdan (${U.fmtMoney(open)}) katta.`, 409, 'overpayment', { open, amount });
  bill.paid_amount = U.round(bill.paid_amount + amount, 0);
  bill.payments = bill.payments || [];
  bill.payments.push({ payment_id, amount, date });
  bill.status = bill.paid_amount >= bill.total - 0.5 ? 'paid' : 'partially_paid';
  if (bill.status === 'paid') bill.paid_date = date || U.today();
  store.save();
  return bill;
}
function reversePayment(companyId, billId, paymentId) {
  const bill = find(companyId, billId);
  const p = (bill.payments || []).find(x => x.payment_id === paymentId);
  if (!p) return bill;
  bill.paid_amount = U.round(Math.max(0, bill.paid_amount - p.amount), 0);
  bill.payments = bill.payments.filter(x => x.payment_id !== paymentId);
  bill.status = bill.paid_amount <= 0 ? (bill.received_at ? 'received' : 'draft') : 'partially_paid';
  store.save();
  return bill;
}

function cancel(companyId, id, reason, user, { meta = {} } = {}) {
  const bill = find(companyId, id);
  if (bill.paid_amount > 0.5) throw new ApiError(`To‘langan hisobni bekor qilish mumkin emas (to‘langan: ${U.fmtMoney(bill.paid_amount)}).`, 409, 'has_payments');
  if (bill.entry_id) ledger.reverseEntry(companyId, bill.entry_id, { user, reason: reason || 'Xarid hisobi bekor qilindi' });
  bill.status = 'cancelled';
  bill.cancelled_at = store.nowISO();
  bill.cancel_reason = U.str(reason || '', { max: 400 });
  store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'bill.cancel', entity: 'bill', entity_id: id, summary: `Xarid hisobi bekor qilindi: ${bill.no}`, after: { status: 'cancelled' }, meta });
  return get(companyId, id);
}

function get(companyId, id) {
  const bill = find(companyId, id);
  const supplier = require('./parties').find(companyId, bill.supplier_id);
  const payments = store.collection('payments').filter(p => p.company_id === companyId && (p.allocations || []).some(a => a.bill_id === bill.id));
  const entry = bill.entry_id ? ledger.findEntry(companyId, bill.entry_id) : null;
  return {
    ...decorate(companyId, bill),
    supplier: require('./parties').withBalances(supplier),
    payments: U.sortBy(payments, p => p.date, 'desc'),
    entry, journal: entry ? entry.lines.map(l => ({ ...l, account_name: (ledger.tryAccount(companyId, l.account) || {}).name })) : [],
    documents: (bill.attachments || []).map(d => store.collection('documents').find(x => x.id === d && x.company_id === companyId)).filter(Boolean),
    history: require('./audit').query(companyId, { entity: 'bill', entity_id: bill.id, limit: 40 }),
  };
}

function list(companyId, { status, supplier_id, from, to, search, page = 1, pageSize = 50 } = {}) {
  let rows = all(companyId);
  if (supplier_id) rows = rows.filter(b => b.supplier_id === supplier_id);
  if (from) rows = rows.filter(b => b.issue_date >= from);
  if (to) rows = rows.filter(b => b.issue_date <= to);
  let out = rows.map(b => decorate(companyId, b));
  if (status && status !== 'all') out = status === 'open' ? out.filter(b => ['received', 'partially_paid', 'overdue'].includes(b.status)) : out.filter(b => b.status === status);
  if (search) { const q = U.norm(search); out = out.filter(b => U.norm(`${b.no} ${b.supplier_name} ${b.supplier_invoice_no}`).includes(q)); }
  out = U.sortBy(out, b => b.issue_date, 'desc');
  const pageData = U.paginate(out, { page, pageSize });
  const open = out.filter(b => ['received', 'partially_paid', 'overdue'].includes(b.status));
  return {
    ...pageData, items: pageData.rows,
    summary: {
      total: U.sumBy(out, b => b.total), paid: U.sumBy(out, b => b.paid_amount),
      open: U.sumBy(open, b => b.open_amount),
      overdue: U.sumBy(out.filter(b => b.status === 'overdue'), b => b.open_amount),
      overdue_count: out.filter(b => b.status === 'overdue').length, count: out.length,
    },
  };
}

function payablesSummary(companyId, { asOf = U.today() } = {}) {
  const apAccounts = ledger.accountsOf(companyId).filter(a => a.role === 'ap');
  const ledgerBalance = U.sumBy(apAccounts, a => ledger.balanceOf(companyId, a.code, { asOf }));
  const openBills = all(companyId).filter(b => !['cancelled', 'draft'].includes(b.status))
    .map(b => decorate(companyId, b, { asOf })).filter(b => b.open_amount > 0.5);
  const docsTotal = U.sumBy(openBills, b => b.open_amount);
  const today = asOf, week = U.addDays(today, 7), monthEnd = U.periodEnd(U.periodOf(today));
  return {
    asOf, ledger_balance: U.round(ledgerBalance, 0), bills_open: U.round(docsTotal, 0),
    difference: U.round(docsTotal - ledgerBalance, 0), consistent: Math.abs(docsTotal - ledgerBalance) < 1,
    total: U.round(ledgerBalance, 0),
    overdue: U.sumBy(openBills.filter(b => b.is_overdue), b => b.open_amount),
    overdue_count: openBills.filter(b => b.is_overdue).length,
    due_this_week: U.sumBy(openBills.filter(b => b.due_date >= today && b.due_date <= week), b => b.open_amount),
    due_next_7_days_count: openBills.filter(b => b.due_date >= today && b.due_date <= week).length,
    due_this_month: U.sumBy(openBills.filter(b => b.due_date >= today && b.due_date <= monthEnd), b => b.open_amount),
    open_count: openBills.length,
    suppliers: require('./parties').aging(companyId, 'ap').parties,
    aging: require('./parties').aging(companyId, 'ap').buckets,
    bills: U.sortBy(openBills, b => b.due_date),
  };
}

function upcoming(companyId, days = 7) {
  const today = U.today(), until = U.addDays(today, days);
  return all(companyId)
    .map(b => decorate(companyId, b))
    .filter(b => b.open_amount > 0.5 && ['received', 'partially_paid', 'overdue'].includes(b.status) && b.due_date <= until)
    .sort((a, b) => (a.due_date > b.due_date ? 1 : -1));
}

module.exports = { STATUSES, STATUS_LABELS, all, list, get, create, update, receiveBill, applyPayment, reversePayment, cancel, computeItems, derivedStatus, decorate, payablesSummary, upcoming, find };
