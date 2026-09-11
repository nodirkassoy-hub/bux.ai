'use strict';
/**
 * BUXAI — Hisobotlar markazi.
 * Barcha hisobotlar yagona buxgalteriya jurnalidan (ledger.js) olinadi —
 * hech bir hisobot o'z formulasini ishlatmaydi, shu sababli raqamlar hech qachon
 * moduldan modulga ziddiyatli bo'lmaydi.
 *
 * Har bir muhim raqam uchun `drill_down` — asosiy yozuvlarga o'tish yo'li beriladi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

function drillHint(label, type, params, value = null) {
  return { label, drill: { type, params }, value };
}

// ─────────────────────────────── P&L ────────────────────────────────────────

function pnl(companyId, range, { compare = true } = {}) {
  const cur = ledger.periodSummary(companyId, range);
  const prevRange = U.previousRange(range);
  const prev = compare ? ledger.periodSummary(companyId, prevRange) : null;
  const row = (label, amount, prevAmount, hint, extra = {}) => ({
    label, amount, prev: prevAmount == null ? null : prevAmount,
    change: prevAmount == null ? null : U.growth(amount, prevAmount),
    drill: hint, ...extra,
  });
  const prevFor = (list, code) => {
    const hit = (list || []).find(p => p.code === code);
    return hit ? hit.amount : 0;
  };
  const revenueRows = cur.revenueByAccount.map(r => row(r.name, r.amount, prev ? prevFor(prev.revenueByAccount, r.code) : null,
    { type: 'account', params: { account: r.code, from: range.from, to: range.to } }, { code: r.code, kind: 'revenue' }));
  const expenseRows = cur.expenseByAccount.map(r => row(r.name, r.amount, prev ? prevFor(prev.expenseByAccount, r.code) : null,
    { type: 'account', params: { account: r.code, from: range.from, to: range.to } }, { code: r.code, kind: 'expense' }));
  return {
    report: 'pnl',
    title: 'Foyda va zarar hisoboti (P&L)',
    range,
    compare_range: compare ? prevRange : null,
    sections: [
      {
        key: 'revenue', title: 'Daromadlar', rows: revenueRows, total: cur.revenue,
        prev_total: prev ? prev.revenue : null, drill: { type: 'revenue', params: { from: range.from, to: range.to } },
      },
      { key: 'cos', title: 'Sotilgan tovar tannarxi', rows: expenseRows.filter(r => r.code && String(r.code).startsWith('9') && ['9110', '9120'].includes(r.code)), total: cur.cos, prev_total: prev ? prev.cos : null },
      { key: 'gross', title: 'Yalpi foyda', total: cur.grossProfit, prev_total: prev ? prev.grossProfit : null, margin: cur.grossMargin, is_total: true },
      { key: 'opex', title: 'Operatsion xarajatlar', rows: expenseRows.filter(r => !['9110', '9120'].includes(r.code)), total: cur.totalExpense - cur.cos, prev_total: prev ? prev.totalExpense - prev.cos : null },
      { key: 'other_income', title: 'Boshqa daromadlar', total: cur.otherIncome, prev_total: prev ? prev.otherIncome : null },
      { key: 'operating', title: 'Operatsion foyda (EBIT)', total: cur.operatingProfit + cur.otherIncome - cur.otherExpense, prev_total: prev ? prev.operatingProfit + prev.otherIncome - prev.otherExpense : null, is_total: true },
      { key: 'fin', title: 'Moliyaviy xarajatlar', total: cur.finExpense, prev_total: prev ? prev.finExpense : null },
      { key: 'pbt', title: 'Soliqgacha foyda', total: cur.profitBeforeTax, prev_total: prev ? prev.profitBeforeTax : null, is_total: true },
      { key: 'tax', title: 'Foyda solig‘i', total: cur.incomeTax, prev_total: prev ? prev.incomeTax : null },
      { key: 'net', title: 'Sof foyda', total: cur.netProfit, prev_total: prev ? prev.netProfit : null, is_total: true, margin: cur.netMargin },
    ],
    totals: {
      revenue: cur.revenue, cos: cur.cos, grossProfit: cur.grossProfit, opex: cur.opex + cur.otherExpense,
      operatingProfit: cur.operatingProfit, netProfit: cur.netProfit, grossMargin: cur.grossMargin, netMargin: cur.netMargin,
      totalExpense: cur.totalExpense,
    },
    previous: prev ? { revenue: prev.revenue, cos: prev.cos, grossProfit: prev.grossProfit, totalExpense: prev.totalExpense, netProfit: prev.netProfit } : null,
    entry_count: cur.entryCount,
    has_data: cur.entryCount > 0,
    notes: cur.entryCount === 0 ? ['Bu davrda buxgalteriya yozuvlari mavjud emas — hisobot bo‘sh.'] : [],
  };
}

// ──────────────────────────── Balance Sheet ─────────────────────────────────

function balanceSheetReport(companyId, asOf, { compare = false } = {}) {
  const bs = ledger.balanceSheet(companyId, asOf);
  const appendDrill = (items) => items.map(i => ({
    ...i,
    drill: i.code && i.code !== '—' ? { type: 'account', params: { account: i.code, to: asOf } } : null,
  }));
  const assets = appendDrill(bs.assets);
  const liabilities = appendDrill(bs.liabilities);
  const equity = appendDrill(bs.equity);
  let prevBs = null;
  if (compare) {
    const prevDate = U.addDays(asOf, -1);
    const p = ledger.balanceSheet(companyId, U.isValidDate(prevDate) ? prevDate : asOf);
    prevBs = { totalAssets: p.totalAssets, totalLiabilities: p.totalLiabilities, totalEquity: p.totalEquity };
  }
  return {
    report: 'balance_sheet',
    title: 'Buxgalteriya balansi',
    asOf,
    assets: { title: 'AKTIVLAR', rows: assets, total: bs.totalAssets, prev_total: prevBs ? prevBs.totalAssets : null },
    liabilities: { title: 'MAJBURIYATLAR', rows: liabilities, total: bs.totalLiabilities, prev_total: prevBs ? prevBs.totalLiabilities : null },
    equity: { title: 'KAPITAL', rows: equity, total: bs.totalEquity, prev_total: prevBs ? prevBs.totalEquity : null },
    totals: {
      assets: bs.totalAssets, liabilities: bs.totalLiabilities, equity: bs.totalEquity,
      liabilities_and_equity: bs.totalLiabilities + bs.totalEquity, difference: bs.difference,
    },
    check: {
      balanced: bs.balanced,
      message: bs.balanced ? 'Balans tenglamasi bajarilgan: Aktivlar = Majburiyatlar + Kapital.' :
        `Diqqat: aktivlar va majburiyat+kapital o‘rtasida ${U.fmtMoney(bs.difference)} farq bor. Xato Radar bu muammoni aniqlaydi.`,
    },
    has_data: bs.assets.length + bs.liabilities.length + bs.equity.length > 0,
  };
}

// ─────────────────────────────── Cash Flow ──────────────────────────────────

function cashFlowReport(companyId, range) {
  const cf = ledger.cashFlowStatement(companyId, range);
  const byCategory = (cat) => {
    const map = new Map();
    for (const m of cf.moves.filter(x => x.category === cat)) {
      const key = m.counterparty_account || '—';
      const acc = ledger.tryAccount(companyId, key);
      const label = acc ? `${acc.code} ${acc.name}` : m.category_label;
      const cur = map.get(label) || { label, key, amount: 0, count: 0 };
      cur.amount += m.amount; cur.count += 1;
      map.set(label, cur);
    }
    return [...map.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 20).map(r => ({
      ...r, drill: { type: 'account', params: { account: r.key, from: range.from, to: range.to } },
    }));
  };
  return {
    report: 'cash_flow',
    title: 'Pul oqimi hisoboti',
    range,
    opening: cf.opening,
    sections: [
      { key: 'operating', title: 'Operatsion faoliyat', rows: byCategory('operating'), total: cf.operating },
      { key: 'investing', title: 'Investitsiya faoliyati', rows: byCategory('investing'), total: cf.investing },
      { key: 'financing', title: 'Moliyaviy faoliyat', rows: byCategory('financing'), total: cf.financing },
    ],
    net: cf.net, closing: cf.closing,
    movements: cf.moves.slice(0, 300),
    has_data: cf.moves.length > 0,
    notes: cf.moves.length === 0 ? ['Bu davrda kassa/bank harakati yo‘q.'] : [],
  };
}

// ─────────────────────────── Trial Balance / GL ─────────────────────────────

function trialBalanceReport(companyId, range) {
  const tb = ledger.trialBalance(companyId, range);
  return {
    report: 'trial_balance',
    title: 'Aylanma-saldov vedomostи (Trial Balance)',
    range,
    rows: tb.rows.map(r => ({ ...r, drill: { type: 'account', params: { account: r.code, from: range.from, to: range.to } } })),
    totals: tb.totals,
    check: { balanced: tb.balanced, message: tb.balanced ? 'Debet va kredit aylanmalari teng.' : `Debet va kredit farqi: ${U.fmtMoney(tb.totals.debit - tb.totals.credit)}` },
    has_data: tb.rows.length > 0,
  };
}

function generalLedgerReport(companyId, { account, from, to }) {
  if (!account) {
    // Barcha hisoblar bo'yicha qisqa vedomost
    const moves = ledger.accountMovements(companyId, { from, to });
    const rows = [...moves.values()].map(r => ({
      code: r.account.code, name: r.account.name, type: r.account.type,
      opening: r.opening, debit: r.debit, credit: r.credit, closing: r.closing,
      drill: { type: 'account', params: { account: r.account.code, from, to } },
    })).filter(r => r.opening || r.debit || r.credit).sort((a, b) => a.code.localeCompare(b.code));
    return { report: 'general_ledger', title: 'Bosh daftar (umumiy)', range: { from, to }, rows, account: null, has_data: rows.length > 0 };
  }
  const gl = ledger.accountLedger(companyId, account, { from, to });
  const parties = new Map(store.collection('parties').filter(p => p.company_id === companyId).map(p => [p.id, p.name]));
  return {
    report: 'account_ledger',
    title: `Hisob daftari: ${gl.account.code} — ${gl.account.name}`,
    range: { from, to },
    account: { code: gl.account.code, name: gl.account.name, type: gl.account.type, normal: gl.account.normal },
    opening: gl.opening, closing: gl.closing,
    totals: gl.totals,
    rows: gl.rows.map(r => ({ ...r, party_name: r.party_id ? parties.get(r.party_id) : null })),
    has_data: gl.rows.length > 0,
  };
}

// ─────────────────────── Sotuv / Xarajat hisobotlari ────────────────────────

function salesReport(companyId, range) {
  const invoices = store.collection('invoices').filter(i => i.company_id === companyId && i.status !== 'cancelled' && i.status !== 'draft' && i.issue_date >= range.from && i.issue_date <= range.to);
  const byCustomer = new Map();
  const byProduct = new Map();
  const byMonth = new Map();
  for (const inv of invoices) {
    const party = store.collection('parties').find(p => p.id === inv.customer_id);
    const c = byCustomer.get(inv.customer_id) || { party_id: inv.customer_id, name: party ? party.name : '—', amount: 0, paid: 0, open: 0, count: 0 };
    c.amount += inv.total; c.paid += inv.paid_amount; c.open += Math.max(0, inv.total - inv.paid_amount); c.count += 1;
    byCustomer.set(inv.customer_id, c);
    for (const it of inv.items || []) {
      const key = it.product_id || it.name;
      const p = byProduct.get(key) || { product_id: it.product_id, name: it.name, qty: 0, amount: 0, cost: 0, count: 0 };
      p.qty += it.qty; p.amount += it.net; p.count += 1;
      if (it.product_id) {
        const prod = require('./inventory').tryProduct(companyId, it.product_id);
        if (prod) {
          const ev = require('./inventory').evaluate(companyId, prod.id);
          p.cost += ev.avg_cost * it.qty;
        }
      }
      byProduct.set(key, p);
    }
    const m = U.periodOf(inv.issue_date);
    const mo = byMonth.get(m) || { period: m, label: U.periodLabel(m), amount: 0, count: 0 };
    mo.amount += inv.total; mo.count += 1;
    byMonth.set(m, mo);
  }
  const customers = [...byCustomer.values()].sort((a, b) => b.amount - a.amount).map(c => ({ ...c, drill: { type: 'party_invoices', params: { party_id: c.party_id, from: range.from, to: range.to } } }));
  const products = [...byProduct.values()].map(p => ({ ...p, cost: U.round(p.cost, 0), profit: U.round(p.amount - p.cost, 0), margin: p.amount ? U.round(((p.amount - p.cost) / p.amount) * 100, 1) : null, drill: { type: 'product_sales', params: { product_id: p.product_id, from: range.from, to: range.to } } })).sort((a, b) => b.amount - a.amount);
  const total = U.sumBy(invoices, i => i.total);
  const ledgerRevenue = ledger.periodSummary(companyId, range).revenue;
  return {
    report: 'sales',
    title: 'Sotuv hisoboti',
    range,
    summary: {
      total, count: invoices.length,
      paid: U.sumBy(invoices, i => i.paid_amount),
      open: U.sumBy(invoices, i => i.total - i.paid_amount),
      average: invoices.length ? Math.round(total / invoices.length) : 0,
      ledger_revenue: ledgerRevenue,
      consistent: Math.abs(U.round(total - ledgerRevenue, 0)) < 1,
    },
    customers, products, by_month: U.sortBy([...byMonth.values()], m => m.period),
    invoices: U.sortBy(invoices, i => i.issue_date, 'desc').slice(0, 200).map(i => ({
      id: i.id, no: i.no, date: i.issue_date, due_date: i.due_date, total: i.total, paid: i.paid_amount,
      customer: (store.collection('parties').find(p => p.id === i.customer_id) || {}).name || '—',
      status: require('./invoices').derivedStatus(i),
    })),
    has_data: invoices.length > 0,
    notes: invoices.length && Math.abs(total - ledgerRevenue) >= 1
      ? [`Diqqat: hisob-fakturalar jami (${U.fmtMoney(total)}) va jurnaldagi daromad (${U.fmtMoney(ledgerRevenue)}) farq qiladi — bu odatda QQSsiz/qaytarishlar bilan bog‘liq. Xato Radar tekshiradi.`] : [],
  };
}

function expenseReport(companyId, range) {
  const byCategory = require('./transactions').byCategory(companyId, range, 'expense');
  const byParty = require('./transactions').byParty(companyId, range, 'supplier');
  const entries = ledger.entries(companyId, range);
  const expenseLines = [];
  const expenseCodes = new Set(ledger.accountsOf(companyId).filter(a => a.type === 'expense').map(a => a.code));
  for (const e of entries) {
    for (const l of e.lines) {
      if (!expenseCodes.has(l.account)) continue;
      const amount = l.debit - l.credit;
      if (amount === 0) continue;
      expenseLines.push({ entry_id: e.id, no: e.no, date: e.date, account: l.account, account_name: (ledger.tryAccount(companyId, l.account) || {}).name, amount, memo: l.description || e.memo });
    }
  }
  const byMonth = new Map();
  for (const l of expenseLines) {
    const m = U.periodOf(l.date);
    byMonth.set(m, (byMonth.get(m) || 0) + l.amount);
  }
  return {
    report: 'expenses',
    title: 'Xarajatlar hisoboti',
    range,
    total: byCategory.total,
    by_category: byCategory.rows.map(r => ({ ...r, drill: { type: 'account', params: { account: r.code, from: range.from, to: range.to } } })),
    by_supplier: byParty.rows.map(r => ({ ...r, drill: { type: 'party_bills', params: { party_id: r.party_id, from: range.from, to: range.to } } })),
    by_month: [...byMonth.entries()].map(([period, amount]) => ({ period, label: U.periodLabel(period), amount })).sort((a, b) => a.period.localeCompare(b.period)),
    rows: U.sortBy(expenseLines, l => l.amount, 'desc').slice(0, 500),
    has_data: expenseLines.length > 0,
  };
}

// ───────────────────── Debitor / Kreditor hisobotlari ───────────────────────

function receivablesReport(companyId, { asOf = U.today() } = {}) {
  const r = require('./parties').aging(companyId, 'ar');
  const summary = require('./invoices').receivablesSummary(companyId, { asOf });
  return {
    report: 'receivables',
    title: 'Debitorlik qarzdorligi hisoboti',
    asOf,
    summary: {
      total: summary.total, overdue: summary.overdue, not_due: summary.not_due,
      due_this_week: summary.due_this_week, due_this_month: summary.due_this_month,
      ledger_balance: summary.ledger_balance, difference: summary.difference, consistent: summary.consistent,
    },
    aging: r.buckets,
    parties: r.parties.map(p => ({ ...p, drill: { type: 'party_invoices', params: { party_id: p.party_id } } })),
    invoices: summary.invoices.map(i => ({
      id: i.id, no: i.no, customer: i.customer_name, issue_date: i.issue_date, due_date: i.due_date,
      total: i.total, paid: i.paid_amount, open: i.open_amount, overdue_days: i.overdue_days,
    })),
    has_data: summary.invoices.length > 0,
  };
}

function payablesReport(companyId, { asOf = U.today() } = {}) {
  const r = require('./parties').aging(companyId, 'ap');
  const summary = require('./bills').payablesSummary(companyId, { asOf });
  return {
    report: 'payables',
    title: 'Kreditorlik qarzdorligi hisoboti',
    asOf,
    summary: {
      total: summary.total, overdue: summary.overdue, due_this_week: summary.due_this_week,
      due_this_month: summary.due_this_month, ledger_balance: summary.ledger_balance,
      difference: summary.difference, consistent: summary.consistent,
    },
    aging: r.buckets,
    suppliers: r.parties.map(p => ({ ...p, drill: { type: 'party_bills', params: { party_id: p.party_id } } })),
    bills: summary.bills.map(b => ({
      id: b.id, no: b.no, supplier: b.supplier_name, issue_date: b.issue_date, due_date: b.due_date,
      total: b.total, paid: b.paid_amount, open: b.open_amount, overdue_days: b.overdue_days,
    })),
    has_data: summary.bills.length > 0,
  };
}

function bankReport(companyId, range) {
  const accounts = ledger.accountsOf(companyId).filter(a => a.is_cash || a.is_bank).map(a => {
    const mv = ledger.accountMovements(companyId, { from: range.from, to: range.to, codes: [a.code] }).get(a.code);
    return {
      code: a.code, name: a.name, kind: a.is_cash ? 'Kassa' : 'Bank',
      opening: mv ? mv.opening : 0, incoming: mv ? mv.debit : 0, outgoing: mv ? mv.credit : 0,
      closing: mv ? mv.closing : 0,
      drill: { type: 'account', params: { account: a.code, from: range.from, to: range.to } },
    };
  });
  const imports = require('./banking').importsList(companyId, {});
  const unmatched = store.collection('bankRows').filter(r => r.company_id === companyId && r.status === 'unmatched');
  return {
    report: 'bank',
    title: 'Kassa va bank hisoboti',
    range,
    accounts,
    totals: {
      opening: U.sumBy(accounts, a => a.opening), incoming: U.sumBy(accounts, a => a.incoming),
      outgoing: U.sumBy(accounts, a => a.outgoing), closing: U.sumBy(accounts, a => a.closing),
    },
    imports: imports.slice(0, 20),
    reconciliation: { unmatched_rows: unmatched.length, unmatched_amount: U.sumBy(unmatched, r => r.amount) },
    has_data: accounts.some(a => a.opening || a.incoming || a.outgoing),
  };
}

function inventoryReport(companyId) {
  const valuation = require('./inventory').reconciliation(companyId);
  const moves = require('./inventory').stockMoves(companyId, { limit: 300 });
  return {
    report: 'inventory',
    title: 'Ombor (tovar-moddiy zaxiralar) hisoboti',
    valuation: {
      total_value: valuation.total_value, total_skus: valuation.total_skus, total_units: valuation.total_units,
      ledger_value: valuation.ledger_value, difference: valuation.difference, consistent: valuation.consistent,
    },
    by_category: valuation.by_category,
    by_warehouse: valuation.by_warehouse,
    low_stock: valuation.low_stock,
    negative_stock: valuation.negative_stock,
    products: require('./inventory').list(companyId, { active: true }).map(p => ({
      id: p.id, name: p.name, sku: p.sku, unit: p.unit, stock: p.stock, avg_cost: p.avg_cost,
      value: p.stock_value, sale_price: p.sale_price, min_stock: p.min_stock,
      is_low: p.is_low, is_negative: p.is_negative,
      drill: { type: 'product_moves', params: { product_id: p.id } },
    })),
    moves: moves.map(m => ({
      id: m.id, date: m.date, product_name: m.product_name, type: m.type, type_label: (require('./inventory').MOVE_TYPES[m.type] || {}).label,
      qty: m.qty, unit_cost: m.unit_cost, total_cost: m.total_cost, memo: m.memo, warehouse: m.warehouse,
    })),
    has_data: valuation.total_skus > 0,
  };
}

function customerReport(companyId, range) {
  const parties = store.collection('parties').filter(p => p.company_id === companyId && ['customer', 'both'].includes(p.kind) && p.status !== 'archived');
  const rows = parties.map(p => {
    const invoices = store.collection('invoices').filter(i => i.company_id === companyId && i.customer_id === p.id && i.status !== 'cancelled' && i.status !== 'draft');
    const inRange = invoices.filter(i => i.issue_date >= range.from && i.issue_date <= range.to);
    const ar = require('./parties').ledgerBalance(companyId, p.id, 'ar');
    const paid = invoices.filter(i => i.paid_date);
    return {
      party_id: p.id, name: p.name, inn: p.inn, kind: p.kind,
      sales: U.sumBy(inRange, i => i.total), invoice_count: inRange.length,
      total_sales: U.sumBy(invoices, i => i.total),
      open: ar, credit_limit: p.credit_limit || 0,
      overdue: U.sumBy(invoices.filter(i => i.total - i.paid_amount > 0.5 && i.due_date < U.today()), i => i.total - i.paid_amount),
      avg_payment_days: paid.length ? Math.round(U.mean(paid.map(i => U.daysBetween(i.issue_date, i.paid_date)))) : null,
      drill: { type: 'party_invoices', params: { party_id: p.id, from: range.from, to: range.to } },
    };
  }).filter(r => r.total_sales || r.open).sort((a, b) => b.sales - a.sales);
  return {
    report: 'customers', title: 'Mijozlar hisoboti', range, rows,
    totals: { sales: U.sumBy(rows, r => r.sales), open: U.sumBy(rows, r => r.open), overdue: U.sumBy(rows, r => r.overdue), count: rows.length },
    has_data: rows.length > 0,
  };
}

function supplierReport(companyId, range) {
  const parties = store.collection('parties').filter(p => p.company_id === companyId && ['supplier', 'both'].includes(p.kind) && p.status !== 'archived');
  const rows = parties.map(p => {
    const bills = store.collection('bills').filter(b => b.company_id === companyId && b.supplier_id === p.id && b.status !== 'cancelled' && b.status !== 'draft');
    const inRange = bills.filter(b => b.issue_date >= range.from && b.issue_date <= range.to);
    const ap = require('./parties').ledgerBalance(companyId, p.id, 'ap');
    return {
      party_id: p.id, name: p.name, inn: p.inn,
      purchases: U.sumBy(inRange, b => b.total), bill_count: inRange.length,
      total_purchases: U.sumBy(bills, b => b.total),
      open: ap,
      overdue: U.sumBy(bills.filter(b => b.total - b.paid_amount > 0.5 && b.due_date < U.today()), b => b.total - b.paid_amount),
      drill: { type: 'party_bills', params: { party_id: p.id, from: range.from, to: range.to } },
    };
  }).filter(r => r.total_purchases || r.open).sort((a, b) => b.purchases - a.purchases);
  return {
    report: 'suppliers', title: 'Yetkazib beruvchilar hisoboti', range, rows,
    totals: { purchases: U.sumBy(rows, r => r.purchases), open: U.sumBy(rows, r => r.open), overdue: U.sumBy(rows, r => r.overdue), count: rows.length },
    has_data: rows.length > 0,
  };
}

// ──────────────────────────── Hisobotlar ro'yxati ───────────────────────────

const CATALOG = [
  { key: 'pnl', title: 'Foyda va zarar (P&L)', description: 'Daromad, xarajat va sof foyda', group: 'moliyaviy', params: ['range'] },
  { key: 'balance_sheet', title: 'Buxgalteriya balansi', description: 'Aktivlar, majburiyatlar va kapital', group: 'moliyaviy', params: ['asOf'] },
  { key: 'cash_flow', title: 'Pul oqimi hisoboti', description: 'Operatsion, investitsiya va moliyaviy oqim', group: 'moliyaviy', params: ['range'] },
  { key: 'trial_balance', title: 'Aylanma-saldov vedomostи', description: 'Barcha hisoblar bo‘yicha debet/kredit', group: 'buxgalteriya', params: ['range'] },
  { key: 'general_ledger', title: 'Bosh daftar (General Ledger)', description: 'Hisoblar bo‘yicha tafsilotli yozuvlar', group: 'buxgalteriya', params: ['range', 'account'] },
  { key: 'receivables', title: 'Debitorlik qarzdorligi', description: 'Mijozlar bo‘yicha qarzlar va yoshi', group: 'qarzlar', params: ['asOf'] },
  { key: 'payables', title: 'Kreditorlik qarzdorligi', description: 'Yetkazib beruvchilar bo‘yicha qarzlar', group: 'qarzlar', params: ['asOf'] },
  { key: 'sales', title: 'Sotuv hisoboti', description: 'Mijoz, mahsulot va oylar bo‘yicha sotuv', group: 'operatsion', params: ['range'] },
  { key: 'expenses', title: 'Xarajatlar hisoboti', description: 'Kategoriya va kontragent bo‘yicha xarajat', group: 'operatsion', params: ['range'] },
  { key: 'tax', title: 'Soliq hisoboti', description: 'QQS va soliq majburiyatlari', group: 'soliq', params: ['range'] },
  { key: 'inventory', title: 'Ombor hisoboti', description: 'Qoldiq, tannarx va harakatlar', group: 'operatsion', params: [] },
  { key: 'customers', title: 'Mijozlar hisoboti', description: 'Sotuv va qarzdorlik kesimida', group: 'analitik', params: ['range'] },
  { key: 'suppliers', title: 'Yetkazib beruvchilar hisoboti', description: 'Xarid va qarzdorlik kesimida', group: 'analitik', params: ['range'] },
  { key: 'bank', title: 'Kassa va bank hisoboti', description: 'Hisoblar bo‘yicha harakat va qoldiq', group: 'buxgalteriya', params: ['range'] },
];

function run(companyId, key, params = {}) {
  const range = U.resolveRange(params);
  switch (key) {
    case 'pnl': return pnl(companyId, range, { compare: params.compare !== false });
    case 'balance_sheet': return balanceSheetReport(companyId, params.asOf && U.isValidDate(params.asOf) ? params.asOf : U.today(), { compare: !!params.compare });
    case 'cash_flow': return cashFlowReport(companyId, range);
    case 'trial_balance': return trialBalanceReport(companyId, range);
    case 'general_ledger': return generalLedgerReport(companyId, { account: params.account, from: range.from, to: range.to });
    case 'receivables': return receivablesReport(companyId, { asOf: params.asOf || U.today() });
    case 'payables': return payablesReport(companyId, { asOf: params.asOf || U.today() });
    case 'sales': return salesReport(companyId, range);
    case 'expenses': return expenseReport(companyId, range);
    case 'tax': return require('./tax').taxReport(companyId, range);
    case 'inventory': return inventoryReport(companyId);
    case 'customers': return customerReport(companyId, range);
    case 'suppliers': return supplierReport(companyId, range);
    case 'bank': return bankReport(companyId, range);
    default: throw new ApiError('Hisobot topilmadi.', 404, 'report_not_found', { key });
  }
}

/**
 * Drill-down: har qanday raqamdan asosiy yozuvlarga o'tish.
 * type: 'account' | 'revenue' | 'expense' | 'party_invoices' | 'party_bills' | 'product_sales' | 'product_moves' | 'cash'
 */
function drillDown(companyId, type, params = {}) {
  const from = params.from || U.periodStart(U.currentPeriod());
  const to = params.to || U.periodEnd(U.currentPeriod());
  switch (type) {
    case 'account': {
      const gl = ledger.accountLedger(companyId, params.account, { from, to });
      return { type, title: `${gl.account.code} — ${gl.account.name}`, range: { from, to }, opening: gl.opening, closing: gl.closing, totals: gl.totals, rows: gl.rows };
    }
    case 'revenue': {
      const codes = ledger.accountsOf(companyId).filter(a => a.type === 'income').map(a => a.code);
      const rows = [];
      for (const code of codes) {
        const gl = ledger.accountLedger(companyId, code, { from, to });
        rows.push({ code, name: gl.account.name, opening: gl.opening, debit: gl.totals.debit, credit: gl.totals.credit, closing: gl.closing, drill: { type: 'account', params: { account: code, from, to } } });
      }
      return { type, title: 'Daromad hisoblari', range: { from, to }, rows, totals: { amount: U.sumBy(rows, r => r.closing) } };
    }
    case 'party_invoices': {
      const invoices = store.collection('invoices').filter(i => i.company_id === companyId && i.customer_id === params.party_id && i.status !== 'cancelled')
        .filter(i => !params.from || (i.issue_date >= params.from && i.issue_date <= params.to))
        .map(i => {
          const d = require('./invoices').decorate(companyId, i, { light: true });
          return { id: i.id, no: i.no, date: i.issue_date, due_date: i.due_date, total: i.total, paid: i.paid_amount, open: d.open_amount, status: d.status, status_label: d.status_label };
        });
      const payments = store.collection('payments').filter(p => p.company_id === companyId && p.party_id === params.party_id && p.status !== 'cancelled')
        .filter(p => !params.from || (p.date >= params.from && p.date <= params.to))
        .map(p => ({ id: p.id, no: p.no, date: p.date, amount: p.amount, type: p.type, method: p.method }));
      return { type, title: 'Mijoz hisob-fakturalari va to‘lovlari', range: { from, to }, invoices, payments, totals: { invoiced: U.sumBy(invoices, i => i.total), paid: U.sumBy(invoices, i => i.paid), open: U.sumBy(invoices, i => i.open) } };
    }
    case 'party_bills': {
      const bills = store.collection('bills').filter(b => b.company_id === companyId && b.supplier_id === params.party_id && b.status !== 'cancelled')
        .filter(b => !params.from || (b.issue_date >= params.from && b.issue_date <= params.to))
        .map(b => {
          const d = require('./bills').decorate(companyId, b);
          return { id: b.id, no: b.no, date: b.issue_date, due_date: b.due_date, total: b.total, paid: b.paid_amount, open: d.open_amount, status: d.status, status_label: d.status_label };
        });
      const payments = store.collection('payments').filter(p => p.company_id === companyId && p.party_id === params.party_id && p.status !== 'cancelled')
        .filter(p => !params.from || (p.date >= params.from && p.date <= params.to))
        .map(p => ({ id: p.id, no: p.no, date: p.date, amount: p.amount, type: p.type, method: p.method }));
      return { type, title: 'Yetkazib beruvchi hisoblari va to‘lovlari', range: { from, to }, bills, payments, totals: { billed: U.sumBy(bills, b => b.total), paid: U.sumBy(bills, b => b.paid), open: U.sumBy(bills, b => b.open) } };
    }
    case 'product_sales': {
      const lines = [];
      for (const inv of store.collection('invoices').filter(i => i.company_id === companyId && i.status !== 'cancelled' && i.status !== 'draft' && i.issue_date >= from && i.issue_date <= to)) {
        for (const it of inv.items || []) {
          if (params.product_id && it.product_id !== params.product_id) continue;
          const party = store.collection('parties').find(p => p.id === inv.customer_id);
          lines.push({ invoice_id: inv.id, no: inv.no, date: inv.issue_date, customer: party ? party.name : '—', name: it.name, qty: it.qty, unit_price: it.unit_price, net: it.net, tax: it.tax_amount });
        }
      }
      return { type, title: 'Mahsulot sotuvlari', range: { from, to }, rows: lines, totals: { qty: U.sumBy(lines, l => l.qty), amount: U.sumBy(lines, l => l.net) } };
    }
    case 'product_moves': {
      const moves = require('./inventory').stockMoves(companyId, { product_id: params.product_id, limit: 300 });
      const ev = require('./inventory').evaluate(companyId, params.product_id);
      return { type, title: 'Ombor harakatlari', range: { from, to }, rows: moves, balance: { qty: ev.qty, value: ev.value, avg_cost: ev.avg_cost } };
    }
    case 'cash': {
      const rows = [];
      for (const a of ledger.accountsOf(companyId).filter(x => x.is_cash || x.is_bank)) {
        const gl = ledger.accountLedger(companyId, a.code, { from, to });
        rows.push({ code: a.code, name: a.name, opening: gl.opening, incoming: gl.totals.debit, outgoing: gl.totals.credit, closing: gl.closing, drill: { type: 'account', params: { account: a.code, from, to } } });
      }
      return { type, title: 'Kassa va bank harakati', range: { from, to }, rows, totals: { opening: U.sumBy(rows, r => r.opening), closing: U.sumBy(rows, r => r.closing) } };
    }
    default:
      throw new ApiError('Drill-down turi qo‘llab-quvvatlanmaydi.', 400, 'unknown_drill', { type });
  }
}

module.exports = {
  CATALOG, run, pnl, balanceSheetReport, cashFlowReport, trialBalanceReport, generalLedgerReport,
  salesReport, expenseReport, receivablesReport, payablesReport, bankReport, inventoryReport,
  customerReport, supplierReport, drillDown, drillHint,
};
