'use strict';
/**
 * BUXAI — Boshqaruv paneli ma'lumotlari.
 * Barcha ko'rsatkichlar yagona buxgalteriya jurnalidan olinadi; ma'lumot bo'lmasa
 * bo'sh holat (empty state) qaytariladi — HECH QACHON soxta raqam ko'rsatilmaydi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const GOAL_METRICS = [
  { key: 'revenue', label: 'Daromad maqsadi', direction: 'up', unit: 'UZS' },
  { key: 'expense_limit', label: 'Xarajat limiti', direction: 'down', unit: 'UZS' },
  { key: 'profit', label: 'Sof foyda maqsadi', direction: 'up', unit: 'UZS' },
  { key: 'receivables_collection', label: 'Debitorlik undirish maqsadi', direction: 'up', unit: 'UZS' },
];

function overview(companyId, { range, currency = 'UZS' } = {}) {
  const r = range || U.resolveRange({ range: 'month' });
  const prevRange = U.previousRange(r);
  const pnl = ledger.periodSummary(companyId, r);
  const prev = ledger.periodSummary(companyId, prevRange);
  const entries = ledger.entries(companyId, { includePending: true });
  const hasData = entries.length > 0;
  const cash = ledger.cashPosition(companyId);
  const ar = require('./invoices').receivablesSummary(companyId);
  const ap = require('./bills').payablesSummary(companyId);
  const series = require('./transactions').series(companyId, r, r.key === 'today' || r.key === 'week' ? 'day' : r.key === 'year' ? 'month' : 'day');
  const categories = require('./transactions').byCategory(companyId, r, 'expense');
  const incomeCats = require('./transactions').byCategory(companyId, r, 'income');
  const recent = require('./transactions').list(companyId, { pageSize: 8, sort: 'date_desc' }).items;
  const health = require('./ai').financialHealth(companyId, { range: r });
  const radar = require('./radar').counts(companyId);
  const insight = require('./ai').dailyInsight(companyId);
  const trend = ledger.monthlyTrend(companyId, 6);
  const unmatchedBank = store.collection('bankRows').filter(x => x.company_id === companyId && x.status === 'unmatched').length;
  const pendingApprovals = ledger.pendingEntries(companyId).length;

  const kpi = (key, label, value, previous, opts = {}) => ({
    key, label,
    value,
    formatted: U.fmtMoney(value, currency),
    previous: previous == null ? null : previous,
    previous_formatted: previous == null ? null : U.fmtMoney(previous, currency),
    change: previous == null || previous === 0 ? null : U.growth(value, previous),
    drill: opts.drill || null,
    formula: opts.formula || null,
    hint: opts.hint || null,
    empty: opts.empty || false,
    tone: opts.tone || (value > 0 ? 'neutral' : 'muted'),
  });

  const kpis = [
    kpi('cash', 'Kassa va bank', cash.total, null, {
      formula: 'Barcha kassa/bank hisoblari qoldig‘i (jurnal bo‘yicha)',
      drill: { type: 'cash', params: { from: r.from, to: r.to } },
      empty: cash.total === 0,
    }),
    kpi('revenue', 'Jami daromad', pnl.revenue, prev.revenue, {
      formula: 'Daromad hisoblari (9xxx) bo‘yicha kredit − debet',
      drill: { type: 'revenue', params: { from: r.from, to: r.to } },
      empty: pnl.revenue === 0,
    }),
    kpi('expense', 'Jami xarajat', pnl.totalExpense, prev.totalExpense, {
      formula: 'Xarajat hisoblari bo‘yicha debet − kredit',
      drill: { type: 'account', params: { account: ledger.roleCode(companyId, 'other_expense'), from: r.from, to: r.to } },
      empty: pnl.totalExpense === 0,
    }),
    kpi('profit', 'Sof foyda', pnl.netProfit, prev.netProfit, {
      formula: 'Barcha daromad − barcha xarajat (soliq bilan)',
      hint: pnl.netMargin != null ? `Marja ${pnl.netMargin}%` : null,
      empty: pnl.revenue === 0 && pnl.totalExpense === 0,
      tone: pnl.netProfit < 0 ? 'negative' : 'positive',
    }),
    kpi('receivables', 'Debitorlik', ar.total, null, {
      formula: 'Xaridorlar hisobi (06xx) qoldig‘i',
      hint: ar.overdue > 0 ? `Muddati o‘tgan: ${U.fmtMoney(ar.overdue)}` : 'Muddati o‘tgan qarz yo‘q',
      drill: { type: 'receivables', params: {} },
      empty: ar.total === 0,
    }),
    kpi('payables', 'Kreditorlik', ap.total, null, {
      formula: 'Mol yetkazib beruvchilar hisobi (60xx) qoldig‘i',
      hint: ap.due_this_week > 0 ? `7 kun ichida: ${U.fmtMoney(ap.due_this_week)}` : 'Yaqin to‘lov yo‘q',
      drill: { type: 'payables', params: {} },
      empty: ap.total === 0,
    }),
  ];

  return {
    range: r, previous_range: prevRange,
    has_data: hasData,
    entry_count: entries.length,
    currency,
    kpis,
    kpi_map: Object.fromEntries(kpis.map(k => [k.key, k])),
    pnl: {
      revenue: pnl.revenue, cos: pnl.cos, gross_profit: pnl.grossProfit, opex: pnl.opex + pnl.otherExpense,
      operating_profit: pnl.operatingProfit, net_profit: pnl.netProfit,
      gross_margin: pnl.grossMargin, net_margin: pnl.netMargin, entry_count: pnl.entryCount,
      expense_no_data: pnl.entryCount === 0,
    },
    previous: { revenue: prev.revenue, expense: prev.totalExpense, net_profit: prev.netProfit },
    cash,
    receivables: ar,
    payables: ap,
    flow: {
      series,
      total_in: U.sumBy(series, s => s.in),
      total_out: U.sumBy(series, s => s.out),
      net: U.sumBy(series, s => s.net),
      has_data: series.some(s => s.in || s.out),
    },
    categories: { expense: categories.rows.slice(0, 8), income: incomeCats.rows.slice(0, 8), expense_total: categories.total, has_data: categories.rows.length > 0 },
    recent_transactions: recent,
    health,
    radar: { ...radar, link: { page: 'radar', params: {} } },
    insight,
    trend,
    goals: listGoals(companyId, r),
    attention: {
      unmatched_bank_rows: unmatchedBank,
      pending_approvals: pendingApprovals,
      overdue_invoices: ar.overdue_count,
      overdue_bills: ap.overdue_count,
      low_stock: require('./inventory').reconciliation(companyId).low_stock.length,
      radar_high: radar.high + radar.critical,
    },
    empty_states: hasData ? [] : [
      { key: 'no_entries', title: 'Hisobot yaratish uchun tranzaksiyalar qo‘shing', description: 'Kompaniyada hali buxgalteriya yozuvlari yo‘q. Birinchi operatsiyani kiritsangiz, barcha ko‘rsatkichlar real vaqtda hisoblanadi.', actions: [{ label: 'Birinchi operatsiyani kiritish', page: 'transactions' }, { label: 'Bank ko‘chirmasini yuklash', page: 'reconciliation' }, { label: 'Hisob-faktura yaratish', page: 'invoices' }] },
    ],
  };
}

// ──────────────────────────────── Maqsadlar ─────────────────────────────────

function goals(companyId) { return store.collection('goals').filter(g => g.company_id === companyId && g.status !== 'archived'); }

function createGoal(companyId, input, user) {
  const metric = GOAL_METRICS.some(m => m.key === input.metric) ? input.metric : 'revenue';
  const def = GOAL_METRICS.find(m => m.key === metric);
  const goal = {
    id: store.uid('gol'), company_id: companyId, metric, metric_label: def.label,
    direction: def.direction,
    target: U.positiveAmount(input.target, 'Maqsad summasi'),
    period: ['month', 'quarter', 'year'].includes(input.period) ? input.period : 'month',
    note: U.str(input.note || '', { max: 300 }),
    status: 'active', created_by: user ? user.id : null, created_at: store.nowISO(),
  };
  store.collection('goals').push(goal);
  store.save();
  require('./audit').log({ company_id: companyId, user, action: 'goal.create', entity: 'goal', entity_id: goal.id, summary: `Maqsad qo‘shildi: ${goal.metric_label} — ${U.fmtMoney(goal.target)}`, after: goal });
  return progress(companyId, goal);
}

function archiveGoal(companyId, id, user) {
  const g = goals(companyId).find(x => x.id === id);
  if (!g) throw new ApiError('Maqsad topilmadi.', 404, 'not_found');
  g.status = 'archived';
  store.save();
  require('./audit').log({ company_id: companyId, user, action: 'goal.archive', entity: 'goal', entity_id: id, summary: `Maqsad arxivlandi: ${g.metric_label}` });
  return g;
}

function metricValue(companyId, metric, range) {
  switch (metric) {
    case 'revenue': return ledger.periodSummary(companyId, range).revenue;
    case 'expense_limit': return ledger.periodSummary(companyId, range).totalExpense;
    case 'profit': return ledger.periodSummary(companyId, range).netProfit;
    case 'receivables_collection': {
      const payments = store.collection('payments').filter(p => p.company_id === companyId && p.type === 'incoming' && p.status !== 'cancelled' && p.date >= range.from && p.date <= range.to);
      return U.sumBy(payments, p => p.amount);
    }
    default: return 0;
  }
}

function progress(companyId, goal, range = null) {
  const r = range || goalRange(goal);
  const value = metricValue(companyId, goal.metric, r);
  const pctValue = goal.target > 0 ? U.clamp(U.round((value / goal.target) * 100, 1), 0, 200) : 0;
  const isDown = goal.direction === 'down';
  const achieved = isDown ? value <= goal.target : value >= goal.target;
  const warning = isDown ? value > goal.target * 0.85 && !achieved : pctValue >= 80 && !achieved;
  return {
    ...goal,
    range: r,
    current: value,
    current_formatted: U.fmtMoney(value),
    target_formatted: U.fmtMoney(goal.target),
    percent: pctValue,
    bar_percent: Math.min(100, pctValue),
    achieved,
    status_color: achieved ? 'green' : (isDown ? (value > goal.target ? 'red' : warning ? 'orange' : 'green') : (warning ? 'orange' : 'purple')),
    remaining: isDown ? Math.max(0, goal.target - value) : Math.max(0, goal.target - value),
    remaining_formatted: U.fmtMoney(Math.max(0, goal.target - value)),
    message: achieved
      ? (isDown ? `Limit bajarildi: ${U.fmtMoney(value)} (limit ${U.fmtMoney(goal.target)})` : `Maqsadga erishildi: ${U.fmtMoney(value)}`)
      : (isDown ? `Limitdan ${U.fmtMoney(Math.max(0, value - goal.target))} oshdi` : `Maqsadgacha ${U.fmtMoney(goal.target - value)} qoldi`),
  };
}

function goalRange(goal) {
  const p = U.currentPeriod();
  if (goal.period === 'month') return { from: U.periodStart(p), to: U.periodEnd(p), label: U.periodLabel(p) };
  if (goal.period === 'quarter') {
    const [y, m] = p.split('-').map(Number);
    const qStart = `${y}-${U.pad(Math.floor((m - 1) / 3) * 3 + 1)}`;
    return { from: U.periodStart(qStart), to: U.periodEnd(U.addMonths(qStart, 2)), label: `${Math.floor((m - 1) / 3) + 1}-chorak ${y}` };
  }
  const y = p.slice(0, 4);
  return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y} yil` };
}

function listGoals(companyId, range = null) {
  return goals(companyId).map(g => progress(companyId, g, range));
}

module.exports = { GOAL_METRICS, overview, listGoals, createGoal, archiveGoal, progress, metricValue };
