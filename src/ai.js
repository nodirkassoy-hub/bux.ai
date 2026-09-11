'use strict';
/**
 * BUXAI — AI Buxgalter / AI CFO.
 *
 * ASOSIY QOIDA: AI faqat REAL buxgalteriya ma'lumotlari asosida javob beradi.
 * Har bir javobda:
 *   - tasnif: FAKT / HISOB-KITOB / PROGNOZ / TAVSIYA
 *   - ishonch darajasi (yuqori/o'rta/past)
 *   - dalillar (raqamlar va ular qayerdan olingani)
 * AI hech qachon o'zicha raqam o'ylab topmaydi va hech narsani jimgina o'zgartirmaydi.
 * Har qanday amal taklifi faqat TAKLIF — bajarilishi uchun foydalanuvchi tasdiqlashi kerak.
 *
 * LLM provayderi sozlangan bo'lsa (BUXAI_LLM_URL / OPENAI_API_KEY), savol-javob
 * tayyor "data pack" bilan provayderga yuboriladi; provayder ishlamasa — tizim
 * o'zining deterministik, ma'lumotga bog'langan javobini qaytaradi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const NO_DATA = 'Ma’lumot yetarli emas';

// ───────────────────────────── Ma'lumot paketi ──────────────────────────────

/** Kompaniya bo'yicha yagona moliyaviy faktlar to'plami (barcha javoblar shundan) */
function dataPack(companyId, { range } = {}) {
  const r = range || U.resolveRange({ range: 'month' });
  const period = U.periodOf(r.to) === U.periodOf(r.from) ? U.periodOf(r.from) : null;
  const pnl = ledger.periodSummary(companyId, r);
  const prevRange = U.previousRange(r);
  const prev = ledger.periodSummary(companyId, prevRange);
  const cash = ledger.cashPosition(companyId);
  const ar = require('./invoices').receivablesSummary(companyId);
  const ap = require('./bills').payablesSummary(companyId);
  const trend = ledger.monthlyTrend(companyId, 6);
  const expenses = require('./transactions').byCategory(companyId, r, 'expense');
  const income = require('./transactions').byCategory(companyId, r, 'income');
  const suppliers = require('./transactions').byParty(companyId, r, 'supplier', 10);
  const customers = require('./transactions').byParty(companyId, r, 'customer', 10);
  const inventory = require('./inventory').reconciliation(companyId);
  const allEntries = ledger.entries(companyId, { includePending: true });
  const companyEntryCount = allEntries.length;
  const rangeEntries = allEntries.filter(e => e.date >= r.from && e.date <= r.to);
  const entryCount = rangeEntries.length;
  const dataDates = U.sortBy(allEntries, e => e.date).map(e => e.date);
  const radar = safe(() => require('./radar').scanCached(companyId, { from: U.periodStart(U.addMonths(U.currentPeriod(), -3)), to: U.periodEnd(U.currentPeriod()) }), { summary: { total: 0, high: 0, critical: 0, issues: [] }, issues: [] });
  const forecast = cashForecast(companyId, 30);
  const health = financialHealth(companyId, { range: r });
  const overdueInvoices = require('./invoices').list(companyId, { status: 'overdue', pageSize: 20 }).items;
  const overdueBills = require('./bills').list(companyId, { status: 'overdue', pageSize: 20 }).items;
  const upcomingBills = require('./bills').upcoming(companyId, 7);
  const latePayers = require('./invoices').latePayers(companyId, 5);
  const returns = ledger.roleBalance(companyId, 'returns');
  const vat = { payable: ledger.roleBalance(companyId, 'vat_out'), receivable: ledger.roleBalance(companyId, 'vat_in') };
  return {
    company: store.collection('companies').find(c => c.id === companyId) || null,
    range: r, period, prev_range: prevRange,
    has_data: entryCount > 0,
    entry_count: entryCount,
    company_entry_count: companyEntryCount,
    data_from: dataDates.length ? dataDates[0] : null,
    data_to: dataDates.length ? dataDates[dataDates.length - 1] : null,
    pnl, prev,
    revenue: pnl.revenue, expense: pnl.totalExpense, net_profit: pnl.netProfit,
    gross_profit: pnl.grossProfit, gross_margin: pnl.grossMargin, net_margin: pnl.netMargin,
    revenue_change: U.growth(pnl.revenue, prev.revenue),
    expense_change: U.growth(pnl.totalExpense, prev.totalExpense),
    cash, ar, ap, trend, expenses, income, suppliers, customers, inventory, forecast, health,
    radar_summary: radar.summary, radar_issues: (radar.issues || []).slice(0, 12),
    overdue_invoices: overdueInvoices, overdue_bills: overdueBills, upcoming_bills: upcomingBills,
    late_payers: latePayers, returns, vat,
  };
}

function safe(fn, fallback) { try { return fn(); } catch (e) { console.error('[ai] data:', e.message); return fallback; } }

// ────────────────────────────── Moliyaviy salomatlik ────────────────────────

/**
 * Financial Health Score — faqat real ko'rsatkichlardan hisoblanadi.
 * Har bir komponent: ball, sabab, dalillar. Ma'lumot bo'lmasa — ball yo'q.
 */
function financialHealth(companyId, { range } = {}) {
  const r = range || U.resolveRange({ range: 'month' });
  const entries = ledger.entries(companyId);
  const components = [];
  const push = (key, label, score, weight, reason, evidence, status = 'ok') => {
    components.push({ key, label, score: score == null ? null : Math.round(U.clamp(score, 0, 100)), weight, reason, evidence, status });
  };

  const cash = ledger.cashPosition(companyId);
  const pnl = ledger.periodSummary(companyId, r);
  const trend = ledger.monthlyTrend(companyId, 6);
  const ar = require('./invoices').receivablesSummary(companyId);
  const ap = require('./bills').payablesSummary(companyId);
  const inventoryValue = require('./inventory').reconciliation(companyId);
  const expenseAccounts = ledger.accountsOf(companyId).filter(a => a.type === 'expense');
  const monthlyExpenseMoves = ledger.accountMovements(companyId, { from: U.periodStart(U.addMonths(U.currentPeriod(), -1)), to: U.periodEnd(U.addMonths(U.currentPeriod(), -1)) });
  const lastMonthExpense = U.sumBy([...monthlyExpenseMoves.values()].filter(x => x.account.type === 'expense'), x => x.debit - x.credit);

  if (entries.length === 0) {
    return {
      available: false,
      score: null,
      message: NO_DATA,
      explanation: 'Kompaniyada buxgalteriya yozuvlari yo‘q. Tranzaksiyalar kiritilgandan so‘ng moliyaviy salomatlik hisoblanadi.',
      components: [],
      data_points: 0,
    };
  }

  // 1. Likvidlik (pul zapasi)
  const monthlyBurn = lastMonthExpense || pnl.totalExpense;
  if (monthlyBurn > 0) {
    const runway = cash.total / monthlyBurn;
    let score;
    if (runway >= 6) score = 100;
    else if (runway >= 3) score = 70 + ((runway - 3) / 3) * 30;
    else if (runway >= 1) score = 40 + ((runway - 1) / 2) * 30;
    else score = Math.max(5, runway * 40);
    push('liquidity', 'Pul zapasi (runway)', score, 0.22,
      `Kassa/bank qoldig‘i ${U.fmtMoney(cash.total)} — oxirgi oy xarajati ${U.fmtMoney(monthlyBurn)} bo‘lsa, ${U.round(runway, 1)} oyga yetadi.`,
      [
        { label: 'Kassa va bank', value: U.fmtMoney(cash.total) },
        { label: 'Oxirgi oy xarajati', value: U.fmtMoney(monthlyBurn) },
        { label: 'Pul zapasi', value: `${U.round(runway, 1)} oy` },
      ]);
  } else {
    push('liquidity', 'Pul zapasi (runway)', null, 0.22, 'Xarajat ma’lumotlari yo‘q — pul zapasi hisoblanmaydi.', [], 'insufficient');
  }

  // 2. Foydalilik (sof marja)
  if (pnl.revenue > 0) {
    const m = pnl.netMargin;
    const score = m >= 20 ? 100 : m >= 10 ? 70 + ((m - 10) / 10) * 30 : m >= 0 ? 40 + (m / 10) * 30 : Math.max(0, 40 + m);
    push('profitability', 'Foydalilik (sof marja)', score, 0.22,
      `Sof foyda ${U.fmtMoney(pnl.netProfit)}, daromad ${U.fmtMoney(pnl.revenue)} — sof marja ${m == null ? '—' : `${m}%`}.`,
      [
        { label: 'Daromad', value: U.fmtMoney(pnl.revenue), drill: { type: 'revenue', params: { from: r.from, to: r.to } } },
        { label: 'Sof foyda', value: U.fmtMoney(pnl.netProfit) },
        { label: 'Sof marja', value: m == null ? '—' : `${m}%` },
      ]);
  } else if (pnl.totalExpense > 0) {
    push('profitability', 'Foydalilik (sof marja)', Math.max(0, 30 - (pnl.totalExpense / 1000000)), 0.22,
      `Bu davrda daromad yo‘q, xarajat ${U.fmtMoney(pnl.totalExpense)} — zarar holati.`,
      [{ label: 'Daromad', value: U.fmtMoney(0) }, { label: 'Xarajat', value: U.fmtMoney(pnl.totalExpense) }], 'warning');
  } else {
    push('profitability', 'Foydalilik (sof marja)', null, 0.22, 'Daromad va xarajat ma’lumoti yo‘q.', [], 'insufficient');
  }

  // 3. Daromad o'sishi (3 oylik trend)
  const revTrend = trend.filter(t => t.revenue > 0);
  if (revTrend.length >= 3) {
    const first = revTrend[revTrend.length - 3].revenue;
    const last = revTrend[revTrend.length - 1].revenue;
    const g = first > 0 ? ((last - first) / first) * 100 / 2 : 0; // o'rtacha oylik o'sish
    const score = g > 10 ? 100 : g > 0 ? 60 + (g / 10) * 40 : g > -10 ? 40 + g * 2 : Math.max(0, 40 + g);
    push('revenue_growth', 'Daromad o‘sishi', score, 0.14,
      `Oxirgi 3 oyda daromad ${U.fmtMoney(first)} → ${U.fmtMoney(last)} (o‘rtacha oylik ${U.round(g, 1)}%).`,
      trend.slice(-3).map(t => ({ label: t.full_label, value: U.fmtMoney(t.revenue) })));
  } else {
    push('revenue_growth', 'Daromad o‘sishi', null, 0.14, 'O‘sishni hisoblash uchun kamida 3 oy daromad ma’lumoti kerak.', [], 'insufficient');
  }

  // 4. Xarajat o'sishi (daromad o'sishiga nisbatan)
  if (pnl.revenue > 0 && revTrend.length >= 3) {
    const eFirst = revTrend[revTrend.length - 3].expense, eLast = revTrend[revTrend.length - 1].expense;
    const eg = eFirst > 0 ? ((eLast - eFirst) / eFirst) * 100 / 2 : 0;
    const rg = revTrend.length >= 3 ? ((revTrend[revTrend.length - 1].revenue - revTrend[revTrend.length - 3].revenue) / Math.max(1, revTrend[revTrend.length - 3].revenue)) * 100 / 2 : 0;
    const gap = eg - rg;
    const score = gap <= 0 ? 100 : gap <= 10 ? 70 : gap <= 25 ? 45 : 20;
    push('expense_control', 'Xarajat nazorati', score, 0.12,
      gap <= 0
        ? `Xarajat o‘sishi (${U.round(eg, 1)}%/oy) daromad o‘sishidan (${U.round(rg, 1)}%/oy) yuqori emas.`
        : `Xarajat o‘sishi (${U.round(eg, 1)}%/oy) daromad o‘sishidan (${U.round(rg, 1)}%/oy) ${U.round(gap, 1)} p.p. tez.`,
      [
        { label: 'Xarajat o‘sishi', value: `${U.round(eg, 1)}%/oy` },
        { label: 'Daromad o‘sishi', value: `${U.round(rg, 1)}%/oy` },
      ]);
  } else {
    push('expense_control', 'Xarajat nazorati', null, 0.12, 'Taqqoslash uchun yetarli tarix yo‘q.', [], 'insufficient');
  }

  // 5. Debitorlik sifati
  if (ar.total > 0 || entries.length > 0) {
    const overdueShare = ar.total > 0 ? (ar.overdue / ar.total) * 100 : 0;
    const score = ar.total === 0 ? 85 : overdueShare <= 5 ? 100 : overdueShare <= 15 ? 80 : overdueShare <= 30 ? 55 : 25;
    push('receivables', 'Debitorlik sifati', score, 0.12,
      ar.total === 0 ? 'Ochiq debitorlik yo‘q.' :
        `Jami debitorlik ${U.fmtMoney(ar.total)}, shundan muddati o‘tgan ${U.fmtMoney(ar.overdue)} (${U.round(overdueShare, 1)}%).`,
      [
        { label: 'Jami debitorlik', value: U.fmtMoney(ar.total), drill: { type: 'receivables', params: {} } },
        { label: 'Muddati o‘tgan', value: U.fmtMoney(ar.overdue), hint: `${ar.overdue_count} ta hujjat` },
      ], ar.overdue > 0 ? 'warning' : 'ok');
  } else {
    push('receivables', 'Debitorlik sifati', null, 0.12, 'Ma’lumot yo‘q.', [], 'insufficient');
  }

  // 6. Kreditorlik va likvidlik
  const shortTermLiab = ap.total;
  const liquidAssets = cash.total + ar.total + Math.max(0, inventoryValue.total_value);
  if (shortTermLiab > 0 || liquidAssets > 0) {
    const ratio = shortTermLiab > 0 ? liquidAssets / shortTermLiab : (liquidAssets > 0 ? 3 : 1);
    const score = ratio >= 2 ? 100 : ratio >= 1.2 ? 70 + ((ratio - 1.2) / 0.8) * 30 : ratio >= 1 ? 55 : Math.max(10, ratio * 55);
    push('liquidity_ratio', 'Likvidlik koeffitsiyenti', score, 0.10,
      `Likvid aktivlar (kassa ${U.fmtMoney(cash.total)} + debitorlik ${U.fmtMoney(ar.total)} + ombor ${U.fmtMoney(Math.max(0, inventoryValue.total_value))}) = ${U.fmtMoney(liquidAssets)}, kreditorlik ${U.fmtMoney(shortTermLiab)} → koeffitsiyent ${U.round(ratio, 2)}.`,
      [
        { label: 'Likvid aktivlar', value: U.fmtMoney(liquidAssets) },
        { label: 'Kreditorlik', value: U.fmtMoney(shortTermLiab) },
        { label: 'Koeffitsiyent', value: U.round(ratio, 2), hint: '1.2+ qulay hisoblanadi' },
      ]);
  } else {
    push('liquidity_ratio', 'Likvidlik koeffitsiyenti', null, 0.10, 'Aktiv/majburiyat ma’lumoti yo‘q.', [], 'insufficient');
  }

  // 7. Pul oqimi barqarorligi
  const flows = trend.map(t => t.revenue - t.expense);
  const positiveMonths = flows.filter(f => f > 0).length;
  if (trend.filter(t => t.revenue || t.expense).length >= 3) {
    const mean = U.mean(flows);
    const cv = mean !== 0 ? Math.abs(U.stddev(flows) / mean) : 2;
    const score = U.clamp(100 - cv * 35 + (positiveMonths / flows.length) * 20, 0, 100);
    push('cashflow_stability', 'Pul oqimi barqarorligi', score, 0.08,
      `Oxirgi ${flows.length} oyda ${positiveMonths} oy ijobiy natija bilan yopilgan. Natijalar o‘zgaruvchanligi (CV) ${U.round(cv, 2)}.`,
      trend.map(t => ({ label: t.full_label, value: U.fmtMoney(t.revenue - t.expense) })));
  } else {
    push('cashflow_stability', 'Pul oqimi barqarorligi', null, 0.08, 'Yetarli oylik tarix yo‘q.', [], 'insufficient');
  }

  const available = components.filter(c => c.score != null);
  const totalWeight = U.sumBy(available, c => c.weight);
  if (!available.length || totalWeight < 0.4) {
    return {
      available: false, score: null, message: NO_DATA,
      explanation: `Hisoblash uchun yetarli ko‘rsatkich yo‘q (mavjud: ${available.length} / ${components.length}). Tranzaksiyalar va hisob-fakturalar kiritilgandan so‘ng qayta hisoblanadi.`,
      components, data_points: entries.length,
    };
  }
  const weighted = U.sumBy(available, c => c.score * c.weight) / totalWeight;
  const score = Math.round(weighted);
  const strengths = available.filter(c => c.score >= 75).sort((a, b) => b.score - a.score);
  const risks = available.filter(c => c.score < 60).sort((a, b) => a.score - b.score);
  const rating = score >= 85 ? 'A‘lo' : score >= 70 ? 'Yaxshi' : score >= 55 ? 'O‘rtacha' : score >= 40 ? 'Ehtiyot talab' : 'Yuqori risk';
  return {
    available: true,
    score,
    rating,
    message: `${score}/100 — ${rating}`,
    explanation: `Ball ${available.length} ta real ko‘rsatkich asosida hisoblandi: ${available.map(c => `${c.label} (${c.score}/100, ${Math.round(c.weight * 100)}% vazn)`).join(', ')}.`,
    formula: 'Har bir ko‘rsatkich 0–100 ball bilan baholanadi va vaznlar bo‘yicha o‘rtachalashtiriladi. Faqat ma’lumoti mavjud ko‘rsatkichlar hisobga olinadi.',
    strengths: strengths.map(c => ({ label: c.label, score: c.score, reason: c.reason, evidence: c.evidence })),
    risks: risks.map(c => ({ label: c.label, score: c.score, reason: c.reason, evidence: c.evidence })),
    components,
    data_points: entries.length,
    computed_at: store.nowISO(),
  };
}

// ──────────────────────────── Pul oqimi prognozi ────────────────────────────

/**
 * Real pul oqimi prognozi:
 *  - joriy kassa/bank qoldig'i
 *  - muddati kelgan/kelayotgan hisob-fakturalar (kutilayotgan tushum)
 *  - to'lanishi kerak bo'lgan xarid hisoblari (kutilayotgan chiqim)
 *  - takrorlanuvchi operatsion oqim (oxirgi 90 kun o'rtachasi, hujjatga bog'lanmagan qism)
 * Har doim "PROGNOZ" sifatida belgilanadi. Ma'lumot yetarli bo'lmasa — hisoblanmaydi.
 */
function cashForecast(companyId, days = 30) {
  const horizon = [7, 30, 60, 90].includes(Number(days)) ? Number(days) : 30;
  const cash = ledger.cashPosition(companyId);
  const invoices = require('./invoices').receivablesSummary(companyId);
  const bills = require('./bills').payablesSummary(companyId);
  const historyFrom = U.addDays(U.today(), -120);
  const history = ledger.entries(companyId, { from: historyFrom, to: U.today() });
  const operating = ledger.cashFlowStatement(companyId, { from: historyFrom, to: U.today() });
  const cashCodes = new Set(ledger.accountsOf(companyId).filter(a => a.is_cash || a.is_bank).map(a => a.code));
  // Hujjatga bog'lanmagan (takrorlanuvchi) operatsion oqim
  let recurringIn = 0, recurringOut = 0, daysWithData = new Set();
  for (const e of history) {
    if (['invoice', 'payment', 'bill', 'invoice_refund'].includes(e.source.type)) continue;
    for (const l of e.lines) {
      if (!cashCodes.has(l.account)) continue;
      const amount = l.debit - l.credit;
      if (amount > 0) recurringIn += amount; else recurringOut += -amount;
      daysWithData.add(e.date);
    }
  }
  const spanDays = Math.max(1, U.daysBetween(historyFrom, U.today()));
  const recurringDailyNet = (recurringIn - recurringOut) / spanDays;
  const openInvoices = invoices.invoices.filter(i => i.open_amount > 0.5);
  const openBills = bills.bills.filter(b => b.open_amount > 0.5);

  const dataQuality = (() => {
    if (!cash.rows.length && !history.length) return 'insufficient';
    if (daysWithData.size >= 20 && (openInvoices.length || openBills.length)) return 'good';
    if (daysWithData.size >= 5 || openInvoices.length || openBills.length) return 'limited';
    return 'insufficient';
  })();

  if (dataQuality === 'insufficient') {
    return {
      available: false,
      days: horizon,
      message: 'Prognoz uchun yetarli ma’lumot yo‘q',
      explanation: 'Prognoz hisoblash uchun kamida bir necha oylik kassa/bank harakati yoki ochiq hisob-fakturalar kerak. Hozircha ma’lumot yetarli emas.',
      data_quality: dataQuality,
      current_cash: cash.total,
      assumptions: [],
      points: [],
      totals: { expected_in: 0, expected_out: 0, net: 0 },
    };
  }

  const today = U.today();
  const points = [];
  let balance = cash.total;
  let expectedIn = 0, expectedOut = 0;
  const scheduledIn = new Map(), scheduledOut = new Map();
  for (const inv of openInvoices) {
    const when = inv.due_date < today ? today : inv.due_date;
    scheduledIn.set(when, (scheduledIn.get(when) || 0) + inv.open_amount);
  }
  for (const b of openBills) {
    const when = b.due_date < today ? today : b.due_date;
    scheduledOut.set(when, (scheduledOut.get(when) || 0) + b.open_amount);
  }
  for (let i = 0; i <= horizon; i++) {
    const date = U.addDays(today, i);
    const inflow = (scheduledIn.get(date) || 0) + Math.max(0, recurringDailyNet);
    const outflow = (scheduledOut.get(date) || 0) + Math.max(0, -recurringDailyNet);
    balance += inflow - outflow;
    expectedIn += inflow; expectedOut += outflow;
    points.push({ date, inflow: U.round(inflow, 0), outflow: U.round(outflow, 0), net: U.round(inflow - outflow, 0), balance: U.round(balance, 0) });
  }
  const min = U.sortBy(points, p => p.balance)[0];
  const minBalance = min ? min.balance : balance;
  const runwayDays = recurringDailyNet + (expectedIn - expectedOut) / Math.max(1, horizon) < 0
    ? Math.floor(cash.total / Math.abs((expectedIn - expectedOut) / Math.max(1, horizon) + recurringDailyNet) ) : null;
  return {
    available: true,
    is_forecast: true,
    days: horizon,
    data_quality: dataQuality,
    data_quality_label: dataQuality === 'good' ? 'Yaxshi (yetarli tarix)' : 'Cheklangan (kam tarix)',
    message: `PROGNOZ: ${horizon} kun ichida pul qoldig‘i ${U.fmtMoney(cash.total)} dan ${U.fmtMoney(balance)} ga o‘zgarishi kutiladi.`,
    current_cash: U.round(cash.total, 0),
    points,
    totals: {
      expected_in: U.round(expectedIn, 0),
      expected_out: U.round(expectedOut, 0),
      net: U.round(expectedIn - expectedOut, 0),
      closing: U.round(balance, 0),
      min_balance: U.round(minBalance, 0),
      min_balance_date: min ? min.date : null,
    },
    horizon_summary: [7, 30, 60, 90].map(d => {
      const pts = points.slice(0, Math.min(d, points.length - 1) + 1);
      const last = pts[pts.length - 1];
      return last ? { days: d, balance: last.balance, net: U.round(U.sumBy(pts, p => p.net), 0) } : null;
    }).filter(Boolean),
    assumptions: [
      `Kutilayotgan tushum: muddati kelgan va kelayotgan ${openInvoices.length} ta hisob-faktura (${U.fmtMoney(U.sumBy(openInvoices, i => i.open_amount))}) muddat kunlari bo‘yicha.`,
      `Kutilayotgan chiqim: ${openBills.length} ta xarid hisobi (${U.fmtMoney(U.sumBy(openBills, b => b.open_amount))}) muddat kunlari bo‘yicha.`,
      `Takrorlanuvchi operatsion oqim: oxirgi ${spanDays} kun bo‘yicha kuniga ${U.fmtMoney(recurringDailyNet)} (hisob-faktura/to‘lov bilan bog‘lanmagan harakatlardan).`,
      'Hisob-fakturalar o‘z vaqtida to‘lanadi deb faraz qilinadi; kechikish bo‘lsa haqiqiy qoldiq past bo‘ladi.',
      'Bu prognoz, fakt emas: yangi operatsiyalar kiritilishi bilan o‘zgaradi.',
    ],
    drivers: [
      { label: 'Ochiq debitorlik', value: U.fmtMoney(invoices.total), hint: `${openInvoices.length} hujjat` },
      { label: 'Ochiq kreditorlik', value: U.fmtMoney(bills.total), hint: `${openBills.length} hujjat` },
      { label: 'Muddati o‘tgan debitorlik', value: U.fmtMoney(invoices.overdue) },
      { label: 'Muddati o‘tgan kreditorlik', value: U.fmtMoney(bills.overdue) },
    ],
    risk: minBalance < 0
      ? { level: 'high', message: `Prognoz bo‘yicha ${min.date} sanasida qoldiq manfiy (${U.fmtMoney(minBalance)}) bo‘lishi mumkin.` }
      : minBalance < cash.total * 0.2
        ? { level: 'medium', message: `Minimal qoldiq ${U.fmtMoney(minBalance)} (${min.date}) — joriy qoldiqning ${U.round((minBalance / Math.max(1, cash.total)) * 100, 0)}%.` }
        : { level: 'low', message: 'Prognoz bo‘yicha to‘lov qobiliyati yetarli.' },
    generated_at: store.nowISO(),
  };
}

// ──────────────────────────── Javob konstruktorlari ─────────────────────────

function fmtList(rows, mapper) { return rows.map(mapper); }
function conf(score) { return score >= 85 ? 'high' : score >= 60 ? 'medium' : 'low'; }
function confLabel(c) { return c === 'high' ? 'Yuqori ishonch' : c === 'medium' ? 'O‘rtacha ishonch' : 'Past ishonch'; }

/** Savol niyatini aniqlash (o'zbek/rus/ingliz kalit so'zlari) */
function detectIntent(question) {
  const q = U.norm(question);
  const has = (...words) => words.some(w => q.includes(w));
  if (has('xatolarimiz bormi', 'xato radar', 'qanday xatolar', 'xatolarni', 'ошибк', 'errors', 'muammolar bormi', 'problem')) return 'errors';
  if (has('bugun nima qilishim', 'bugun nima qilaman', 'vazifalar', 'bugungi ishlar', 'nima qilishim kerak', 'prioritet')) return 'today_tasks';
  if (has('cash flow', 'pul oqimi prognoz', 'prognoz', 'keyingi oy', 'kelasi oy', 'прогноз', 'forecast')) return 'forecast';
  if (has('xarajat nega oshdi', 'nega oshdi', 'xarajatlarimiz nega', 'xarajat o‘sishi', 'почему выросли')) return 'why_expenses_up';
  if (has('eng katta xarajat', 'qaysi xarajat', 'xarajatlarimiz qancha', 'xarajat qancha', 'eng ko‘p xarajat', 'top xarajat')) return 'top_expenses';
  if (has('qaysi supplier', 'qaysi yetkazib', 'yetkazib beruvchi', 'eng ko‘p xarajat keltir')) return 'top_suppliers';
  if (has('qaysi mijozlardan pul', 'mijozlardan pul', 'qaysi mijoz', 'undirish', 'kim qarz', 'debitorlik')) return 'receivables';
  if (has('overdue', 'muddati o‘tgan invoice', 'muddati o‘tgan hisob', 'kechikkan hisob')) return 'overdue_invoices';
  if (has('to‘lanmagan invoice', 'tolanmagan invoice', 'qaysi invoice', 'hisob-faktura to‘lanmagan', 'unpaid')) return 'unpaid_invoices';
  if (has('foyda', 'daromad', 'sof natija', 'tushum', 'выручка', 'прибыль', 'revenue', 'profit')) return 'profit';
  if (has('balans', 'kassa qancha', 'pulimiz qancha', 'bank qoldiq', 'naqd')) return 'cash';
  if (has('soliq', 'qqs', 'vat', 'nаlоg', 'налог')) return 'tax';
  if (has('ombor', 'inventar', 'qoldiq', 'sklad')) return 'inventory';
  if (has('kreditorlik', 'qarz to‘lashimiz', 'supplierga qarz', 'payable')) return 'payables';
  if (has('salomatlik', 'health', 'reyting', 'baholash')) return 'health';
  if (has('marja', 'margin', 'foyda marjasi')) return 'margin';
  if (has('xarajat', 'chiqim', 'расход', 'expense')) return 'expenses';
  if (has('sotuv', 'sales', 'sotuvlar')) return 'sales';
  if (has('mijoz', 'customer')) return 'customers';
  if (has('nima qilsam bo‘ladi', 'yordam', 'tahlil', 'maslahat', 'recommendation')) return 'advice';
  return 'overview';
}

function buildAnswer(companyId, intent, pack) {
  const r = pack.range;
  const noData = !pack.has_data;
  const packRef = { range: r };
  const answer = {
    intent,
    classification: 'FACT',
    confidence: 'high',
    confidence_score: 95,
    sources: [],
    blocks: [],
    followups: [],
    data_range: r.label,
    company_id: companyId,
    generated_at: store.nowISO(),
  };
  const addBlock = (title, type, rows, extra = {}) => answer.blocks.push({ title, type, rows, ...extra });
  const src = (label, value, drill) => answer.sources.push({ label, value, drill });

  if (noData) {
    // Ikki holat: (1) kompaniyada umuman yozuv yo'q, (2) tanlangan davrda yozuv yo'q
    const companyEmpty = !pack.company_entry_count;
    return {
      ...answer,
      text: companyEmpty
        ? `${NO_DATA}. Kompaniyada hali buxgalteriya yozuvlari yo‘q, shu sababli moliyaviy tahlil qilib bo‘lmaydi.\n\nBoshlash uchun: tranzaksiya kiriting, hisob-faktura yarating yoki bank ko‘chirmasini yuklang — shundan so‘ng men real raqamlar asosida javob bera olaman.`
        : `${NO_DATA}. «${r.label}» davrida buxgalteriya yozuvlari topilmadi, shu sababli bu davr uchun hisob-kitob qilib bo‘lmaydi.\n\nKompaniyada jami ${pack.company_entry_count} ta yozuv bor${pack.data_from ? ` (${pack.data_from} — ${pack.data_to})` : ''}. Sana filtrini o‘zgartirsangiz, real raqamlar bo‘yicha javob beraman.`,
      classification: 'FACT',
      confidence: 'high',
      confidence_score: 100,
      empty: true,
      empty_reason: companyEmpty ? 'no_entries' : 'empty_range',
      data_range: r.label,
      suggestion: companyEmpty ? null : { label: 'Mavjud davrni ko‘rish', range: { from: pack.data_from, to: pack.data_to } },
      followups: companyEmpty
        ? ['Bank ko‘chirmasini qanday yuklayman?', 'Birinchi hisob-fakturani qanday yarataman?']
        : ['Bu oy qancha foyda qildik?', 'Qaysi invoice’lar to‘lanmagan?'],
    };
  }

  const money = U.fmtMoney;
  switch (intent) {
    case 'profit': {
      const p = pack.pnl, prev = pack.prev;
      answer.classification = 'CALCULATION';
      answer.confidence_score = 96;
      answer.text = `${r.label} uchun:\n• Daromad: ${money(p.revenue)}\n• Xarajat: ${money(p.totalExpense)}\n• Sof foyda: ${money(p.netProfit)}${p.netMargin != null ? ` (sof marja ${p.netMargin}%)` : ''}\n\nHisob-kitob yagona buxgalteriya jurnalidan olingan (${p.entryCount} ta yozuv).`;
      if (pack.revenue_change != null) {
        answer.text += `\n\nO‘tgan davr (${pack.prev_range.label}) bilan taqqoslaganda daromad ${pack.revenue_change >= 0 ? '+' : ''}${pack.revenue_change}% o‘zgargan.`;
      }
      addBlock('Asosiy ko‘rsatkichlar', 'metrics', [
        { label: 'Daromad', value: money(p.revenue), previous: money(prev.revenue), change: U.growth(p.revenue, prev.revenue), drill: { type: 'revenue', params: { from: r.from, to: r.to } } },
        { label: 'Sotilgan tovar tannarxi', value: money(p.cos), previous: money(prev.cos) },
        { label: 'Yalpi foyda', value: money(p.grossProfit), hint: p.grossMargin != null ? `marja ${p.grossMargin}%` : null },
        { label: 'Operatsion xarajatlar', value: money(p.opex + p.otherExpense), previous: money(prev.opex + prev.otherExpense), drill: { type: 'expense', params: { from: r.from, to: r.to } } },
        { label: 'Sof foyda', value: money(p.netProfit), previous: money(prev.netProfit), change: U.growth(p.netProfit, prev.netProfit) },
      ]);
      src('Davr', r.label);
      src('Yozuvlar soni', String(p.entryCount));
      if (pack.expenses.rows.length) {
        addBlock('Eng katta xarajat yo‘nalishlari', 'table', pack.expenses.rows.slice(0, 6).map(x => ({
          label: x.label, value: money(x.amount), share: `${x.share}%`, drill: { type: 'account', params: { account: x.code, from: r.from, to: r.to } },
        })));
      }
      answer.followups = ['Xarajatlarimiz nega oshdi?', 'Qaysi invoice\'lar to‘lanmagan?', 'Cash flow keyingi oy qanday bo‘ladi?'];
      break;
    }
    case 'top_expenses': {
      const rows = pack.expenses.rows.slice(0, 8);
      answer.classification = 'CALCULATION';
      answer.confidence_score = 97;
      if (!rows.length) {
        answer.text = `Bu davrda (${r.label}) xarajat yozuvlari yo‘q.`;
        answer.empty = true;
        break;
      }
      const top = rows[0];
      answer.text = `${r.label} uchun jami xarajat ${money(pack.expenses.total)}.\nEng katta yo‘nalish: «${top.label}» — ${money(top.amount)} (jami xarajatning ${top.share}%).`;
      addBlock('Xarajat yo‘nalishlari', 'table', rows.map(x => ({
        label: x.label, value: money(x.amount), share: `${x.share}%`, drill: { type: 'account', params: { account: x.code, from: r.from, to: r.to } },
      })));
      src('Jami xarajat', money(pack.expenses.total));
      src('Davr', r.label);
      if (pack.expense_change != null) {
        addBlock('O‘tgan davr bilan taqqoslash', 'note', [], {
          text: `O‘tgan davr (${pack.prev_range.label}) xarajati ${money(pack.prev.totalExpense)} edi — o‘zgarish ${pack.expense_change >= 0 ? '+' : ''}${pack.expense_change}%.`,
        });
      }
      answer.followups = ['Xarajatlarimiz nega oshdi?', 'Qaysi supplier eng ko‘p xarajat keltiryapti?'];
      break;
    }
    case 'why_expenses_up': {
      answer.classification = 'CALCULATION';
      const prevTotal = pack.prev.totalExpense;
      const curTotal = pack.pnl.totalExpense;
      if (!prevTotal) {
        answer.text = `Taqqoslash uchun o‘tgan davr (${pack.prev_range.label}) xarajat ma’lumoti yo‘q. Joriy davr xarajati ${money(curTotal)}.`;
        answer.confidence = 'medium';
        answer.confidence_score = 65;
        break;
      }
      const prevMap = new Map(pack.prev.expenseByAccount.map(x => [x.code, x.amount]));
      const drivers = pack.pnl.expenseByAccount.map(x => ({ ...x, before: prevMap.get(x.code) || 0, delta: x.amount - (prevMap.get(x.code) || 0) }))
        .filter(x => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5);
      const change = ((curTotal - prevTotal) / Math.abs(prevTotal)) * 100;
      answer.text = `Xarajatlar ${pack.prev_range.label}da ${money(prevTotal)} edi, ${r.label}da ${money(curTotal)} — ${change >= 0 ? 'o‘sish' : 'pasayish'} ${U.round(Math.abs(change), 1)}% (${money(Math.abs(curTotal - prevTotal))}).`;
      if (drivers.length) {
        answer.text += `\nAsosiy sabab${drivers.length > 1 ? 'lar' : ''}: ${drivers.map(d => `«${d.name}» ${d.delta >= 0 ? '+' : ''}${money(d.delta)}`).join(', ')}.`;
      }
      addBlock('Xarajat o‘zgarishi tarkibi', 'table', drivers.map(d => ({
        label: d.name, value: `${d.delta >= 0 ? '+' : ''}${money(d.delta)}`, hint: `${money(d.before)} → ${money(d.amount)}`,
        drill: { type: 'account', params: { account: d.code, from: r.from, to: r.to } },
      })));
      src('Joriy davr xarajati', money(curTotal));
      src('O‘tgan davr xarajati', money(prevTotal), { type: 'expense', params: { from: pack.prev_range.from, to: pack.prev_range.to } });
      answer.followups = ['Eng katta xarajatimiz nima?', 'Marjamiz qanday o‘zgargan?'];
      break;
    }
    case 'receivables': {
      answer.classification = 'FACT';
      answer.confidence_score = 97;
      const ar = pack.ar;
      if (!ar.total) {
        answer.text = 'Hozirda ochiq debitorlik qarz yo‘q — barcha hisob-fakturalar to‘langan. 🎉';
        answer.empty = true;
        break;
      }
      answer.text = `Jami debitorlik: ${money(ar.total)} (${ar.open_count} ta hujjat).\n• Muddati o‘tgan: ${money(ar.overdue)} (${ar.overdue_count} ta)\n• Bu hafta to‘lanishi kerak: ${money(ar.due_this_week)}\n• Bu oy: ${money(ar.due_this_month)}`;
      if (pack.late_payers.length) {
        answer.text += `\n\nTo‘lovni kechiktiruvchi mijozlar: ${pack.late_payers.map(p => `${p.name} (${money(p.overdue_amount || p.open_amount)})`).join(', ')}.`;
      }
      addBlock('Debitorlik yoshi', 'table', ar.aging.map(b => ({ label: b.label, value: money(b.amount), hint: `${b.count} ta hujjat` })));
      addBlock('Eng katta qarzdorlar', 'table', ar.customers.slice(0, 6).map(c => ({
        label: c.party_name, value: money(c.total), hint: c.overdue ? `muddati o‘tgan: ${money(c.overdue)}` : 'muddati kelmagan',
        drill: { type: 'party_invoices', params: { party_id: c.party_id } },
      })));
      src('Jurnal bo‘yicha AR qoldig‘i', money(ar.ledger_balance));
      src('Hujjatlar bo‘yicha', money(ar.invoices_open));
      answer.followups = ['Qaysi invoice overdue?', 'Bugun nima qilishim kerak?'];
      break;
    }
    case 'overdue_invoices':
    case 'unpaid_invoices': {
      const list = intent === 'overdue_invoices' ? pack.overdue_invoices : require('./invoices').list(companyId, { status: 'open', pageSize: 30 }).items;
      answer.classification = 'FACT';
      answer.confidence_score = 98;
      if (!list.length) {
        answer.text = intent === 'overdue_invoices' ? 'Muddati o‘tgan hisob-faktura yo‘q.' : 'To‘lanmagan hisob-faktura yo‘q.';
        answer.empty = true;
        break;
      }
      const total = U.sumBy(list, i => i.open_amount);
      answer.text = `${list.length} ta ${intent === 'overdue_invoices' ? 'muddati o‘tgan' : 'to‘lanmagan'} hisob-faktura, jami ${money(total)}.`;
      addBlock('Hisob-fakturalar', 'table', list.slice(0, 12).map(i => ({
        label: `${i.no} — ${i.customer_name}`, value: money(i.open_amount),
        hint: `muddat: ${i.due_date}${i.overdue_days ? ` • ${i.overdue_days} kun o‘tgan` : ''}`,
        drill: { type: 'invoice', params: { id: i.id } },
      })));
      src('Jami', money(total));
      answer.followups = ['Qaysi mijozlardan pul olishimiz kerak?', 'Mijozlarga eslatma yuborishim kerakmi?'];
      break;
    }
    case 'forecast': {
      const f = pack.forecast;
      answer.classification = 'PREDICTION';
      answer.confidence_score = f.data_quality === 'good' ? 75 : 55;
      if (!f.available) {
        answer.text = `${f.message}.\n\n${f.explanation}`;
        answer.empty = true;
        answer.confidence = 'low';
        break;
      }
      answer.text = `PROGNOZ (bashorat, fakt emas):\n• Joriy qoldiq: ${money(f.current_cash)}\n• ${f.days} kun ichida kutilayotgan tushum: ${money(f.totals.expected_in)}\n• Kutilayotgan chiqim: ${money(f.totals.expected_out)}\n• Prognoz qoldiq: ${money(f.totals.closing)}\n• Eng past nuqta: ${money(f.totals.min_balance)} (${f.totals.min_balance_date})`;
      addBlock('Horizontlar bo‘yicha prognoz', 'table', f.horizon_summary.map(h => ({ label: `${h.days} kun`, value: money(h.balance), hint: `sof o‘zgarish ${money(h.net)}` })));
      addBlock('Farazlar', 'note', [], { items: f.assumptions });
      src('Prognoz sifat', f.data_quality_label);
      answer.followups = ['Qaysi invoice\'lar to‘lanmagan?', 'Bugun nima qilishim kerak?'];
      break;
    }
    case 'today_tasks': {
      const work = require('./work').myWork(companyId, null, { skipAi: true });
      answer.classification = 'RECOMMENDATION';
      answer.confidence_score = 90;
      answer.text = `Bugun ${work.totals.total} ta vazifa bor:\n` + work.priorities.slice(0, 6).map((p, i) => `${i + 1}. ${p.title} — ${p.detail}`).join('\n');
      addBlock('Bugungi vazifalar', 'table', work.priorities.slice(0, 8).map(p => ({
        label: p.title, value: p.amount ? money(p.amount) : (p.count ? `${p.count} ta` : '—'), hint: p.detail, drill: p.link,
      })));
      for (const p of work.priorities.slice(0, 5)) src(p.title, p.detail);
      answer.followups = ['Xatolarimiz bormi?', 'Qaysi invoice\'lar to‘lanmagan?'];
      break;
    }
    case 'errors': {
      const radar = pack.radar_summary;
      answer.classification = 'CALCULATION';
      answer.confidence_score = 92;
      if (!radar.total) {
        answer.text = 'Xato Radar tekshiruvidan o‘tdi: hozircha muammo aniqlanmadi.';
        answer.empty = true;
        break;
      }
      answer.text = `Xato Radar ${radar.total} ta topilma aniqladi (${radar.critical + radar.high} ta muhim), umumiy moliyaviy ta’sir ~${money(radar.financial_impact)}.\n\nAsosiy muammolar:\n` +
        pack.radar_issues.slice(0, 5).map((i, n) => `${n + 1}. ${i.title} — ${i.what}`).join('\n');
      addBlock('Topilmalar', 'table', pack.radar_issues.slice(0, 8).map(i => ({
        label: i.title, value: i.impact ? money(i.impact) : '—',
        hint: `${i.severity_label} • ishonch ${i.confidence}% • ${i.what.slice(0, 90)}`,
        drill: { type: 'radar', params: { id: i.id } },
      })));
      src('Jiddiylik bo‘yicha', `kritik ${radar.critical}, yuqori ${radar.high}, o‘rta ${radar.medium}, past ${radar.low}`);
      answer.followups = ['Qanday tuzatsam bo‘ladi?', 'Bugun nima qilishim kerak?'];
      break;
    }
    case 'top_suppliers': {
      const rows = pack.suppliers.rows;
      answer.classification = 'CALCULATION';
      answer.confidence_score = 95;
      if (!rows.length) { answer.text = 'Bu davrda yetkazib beruvchilar bo‘yicha xarajat ma’lumoti yo‘q.'; answer.empty = true; break; }
      const top = rows[0];
      answer.text = `Bu davrda eng ko‘p xarajat «${top.name}» bilan: ${money(top.amount)} (${top.share}% ulush, ${top.count} ta yozuv).`;
      addBlock('Yetkazib beruvchilar', 'table', rows.map(s => ({
        label: s.name, value: money(s.amount), share: `${s.share}%`,
        drill: { type: 'party_bills', params: { party_id: s.party_id, from: r.from, to: r.to } },
      })));
      if (top.share >= 45) {
        addBlock('Risk', 'warning', [], { text: `Bitta yetkazib beruvchiga ${top.share}% qaramlik — diversifikatsiya tavsiya etiladi.` });
        answer.classification = 'RECOMMENDATION';
      }
      src('Jami xarajat', money(pack.expenses.total));
      break;
    }
    case 'cash': {
      const cash = pack.cash;
      answer.classification = 'FACT';
      answer.confidence_score = 99;
      answer.text = `Kassa va bank hisoblari bo‘yicha jami qoldiq: ${money(cash.total)}.`;
      addBlock('Hisoblar', 'table', cash.rows.map(a => ({ label: `${a.code} ${a.name}`, value: money(a.balance), hint: a.type === 'cash' ? 'Kassa' : 'Bank hisobi' })));
      src('Bugungi sana', U.today());
      answer.followups = ['Cash flow keyingi oy qanday bo‘ladi?', 'Kreditorlik qancha?'];
      break;
    }
    case 'payables': {
      const ap = pack.ap;
      answer.classification = 'FACT';
      answer.confidence_score = 97;
      answer.text = `Kreditorlik qarz: ${money(ap.total)} (${ap.open_count} ta hisob).\n• Muddati o‘tgan: ${money(ap.overdue)}\n• 7 kun ichida to‘lanishi kerak: ${money(ap.due_this_week)} (${ap.due_next_7_days_count} ta hisob)`;
      if (pack.upcoming_bills.length) {
        addBlock('Yaqin to‘lovlar', 'table', pack.upcoming_bills.slice(0, 8).map(b => ({
          label: `${b.no} — ${b.supplier_name}`, value: money(b.open_amount), hint: `muddat: ${b.due_date}`,
          drill: { type: 'bill', params: { id: b.id } },
        })));
      }
      addBlock('Kreditorlik yoshi', 'table', ap.aging.map(b => ({ label: b.label, value: money(b.amount), hint: `${b.count} ta hisob` })));
      src('Jami kreditorlik', money(ap.total), { type: 'payables', params: {} });
      answer.confidence = conf(answer.confidence_score);
      break;
    }
    case 'inventory': {
      const inv = pack.inventory;
      answer.classification = 'FACT';
      answer.confidence_score = 95;
      answer.text = `Ombor qiymati: ${money(inv.total_value)} (${inv.total_skus} ta SKU, ${inv.total_units} birlik).\nMinimum darajadan past: ${inv.low_stock.length} ta mahsulot.\nManfiy qoldiq: ${inv.negative_stock.length} ta.`;
      if (inv.low_stock.length) addBlock('Minimumdan past mahsulotlar', 'table', inv.low_stock.slice(0, 8).map(p => ({ label: p.name, value: `${p.stock} ${p.unit}`, hint: `minimum: ${p.min_stock} ${p.unit}` })));
      if (!inv.consistent) addBlock('Diqqat', 'warning', [], { text: `Ombor kartochkalari (${money(inv.total_value)}) va jurnaldagi qiymat (${money(inv.ledger_value)}) o‘rtasida ${money(inv.difference)} farq bor — Xato Radar tekshiradi.` });
      break;
    }
    case 'tax': {
      const tax = require('./tax').summary(companyId, r);
      answer.classification = 'CALCULATION';
      answer.confidence_score = 90;
      answer.text = `${r.label} uchun soliq ko‘rsatkichlari:\n• QQS hisoblanadigan (chiqim): ${money(pack.vat.payable)}\n• QQS hisobga olinadigan (kirim): ${money(pack.vat.receivable)}\n• Sof QQS: ${money(pack.vat.payable - pack.vat.receivable)}\n• Soliq rejimi: ${tax.mode_label}`;
      addBlock('Soliq majburiyatlari', 'table', tax.items.map(i => ({ label: i.title, value: money(i.amount), hint: i.due_date ? `muddat: ${i.due_date}` : i.note })));
      answer.text += '\n\nEslatma: bu ko‘rsatkichlar buxgalteriya hisobi asosida hisoblangan va soliq deklaratsiyasi bilan solishtirilishi kerak. BUXAI huquqiy muvofiqlik kafolatini bermaydi.';
      answer.followups = ['QQS qancha to‘lashimiz kerak?', 'Soliq muddatlari qachon?'];
      break;
    }
    case 'health': {
      const h = pack.health;
      if (!h.available) {
        answer.text = `${h.message}.\n\n${h.explanation}`;
        answer.empty = true;
        answer.confidence_score = 100;
        break;
      }
      answer.classification = 'CALCULATION';
      answer.confidence_score = 88;
      answer.text = `Moliyaviy salomatlik: ${h.message}\n\n${h.explanation}`;
      addBlock('Kuchli tomonlar', 'table', h.strengths.map(s => ({ label: s.label, value: `${s.score}/100`, hint: s.reason })));
      addBlock('Xatarlar', 'table', h.risks.map(s => ({ label: s.label, value: `${s.score}/100`, hint: s.reason })));
      break;
    }
    case 'margin': {
      const p = pack.pnl;
      answer.classification = 'CALCULATION';
      answer.confidence_score = 94;
      answer.text = p.revenue > 0
        ? `Yalpi marja: ${p.grossMargin}% (yalpi foyda ${money(p.grossProfit)}). Sof marja: ${p.netMargin}% (sof foyda ${money(p.netProfit)}).`
        : `Bu davrda daromad yo‘q — marja hisoblanmaydi. Xarajat ${money(p.totalExpense)}.`;
      addBlock('Oylik marja dinamikasi', 'table', pack.trend.map(t => ({
        label: t.full_label, value: t.revenue ? `${U.round(((t.revenue - t.expense) / t.revenue) * 100, 1)}%` : '—',
        hint: `daromad ${money(t.revenue)} • xarajat ${money(t.expense)}`,
      })));
      break;
    }
    case 'sales':
    case 'customers': {
      const rows = pack.customers.rows;
      answer.classification = 'CALCULATION';
      answer.confidence_score = 95;
      if (!rows.length) { answer.text = 'Bu davrda sotuv ma’lumoti yo‘q.'; answer.empty = true; break; }
      answer.text = `Bu davrda jami daromad ${money(pack.revenue)}, eng katta mijozlar:\n` + rows.slice(0, 5).map((c, i) => `${i + 1}. ${c.name} — ${money(c.amount)} (${c.share}%)`).join('\n');
      addBlock('Mijozlar bo‘yicha daromad', 'table', rows.map(c => ({
        label: c.name, value: money(c.amount), share: `${c.share}%`, drill: { type: 'party_invoices', params: { party_id: c.party_id, from: r.from, to: r.to } },
      })));
      if (rows[0] && rows[0].share >= 40) addBlock('Konsentratsiya riski', 'warning', [], { text: `Eng katta mijoz daromadning ${rows[0].share}% ini beradi — mijoz bazasini kengaytirish tavsiya etiladi.` });
      break;
    }
    case 'advice':
    case 'overview':
    default: {
      const p = pack.pnl;
      answer.classification = 'FACT';
      answer.confidence_score = 93;
      answer.text = `${r.label} holati:\n• Daromad: ${money(p.revenue)}\n• Xarajat: ${money(p.totalExpense)}\n• Sof foyda: ${money(p.netProfit)}\n• Kassa/bank: ${money(pack.cash.total)}\n• Debitorlik: ${money(pack.ar.total)} (muddati o‘tgan ${money(pack.ar.overdue)})\n• Kreditorlik: ${money(pack.ap.total)}\n• Moliyaviy salomatlik: ${pack.health.available ? pack.health.message : 'hisoblash uchun ma’lumot yetarli emas'}\n• Xato Radar: ${pack.radar_summary.total} ta topilma`;
      addBlock('Asosiy ko‘rsatkichlar', 'metrics', [
        { label: 'Daromad', value: money(p.revenue) },
        { label: 'Xarajat', value: money(p.totalExpense) },
        { label: 'Sof foyda', value: money(p.netProfit) },
        { label: 'Kassa va bank', value: money(pack.cash.total) },
        { label: 'Debitorlik', value: money(pack.ar.total) },
        { label: 'Kreditorlik', value: money(pack.ap.total) },
      ], { note: 'Barcha raqamlar yagona buxgalteriya jurnalidan olingan.' });
      if (pack.radar_issues.length) {
        addBlock('Diqqat talab qiladigan masalalar', 'table', pack.radar_issues.slice(0, 4).map(i => ({
          label: i.title, value: i.impact ? money(i.impact) : '—', hint: i.what, drill: { type: 'radar', params: { id: i.id } },
        })));
        answer.classification = 'RECOMMENDATION';
      }
      answer.followups = ['Bu oy qancha foyda qildik?', 'Eng katta xarajatimiz nima?', 'Xatolarimiz bormi?', 'Bugun nima qilishim kerak?'];
    }
  }
  answer.confidence = conf(answer.confidence_score);
  answer.confidence_label = confLabel(answer.confidence);
  answer.classification_label = { FACT: 'Fakt', CALCULATION: 'Hisob-kitob', PREDICTION: 'Prognoz', RECOMMENDATION: 'Tavsiya' }[answer.classification];
  return answer;
}

// ────────────────────────── LLM provayder (ixtiyoriy) ───────────────────────

function providerConfig() {
  const url = process.env.BUXAI_LLM_URL;
  const key = process.env.BUXAI_LLM_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.BUXAI_LLM_MODEL || 'gpt-4o-mini';
  if (!url && !key) return null;
  return { url: url || 'https://api.openai.com/v1/chat/completions', key, model };
}

async function askLLM(question, pack, localAnswer) {
  const cfg = providerConfig();
  if (!cfg || !cfg.key) return null;
  const facts = {
    period: pack.range.label,
    revenue: pack.revenue, expense: pack.expense, net_profit: pack.net_profit,
    gross_margin: pack.gross_margin, net_margin: pack.net_margin,
    revenue_change_pct: pack.revenue_change, expense_change_pct: pack.expense_change,
    cash: pack.cash.total, receivables: pack.ar.total, receivables_overdue: pack.ar.overdue,
    payables: pack.ap.total, payables_due_7_days: pack.ap.due_this_week,
    financial_health: pack.health.available ? { score: pack.health.score, rating: pack.health.rating, risks: pack.health.risks.map(r => r.reason) } : null,
    radar_issues: pack.radar_issues.map(i => ({ title: i.title, what: i.what, impact: i.impact, severity: i.severity })),
    top_expenses: pack.expenses.rows.slice(0, 6),
    top_customers: pack.customers.rows.slice(0, 6),
    top_suppliers: pack.suppliers.rows.slice(0, 6),
    forecast_30d: pack.forecast.available ? { closing: pack.forecast.totals.closing, min: pack.forecast.totals.min_balance, assumptions: pack.forecast.assumptions } : null,
    monthly_trend: pack.trend,
    local_draft: localAnswer.text,
  };
  const body = {
    model: cfg.model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'Sen BUXAI — O‘zbekiston buxgalterlari uchun moliyaviy yordamchisan. FAQAT berilgan JSON raqamlaridan foydalanasan. Yangi raqam o‘ylab topishing qat’iyan man etiladi. Javobni o‘zbek tilida, qisqa va aniq yozasan. Prognoz haqida gapirganda "prognoz" deb belgilaysan. Raqamlar bilan birga ular qaysi davrga tegishli ekanini ko‘rsatasan.',
      },
      { role: 'user', content: `Savol: ${question}\n\nMOLIYAVIY MA’LUMOTLAR (JSON):\n${JSON.stringify(facts)}\n\nShu ma’lumotlarga asoslanib javob ber. Har bir raqam yuqoridagi JSONdan olinishi shart.` },
    ],
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`provayder ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || data?.message?.content || data?.response;
    if (!text || typeof text !== 'string') throw new Error('bo‘sh javob');
    return { text: text.trim(), provider: cfg.model };
  } catch (e) {
    console.error('[ai] provayder xatosi:', e.message);
    return { error: e.message };
  }
}

// ───────────────────────────── Asosiy savol-javob ───────────────────────────

async function ask(companyId, question, user, { range, meta = {} } = {}) {
  const q = U.str(question, { max: 1000, required: true, field: 'Savol' });
  require('./companies').checkLimit(companyId, 'ai_question');
  const r = range ? (typeof range === 'string' ? U.resolveRange({ range }) : range) : U.resolveRange({ range: 'month' });
  const pack = dataPack(companyId, { range: r });
  const intent = detectIntent(q);
  const answer = buildAnswer(companyId, intent, pack);
  const llm = await askLLM(q, pack, answer);
  if (llm && llm.text) {
    answer.text = llm.text;
    answer.provider = `LLM: ${llm.provider}`;
    answer.llm_used = true;
  } else {
    answer.provider = 'BUXAI ichki dvigateli (ma’lumotga bog‘langan)';
    answer.llm_used = false;
    if (llm && llm.error) answer.provider_note = `Tashqi AI provayderi javob bermadi (${llm.error}) — tizim o‘zining aniq hisob-kitob javobini ko‘rsatdi.`;
  }
  const message = {
    id: store.uid('msg'), company_id: companyId, user_id: user ? user.id : null,
    question: q, intent, answer, created_at: store.nowISO(),
  };
  const col = store.collection('chatMessages');
  col.push(message);
  if (col.length > 5000) col.splice(0, col.length - 5000);
  store.save();
  require('./companies').bump(companyId, 'ai_question');
  require('./audit').log({ company_id: companyId, user, action: 'ai.ask', entity: 'ai', entity_id: message.id, summary: `AI savol: ${q.slice(0, 120)}`, after: { intent, classification: answer.classification, confidence: answer.confidence }, meta });
  return { id: message.id, question: q, ...answer };
}

function history(companyId, { limit = 50, user_id } = {}) {
  return U.sortBy(store.collection('chatMessages').filter(m => m.company_id === companyId && (!user_id || m.user_id === user_id)), m => m.created_at, 'desc').slice(0, limit);
}

// ──────────────────────────── AI Business Advisor ───────────────────────────

/**
 * Bugungi kunlik boshqaruv paneli: vazifalar, xatarlar, imkoniyatlar, tavsiyalar.
 * Faqat real ma'lumotlardan.
 */
function advisor(companyId) {
  const pack = dataPack(companyId, { range: U.resolveRange({ range: 'month' }) });
  const work = require('./work').myWork(companyId, null, { skipAi: true });
  const health = pack.health;
  const forecast = pack.forecast;
  const priorities = work.priorities.map((p, i) => ({ ...p, rank: i + 1 }));
  const risks = [];
  const opportunities = [];
  const recommendations = [];

  if (!pack.has_data) {
    return {
      available: false,
      message: 'Tahlil uchun ma’lumot yetarli emas',
      explanation: 'Kompaniyada buxgalteriya yozuvlari yo‘q. Bir necha tranzaksiya yoki bank ko‘chirmasi yuklangandan so‘ng AI Business Advisor real tahlil qila oladi.',
      priorities: [], risks: [], opportunities: [], recommendations: [],
      generated_at: store.nowISO(),
    };
  }

  for (const c of health.components || []) {
    if (c.score == null) continue;
    if (c.score < 55) risks.push({ title: c.label, detail: c.reason, severity: c.score < 40 ? 'high' : 'medium', evidence: c.evidence });
    else if (c.score >= 80) opportunities.push({ title: c.label, detail: c.reason, evidence: c.evidence });
  }
  if (pack.ar.overdue > 0) risks.push({ title: 'Muddati o‘tgan debitorlik', detail: `${U.fmtMoney(pack.ar.overdue)} undirilmagan (${pack.ar.overdue_count} ta hujjat).`, severity: 'high', evidence: [{ label: 'Muddati o‘tgan', value: U.fmtMoney(pack.ar.overdue) }] });
  if (pack.ap.overdue > 0) risks.push({ title: 'Muddati o‘tgan kreditorlik', detail: `${U.fmtMoney(pack.ap.overdue)} to‘lanmagan — penya xavfi.`, severity: 'medium', evidence: [{ label: 'Muddati o‘tgan', value: U.fmtMoney(pack.ap.overdue) }] });
  if (forecast.available && forecast.risk.level !== 'low') risks.push({ title: 'Pul oqimi prognozi', detail: forecast.risk.message, severity: forecast.risk.level === 'high' ? 'high' : 'medium', evidence: forecast.drivers });
  for (const issue of pack.radar_issues.filter(i => i.severity === 'critical' || i.severity === 'high').slice(0, 4)) {
    risks.push({ title: issue.title, detail: issue.what, severity: issue.severity === 'critical' ? 'high' : 'medium', evidence: issue.evidence, link: { page: 'radar', params: { id: issue.id } } });
  }

  if (pack.expenses.rows.length) {
    const top = pack.expenses.rows[0];
    recommendations.push({
      title: 'Xarajat tarkibini optimallashtirish',
      detail: `Eng katta yo‘nalish — «${top.label}» (${U.fmtMoney(top.amount)}, ${top.share}%). Uni batafsil tahlil qilish orqali 5–10% tejash imkoniyati bo‘lishi mumkin.`,
      classification: 'RECOMMENDATION',
      evidence: [{ label: top.label, value: U.fmtMoney(top.amount), drill: { type: 'account', params: { account: top.code } } }],
    });
  }
  if (pack.ar.overdue > 0) {
    recommendations.push({
      title: 'Debitorlikni undirish',
      detail: `${U.fmtMoney(pack.ar.overdue)} muddati o‘tgan qarzni undirish pul oqimini yaxshilaydi.${pack.late_payers.length ? ` Eng muammoli mijozlar: ${pack.late_payers.slice(0, 3).map(p => p.name).join(', ')}.` : ''}`,
      classification: 'RECOMMENDATION',
      evidence: pack.late_payers.slice(0, 3).map(p => ({ label: p.name, value: U.fmtMoney(p.overdue_amount || p.open_amount), hint: p.avg_payment_days ? `o‘rtacha ${p.avg_payment_days} kun` : null })),
      actions: [{ label: 'Debitorlikni ko‘rish', link: { page: 'receivables', params: {} } }],
    });
  }
  if (pack.inventory.low_stock.length) {
    recommendations.push({
      title: 'Ombor zaxirasini to‘ldirish',
      detail: `${pack.inventory.low_stock.length} ta mahsulot minimum darajadan past — sotuv to‘xtab qolmasligi uchun xarid rejalashtirish kerak.`,
      classification: 'RECOMMENDATION',
      evidence: pack.inventory.low_stock.slice(0, 5).map(p => ({ label: p.name, value: `${p.stock} ${p.unit}`, hint: `minimum ${p.min_stock}` })),
      actions: [{ label: 'Omborni ko‘rish', link: { page: 'inventory', params: {} } }],
    });
  }
  if (pack.customers.rows.length && pack.customers.rows[0].share >= 40) {
    recommendations.push({
      title: 'Mijoz bazasini diversifikatsiya qilish',
      detail: `«${pack.customers.rows[0].name}» daromadning ${pack.customers.rows[0].share}% ini beradi — bu bitta mijozga qaramlik riski.`,
      classification: 'RECOMMENDATION',
      evidence: pack.customers.rows.slice(0, 4).map(c => ({ label: c.name, value: U.fmtMoney(c.amount), hint: `${c.share}%` })),
    });
  }
  if (pack.suppliers.rows.length && pack.suppliers.rows[0].share >= 45) {
    opportunities.push({ title: 'Xarid shartlarini qayta ko‘rish', detail: `Eng katta yetkazib beruvchi «${pack.suppliers.rows[0].name}» bilan hajm oshgan (${pack.suppliers.rows[0].share}%) — chegirma yoki to‘lov muddatini kelishish imkoniyati bor.` });
  }
  if (health.available && health.strengths.length) {
    opportunities.push(...health.strengths.slice(0, 2).map(s => ({ title: s.label, detail: s.reason, evidence: s.evidence })));
  }

  const greeting = work.totals.total === 0 && !risks.length
    ? 'Bugun shoshilinch ish yo‘q — barcha nazoratlar yaxshi holatda.'
    : `Bugun ${work.totals.total} ta muhim ish bor.`;

  return {
    available: true,
    greeting,
    summary: {
      revenue: pack.revenue, expense: pack.expense, net_profit: pack.net_profit,
      cash: pack.cash.total, receivables: pack.ar.total, receivables_overdue: pack.ar.overdue,
      payables: pack.ap.total, payables_due_7d: pack.ap.due_this_week,
      health: health.available ? { score: health.score, rating: health.rating } : null,
      radar: { total: pack.radar_summary.total, high: pack.radar_summary.high + pack.radar_summary.critical, impact: pack.radar_summary.financial_impact },
      forecast_30d: forecast.available ? { closing: forecast.totals.closing, min: forecast.totals.min_balance, risk: forecast.risk } : null,
    },
    priorities,
    risks: risks.slice(0, 8),
    opportunities: opportunities.slice(0, 6),
    recommendations: recommendations.slice(0, 6),
    data_range: pack.range,
    generated_at: store.nowISO(),
    disclaimer: 'Bu tahlil faqat tizimdagi buxgalteriya ma’lumotlariga asoslangan. Prognozlar bashorat bo‘lib, kafolat emas.',
  };
}

/** Bugungi qisqa AI xulosasi (dashboard uchun) */
function dailyInsight(companyId) {
  const pack = dataPack(companyId, { range: U.resolveRange({ range: 'month' }) });
  if (!pack.has_data) {
    return {
      available: false,
      title: 'AI tahlili',
      text: 'Tahlil qilish uchun ma’lumot yetarli emas. Tranzaksiya, hisob-faktura yoki bank ko‘chirmasini kiriting — shundan so‘ng AI real raqamlar asosida xulosa beradi.',
      action: { label: 'Birinchi operatsiyani kiritish', page: 'transactions' },
    };
  }
  const items = [];
  const radar = pack.radar_summary;
  if (radar.total) {
    items.push({ type: 'warning', text: `Xato Radar ${radar.total} ta topilma aniqladi (${radar.critical + radar.high} muhim), moliyaviy ta’sir ~${U.fmtMoney(radar.financial_impact)}.`, link: { page: 'radar', params: {} }, severity: radar.critical ? 'critical' : 'high' });
  }
  if (pack.ar.overdue > 0) items.push({ type: 'warning', text: `${U.fmtMoney(pack.ar.overdue)} muddati o‘tgan debitorlik — ${pack.ar.overdue_count} ta hisob-faktura undirilishi kerak.`, link: { page: 'receivables', params: {} } });
  if (pack.upcoming_bills.length) items.push({ type: 'info', text: `7 kun ichida ${pack.upcoming_bills.length} ta yetkazib beruvchi to‘lovi (${U.fmtMoney(U.sumBy(pack.upcoming_bills, b => b.open_amount))}) to‘lanishi kerak.`, link: { page: 'payables', params: {} } });
  if (pack.forecast.available && pack.forecast.risk.level !== 'low') items.push({ type: 'warning', text: pack.forecast.risk.message, link: { page: 'cashflow', params: {} } });
  if (pack.pnl.netProfit !== 0) items.push({ type: 'positive', text: `${pack.range.label} natijasi: sof foyda ${U.fmtMoney(pack.pnl.netProfit)}${pack.pnl.netMargin != null ? ` (marja ${pack.pnl.netMargin}%)` : ''}.`, link: { page: 'reports', params: { report: 'pnl' } } });
  if (!items.length) items.push({ type: 'positive', text: 'Barcha nazoratlar yaxshi holatda: muhim muammo aniqlanmadi.', link: { page: 'radar', params: {} } });
  const primary = items.find(i => i.type === 'warning') || items[0];
  return {
    available: true,
    title: 'AI tahlili',
    text: primary.text,
    items: items.slice(0, 4),
    link: primary.link,
    data_range: pack.range.label,
    generated_at: store.nowISO(),
    disclaimer: 'Faqat tizimdagi real buxgalteriya ma’lumotlariga asoslangan.',
  };
}

module.exports = {
  dataPack, ask, history, detectIntent, financialHealth, cashForecast, advisor, dailyInsight,
  answerFor: buildAnswer, providerConfig, NO_DATA,
};
