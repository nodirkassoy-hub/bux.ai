'use strict';
/**
 * BUXAI — Soliq markazi (O'zbekiston uchun mahalliylashtirilgan).
 *
 * MUHIM (halollik qoidasi): BUXAI huquqiy muvofiqlik KAFOLATINI BERMAYDI.
 * Standart soliq kalendari O'zbekiston amaliyotidagi odatiy sanalarga asoslangan,
 * lekin har bir muddat `verified: false` belgisi bilan keladi va buxgalter uni
 * tasdiqlashi (yoki o'zgartirishi) kerak. Tasdiqlanmagan sanalar "tekshirilmagan"
 * deb ko'rsatiladi — yashirilmaydi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const DISCLAIMER = 'Bu ko‘rsatkichlar buxgalteriya hisobi ma’lumotlari asosida hisoblangan va soliq deklaratsiyasi bilan solishtirilishi shart. BUXAI yuridik/texnik muvofiqlik kafolatini bermaydi — yakuniy javobgarlik buxgalter va kompaniya zimmasida.';

/** Standart soliq majburiyatlari shabloni (sanalar buxgalter tomonidan tasdiqlanishi kerak) */
const TEMPLATE = [
  {
    key: 'vat_monthly', title: 'QQS (qo‘shilgan qiymat solig‘i) deklaratsiyasi va to‘lovi',
    frequency: 'monthly', due_day: 20, applies: (ctx) => ctx.tax_mode === 'vat',
    description: 'Hisobot oyidan keyingi oyning 20-kuniga qadar',
    source_note: 'Odatiy amaliyot: hisobot oyidan keyingi oyning 20-kuni. Soliq organi talablarini tekshiring.',
  },
  {
    key: 'turnover_quarterly', title: 'Aylanma soliq (soddalashtirilgan tizim) hisoboti',
    frequency: 'quarterly', due_day: 15, applies: (ctx) => ctx.tax_mode === 'simplified',
    description: 'Chorakdan keyingi oyning 15-kuniga qadar',
    source_note: 'Odatiy amaliyot: chorakdan keyingi oyning 15-kuni. Soliq organi talablarini tekshiring.',
  },
  {
    key: 'payroll_monthly', title: 'Jismoniy shaxslardan olinadigan daromad solig‘i va ijtimoiy to‘lovlar',
    frequency: 'monthly', due_day: 15, applies: (ctx) => ctx.has_payroll,
    description: 'Hisobot oyidan keyingi oyning 15-kuniga qadar',
    source_note: 'Odatiy amaliyot: hisobot oyidan keyingi oyning 15-kuni. Ijtimoiy fond talablarini tekshiring.',
  },
  {
    key: 'profit_tax', title: 'Foyda solig‘i hisob-kitobi',
    frequency: 'quarterly', due_day: 20, applies: () => true,
    description: 'Chorak yakuni bo‘yicha avans to‘lovlari',
    source_note: 'Odatiy amaliyot: chorakdan keyingi oyning 20-kuni. Soliq organi talablarini tekshiring.',
  },
  {
    key: 'annual_report', title: 'Yillik moliyaviy hisobot va yillik soliq deklaratsiyasi',
    frequency: 'annual', due_day: 15, due_month: 2, applies: () => true,
    description: 'Hisobot yilidan keyingi yilning 15-fevraliga qadar',
    source_note: 'Odatiy amaliyot: keyingi yilning 15-fevrali. Tekshirib tasdiqlang.',
  },
];

function configFor(companyId) {
  const settings = ledger.getSettings(companyId);
  return { ...(settings.tax_calendar || {}) };
}

/** Kalendar muddatlarini hisoblash (davr → sana) */
function dueDateFor(item, period, cfg) {
  const conf = cfg[item.key] || {};
  const dueDay = conf.due_day || item.due_day;
  if (item.frequency === 'monthly') {
    const next = U.addMonths(period, 1);
    return `${next}-${U.pad(Math.min(28, dueDay))}`;
  }
  if (item.frequency === 'quarterly') {
    const [y, m] = period.split('-').map(Number);
    const qEnd = Math.ceil(m / 3) * 3;
    const after = U.addMonths(`${y}-${U.pad(qEnd)}`, 1);
    return `${after}-${U.pad(Math.min(28, dueDay))}`;
  }
  const y = period.slice(0, 4);
  const month = conf.due_month || item.due_month || 2;
  const nextYear = String(Number(y) + 1);
  return `${nextYear}-${U.pad(month)}-${U.pad(Math.min(28, dueDay))}`;
}

function periodFor(item, refPeriod) {
  if (item.frequency === 'monthly') return refPeriod;
  if (item.frequency === 'annual') return refPeriod;
  const [y, m] = refPeriod.split('-').map(Number);
  const qEnd = Math.ceil(m / 3) * 3;
  return `${y}-${U.pad(qEnd)}`;
}

function isMarked(companyId, key, period) {
  return store.collection('taxMarks').find(m => m.company_id === companyId && m.key === key && m.period === period) || null;
}

/**
 * Soliq kalendari: muddatlar, holatlari va real summalar.
 */
function calendar(companyId, { monthsBack = 6, monthsForward = 2 } = {}) {
  const settings = ledger.getSettings(companyId);
  const company = store.collection('companies').find(c => c.id === companyId) || {};
  const payrollAccount = ledger.accountsOf(companyId).filter(a => a.role === 'payroll');
  const hasPayroll = payrollAccount.length > 0 && U.sumBy(payrollAccount, a => ledger.balanceOf(companyId, a.code)) !== 0 ||
    ledger.accountsOf(companyId).some(a => a.code === '9410' && ledger.balanceOf(companyId, a.code) !== 0);
  const ctx = { tax_mode: settings.tax_mode, has_payroll: hasPayroll };
  const cfg = configFor(companyId);
  const today = U.today();
  const periods = [];
  for (let i = monthsBack; i >= -monthsForward; i--) periods.push(U.addMonths(U.currentPeriod(), -i));
  const rows = [];
  for (const item of TEMPLATE) {
    if (!item.applies(ctx)) continue;
    const seenPeriods = new Set();
    for (const ref of periods) {
      const period = periodFor(item, ref);
      if (seenPeriods.has(period)) continue;
      seenPeriods.add(period);
      const due = dueDateFor(item, period, cfg);
      const mark = isMarked(companyId, item.key, period);
      const status = mark ? 'done' : due < today ? 'overdue' : U.daysBetween(today, due) <= 10 ? 'due_soon' : (ref > U.currentPeriod() ? 'upcoming' : 'pending');
      const amount = obligationAmount(companyId, item.key, period);
      rows.push({
        key: item.key, title: item.title, period, period_label: U.periodLabel(period),
        due_date: due, frequency: item.frequency, description: item.description,
        source_note: item.source_note,
        verified: !!(cfg[item.key] && cfg[item.key].verified),
        status, status_label: status === 'done' ? 'Bajarilgan' : status === 'overdue' ? 'Muddati o‘tgan' : status === 'due_soon' ? 'Muddat yaqin' : status === 'upcoming' ? 'Kelgusi' : 'Rejalashtirilgan',
        critical: ['vat_monthly', 'payroll_monthly', 'turnover_quarterly'].includes(item.key),
        amount, amount_basis: amountNote(item.key, period, amount),
        mark: mark ? { at: mark.marked_at, by: mark.marked_by_name, note: mark.note } : null,
      });
    }
  }
  const sorted = U.sortBy(rows, r => r.due_date);
  return sorted;
}

function amountNote(key, period, amount) {
  if (key === 'vat_monthly') return `QQS hisob-kitobidan (${U.periodLabel(period)})`;
  if (key === 'turnover_quarterly') return `Chorak aylanmasidan`;
  if (key === 'payroll_monthly') return 'Ish haqi va ijtimoiy to‘lovlar hisobidan';
  if (key === 'profit_tax') return amount ? 'Foyda solig‘i hisobi' : 'Foyda bo‘lmaganda hisoblanmaydi';
  return 'Hisobot davri yakuni';
}

/** Soliq majburiyati summasi (real jurnaldan) */
function obligationAmount(companyId, key, period) {
  const from = key === 'annual_report' ? `${period.slice(0, 4)}-01-01` : (key === 'turnover_quarterly' ? U.periodStart(U.addMonths(period, -2)) : U.periodStart(period));
  const to = key === 'annual_report' ? `${period.slice(0, 4)}-12-31` : U.periodEnd(period);
  const pnl = ledger.periodSummary(companyId, { from, to });
  if (key === 'vat_monthly') {
    const vatOut = periodVat(companyId, from, to, 'vat_out');
    const vatIn = periodVat(companyId, from, to, 'vat_in');
    return Math.max(0, vatOut - vatIn);
  }
  if (key === 'turnover_quarterly') return Math.round(pnl.revenue * 0.04); // aylanma soliqning odatiy stavkasi
  if (key === 'payroll_monthly') {
    const accounts = ledger.accountsOf(companyId).filter(a => a.role === 'payroll');
    const moves = ledger.accountMovements(companyId, { from, to });
    return U.sumBy(accounts, a => {
      const row = moves.get(a.code);
      if (!row) return 0;
      return Math.max(0, row.credit - row.debit);
    });
  }
  if (key === 'profit_tax') return Math.max(0, Math.round(pnl.profitBeforeTax * 0.15));
  return 0;
}
function periodVat(companyId, from, to, role) {
  const accounts = ledger.accountsOf(companyId).filter(a => a.role === role);
  const moves = ledger.accountMovements(companyId, { from, to });
  return U.sumBy(accounts, a => {
    const row = moves.get(a.code);
    if (!row) return 0;
    return role === 'vat_out' ? (row.credit - row.debit) : (row.debit - row.credit);
  });
}

function summary(companyId, range) {
  const r = range || U.resolveRange({ range: 'month' });
  const settings = ledger.getSettings(companyId);
  const vatOut = periodVat(companyId, r.from, r.to, 'vat_out');
  const vatIn = periodVat(companyId, r.from, r.to, 'vat_in');
  const pnl = ledger.periodSummary(companyId, r);
  const payrollAccounts = ledger.accountsOf(companyId).filter(a => a.role === 'payroll');
  const payrollMoves = ledger.accountMovements(companyId, { from: r.from, to: r.to });
  const payrollTax = U.sumBy(payrollAccounts, a => {
    const row = payrollMoves.get(a.code);
    return row ? Math.max(0, row.credit - row.debit) : 0;
  });
  const modeLabel = settings.tax_mode === 'vat' ? 'QQS to‘lovchisi' : settings.tax_mode === 'simplified' ? 'Soddalashtirilgan tizim (aylanma soliq)' : 'Soliq rejimi ko‘rsatilmagan';
  const items = [
    {
      key: 'vat_output', title: 'QQS hisoblanadigan (sotuvdan)', amount: vatOut,
      note: settings.tax_mode === 'vat' ? 'Sotuvlar bo‘yicha hisoblangan QQS' : 'Rejim QQS emas — ma’lumot uchun',
      drill: { type: 'account', params: { account: ledger.roleCode(companyId, 'vat_out'), from: r.from, to: r.to } },
    },
    {
      key: 'vat_input', title: 'QQS hisobga olinadigan (xariddan)', amount: vatIn,
      note: 'Xaridlar bo‘yicha to‘lanadigan QQS (offset)',
      drill: { type: 'account', params: { account: ledger.roleCode(companyId, 'vat_in'), from: r.from, to: r.to } },
    },
    { key: 'vat_net', title: 'Budjetga to‘lanadigan sof QQS', amount: Math.max(0, vatOut - vatIn), note: 'QQS chiqim − QQS kirim' },
    { key: 'payroll', title: 'Ish haqi bo‘yicha soliq/to‘lovlar qarzi', amount: payrollTax, note: 'Ish haqi va ijtimoiy to‘lovlar hisoblaridan' },
    { key: 'turnover', title: 'Daromad (aylanma)', amount: pnl.revenue, note: 'Soliq bazasi sifatida hisoblanadi' },
    { key: 'profit_before_tax', title: 'Soliqgacha foyda', amount: pnl.profitBeforeTax, note: 'Foyda solig‘i bazasi' },
    { key: 'income_tax_booked', title: 'Hisobga olingan foyda solig‘i', amount: pnl.incomeTax, note: 'Jurnalga kiritilgan summa' },
  ];
  const calendarRows = calendar(companyId);
  return {
    range: r,
    mode: settings.tax_mode, mode_label: modeLabel,
    vat_enabled: !!settings.vat_enabled, vat_rate: settings.vat_rate,
    currency: 'UZS',
    vat_out: vatOut, vat_in: vatIn, net_vat: Math.max(0, vatOut - vatIn),
    turnover: pnl.revenue, profit_before_tax: pnl.profitBeforeTax,
    items,
    upcoming: calendarRows.filter(x => x.status === 'overdue' || x.status === 'due_soon' || x.status === 'pending').slice(0, 12),
    overdue_count: calendarRows.filter(x => x.status === 'overdue').length,
    unverified_deadlines: calendarRows.filter(x => !x.verified).length,
    requires_documents: buildRequiredDocuments(companyId, r, settings),
    disclaimer: DISCLAIMER,
    company: store.collection('companies').find(c => c.id === companyId) || null,
  };
}

function buildRequiredDocuments(companyId, range, settings) {
  const docs = [];
  if (settings.tax_mode === 'vat') docs.push({ title: 'QQS deklaratsiyasi uchun savdo va xarid registrlari', detail: 'Hisob-fakturalar (sotuv/xarid) va ularning ilovalari.', link: { page: 'invoices', params: {} } });
  docs.push({ title: 'Hisob-fakturalar va dalolatnomalar', detail: 'Har bir operatsiyaga asos hujjat biriktirilgan bo‘lishi kerak.', link: { page: 'documents', params: {} } });
  if (ledger.accountsOf(companyId).some(a => a.role === 'payroll')) docs.push({ title: 'Ish haqi vedomosti va xodimlar ro‘yxati', detail: 'Daromad solig‘i va ijtimoiy to‘lovlar hisobi uchun.', link: { page: 'parties', params: { kind: 'employee' } } });
  docs.push({ title: 'Bank ko‘chirmalari', detail: 'Kassa va bank harakatlarini tasdiqlash uchun.', link: { page: 'reconciliation', params: {} } });
  docs.push({ title: 'Shartnomalar', detail: 'Yirik xarid va sotuv operatsiyalari asosi.', link: { page: 'documents', params: { type: 'contract' } } });
  return docs;
}

function taxReport(companyId, range) {
  const s = summary(companyId, range);
  return {
    report: 'tax',
    title: 'Soliq hisoboti',
    range: s.range,
    mode_label: s.mode_label,
    rows: s.items.map(i => ({ label: i.title, value: U.fmtMoney(i.amount), note: i.note, drill: i.drill })),
    totals: { vat_out: s.vat_out, vat_in: s.vat_in, net_vat: s.net_vat, turnover: s.turnover, profit_before_tax: s.profit_before_tax },
    calendar: s.upcoming,
    required_documents: s.requires_documents,
    disclaimer: s.disclaimer,
    has_data: s.turnover !== 0 || s.vat_out !== 0 || s.vat_in !== 0,
  };
}

function markDone(companyId, { key, period, note = '' }, user) {
  if (!U.isValidPeriod(period)) throw new ApiError('Davr formati noto‘g‘ri (YYYY-MM).', 400, 'invalid_period');
  const item = TEMPLATE.find(t => t.key === key);
  if (!item) throw new ApiError('Soliq majburiyati topilmadi.', 404, 'not_found');
  const col = store.collection('taxMarks');
  let mark = col.find(m => m.company_id === companyId && m.key === key && m.period === period);
  if (mark) {
    mark.marked_at = store.nowISO();
    mark.note = U.str(note, { max: 500 });
  } else {
    mark = {
      id: store.uid('txm'), company_id: companyId, key, period,
      title: item.title, marked_at: store.nowISO(), marked_by: user ? user.id : null,
      marked_by_name: user ? user.name : null, note: U.str(note, { max: 500 }),
    };
    col.push(mark);
  }
  store.save();
  require('./audit').log({
    company_id: companyId, user, action: 'tax.mark_done', entity: 'tax', entity_id: `${key}:${period}`,
    summary: `Soliq majburiyati bajarildi deb belgilandi: ${item.title} (${U.periodLabel(period)})`, after: { key, period, note },
  });
  return mark;
}

function unmark(companyId, { key, period }, user) {
  const col = store.collection('taxMarks');
  const i = col.findIndex(m => m.company_id === companyId && m.key === key && m.period === period);
  if (i < 0) throw new ApiError('Belgi topilmadi.', 404, 'not_found');
  const [m] = col.splice(i, 1);
  store.save();
  require('./audit').log({ company_id: companyId, user, action: 'tax.unmark', entity: 'tax', entity_id: `${key}:${period}`, summary: `Soliq belgisi olib tashlandi: ${m.title} (${U.periodLabel(period)})`, before: m });
  return { removed: true };
}

/** Kalendar sanasini tasdiqlash (buxgalter tomonidan) */
function verifyDeadline(companyId, key, { verified = true, due_day, due_month } = {}, user) {
  const item = TEMPLATE.find(t => t.key === key);
  if (!item) throw new ApiError('Soliq majburiyati topilmadi.', 404, 'not_found');
  const settings = ledger.getSettings(companyId);
  const calendarCfg = { ...(settings.tax_calendar || {}) };
  calendarCfg[key] = {
    ...(calendarCfg[key] || {}), verified: !!verified,
    due_day: due_day != null ? U.clamp(Math.round(U.num(due_day)), 1, 28) : (calendarCfg[key] || {}).due_day || item.due_day,
    due_month: due_month != null ? U.clamp(Math.round(U.num(due_month)), 1, 12) : (calendarCfg[key] || {}).due_month || item.due_month,
    verified_at: store.nowISO(), verified_by: user ? user.id : null,
  };
  ledger.saveSettings(companyId, { tax_calendar: calendarCfg }, user);
  require('./audit').log({
    company_id: companyId, user, action: 'tax.verify_deadline', entity: 'tax', entity_id: key,
    summary: `Soliq muddati ${verified ? 'tasdiqlandi' : 'tasdiqdan chiqarildi'}: ${item.title} (${calendarCfg[key].due_day}-kun)`, after: calendarCfg[key],
  });
  return calendarCfg[key];
}

function vatDeadline(period) {
  const next = U.addMonths(period, 1);
  return `${next}-20`;
}

module.exports = { TEMPLATE, DISCLAIMER, calendar, summary, taxReport, markDone, unmark, verifyDeadline, vatDeadline, obligationAmount };
