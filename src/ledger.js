'use strict';
/**
 * BUXAI — Buxgalteriya dvigateli (double-entry ledger).
 *
 * Bu modul butun ilova uchun YAGONA haqiqat manbai:
 *  - har bir operatsiya jurnal yozuvi (entry) orqali o'tadi
 *  - debet = kredit qat'iy tekshiriladi
 *  - barcha moliyaviy ko'rsatkichlar shu jurnaldan hisoblanadi
 *
 * Hech bir modul (dashboard, hisobot, AI CFO, Xato Radar, salomatlik skori)
 * o'zicha raqam hisoblamaydi — hammasi shu fayl funksiyalaridan foydalanadi.
 */
const store = require('./store');
const U = require('./util');
const COA = require('./coa');
const { ApiError } = U;

// ─────────────────────────── Hisoblar rejasi ────────────────────────────────

function accountsOf(companyId, { includeInactive = true } = {}) {
  const list = store.collection('accounts').filter(a => a.company_id === companyId);
  return includeInactive ? list : list.filter(a => a.active !== false);
}
function accountMap(companyId) {
  const m = new Map();
  for (const a of accountsOf(companyId)) m.set(a.code, a);
  return m;
}
function getAccount(companyId, code) {
  const a = accountsOf(companyId).find(x => x.code === String(code));
  if (!a) throw new ApiError(`Hisob topilmadi: ${code}. Hisoblar rejasini tekshiring.`, 400, 'account_not_found', { code });
  return a;
}
function tryAccount(companyId, code) { return accountsOf(companyId).find(x => x.code === String(code)) || null; }

/** Rol bo'yicha hisob kodini aniqlash: settings.role_override → role → standart */
function roleCode(companyId, role, fallback = null) {
  const settings = getSettings(companyId);
  const override = (settings.role_accounts || {})[role];
  if (override && tryAccount(companyId, override)) return override;
  const fromRole = COA.roleAccount(role, accountsOf(companyId, { includeInactive: false }));
  if (fromRole) return fromRole;
  const def = COA.DEFAULT_ROLE_MAP[role];
  if (def && tryAccount(companyId, def)) return def;
  if (fallback) return fallback;
  throw new ApiError(`«${role}» roli uchun hisob sozlanmagan. Sozlamalar → Hisoblar bo‘limini tekshiring.`, 500, 'role_account_missing', { role });
}

// ─────────────────────────────── Sozlamalar ─────────────────────────────────

const DEFAULT_SETTINGS = {
  currency: 'UZS',
  vat_rate: 12,
  vat_enabled: false,
  tax_mode: 'simplified', // simplified (aylanma) | vat (qqs) | none
  fiscal_year_start: '01',
  approval_threshold: 50_000_000,
  document_required_above: 5_000_000,
  auto_approve_journal: true,
  cash_accounts: [],
  lock_after_close: true,
};

function getSettings(companyId) {
  const row = store.collection('settings').find(s => s.company_id === companyId);
  return { ...DEFAULT_SETTINGS, ...(row ? row.data : {}) };
}
function saveSettings(companyId, patch, user) {
  const col = store.collection('settings');
  let row = col.find(s => s.company_id === companyId);
  const before = row ? { ...row.data } : { ...DEFAULT_SETTINGS };
  if (!row) { row = { id: store.uid('set'), company_id: companyId, data: { ...DEFAULT_SETTINGS } }; col.push(row); }
  row.data = { ...row.data, ...patch };
  row.updated_at = store.nowISO();
  row.updated_by = user ? user.id : null;
  store.save();
  store.touch(companyId);
  return { before, after: { ...row.data } };
}

// ─────────────────────────── Jurnal yozuvlari ───────────────────────────────

const ENTRY_STATUS = { POSTED: 'posted', VOID: 'void', PENDING: 'pending_approval' };

/**
 * Jurnal yozuvlari (hisobotlar uchun yagona manba).
 *
 * MUHIM: teskari (reversal) yozuvlar hisobotlarda hisobga olinmaydi, chunki
 * bekor qilingan asl yozuv `void` statusida allaqachon chiqarib tashlangan.
 * Ikkalasini birga hisoblash foydani ikki marta tuzatardi.
 * Audit/tekshiruv uchun `includeReversals: true` (yoki `includeVoid: true`) bering —
 * u holda ikkala yozuv ham ko'rinadi va debet=kredit balansi saqlanadi.
 */
function entries(companyId, { from, to, includeVoid = false, includePending = false, includeReversals = false } = {}) {
  const withReversals = includeReversals || includeVoid;
  return store.collection('entries').filter(e => {
    if (e.company_id !== companyId) return false;
    const isReversal = !!(e.source && e.source.type === 'reversal') || !!e.reversal_of;
    if (isReversal && !withReversals) return false;
    if (!includeVoid && e.status !== ENTRY_STATUS.POSTED) return false;
    if (!includePending && e.status === ENTRY_STATUS.PENDING) return false;
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    return true;
  });
}

function isPeriodClosed(companyId, period) {
  return store.collection('closes').some(c => c.company_id === companyId && c.period === period && c.status === 'closed');
}
function periodClose(companyId, period) {
  return store.collection('closes').find(c => c.company_id === companyId && c.period === period) || null;
}

/**
 * Yozuvni validatsiya qiladi (saqlashdan oldin ham chaqiriladi).
 * Qaytaradi: { ok, errors:[], totals:{debit,credit} }
 */
function validateEntry(companyId, input) {
  const errors = [];
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (!U.isValidDate(input.date)) errors.push({ code: 'invalid_date', message: 'Sana YYYY-MM-DD ko‘rinishida bo‘lishi kerak.' });
  if (lines.length < 2) errors.push({ code: 'too_few_lines', message: 'Yozuvda kamida 2 qator (debet va kredit) bo‘lishi kerak.' });
  let debit = 0, credit = 0;
  lines.forEach((l, i) => {
    const acc = tryAccount(companyId, l.account);
    if (!acc) errors.push({ code: 'account_not_found', message: `${i + 1}-qator: «${l.account}» hisobi topilmadi.`, line: i + 1 });
    else if (acc.active === false) errors.push({ code: 'account_inactive', message: `${i + 1}-qator: «${acc.code} ${acc.name}» hisobi faol emas.`, line: i + 1 });
    const d = U.amount(l.debit || 0), c = U.amount(l.credit || 0);
    if (d < 0 || c < 0) errors.push({ code: 'negative_amount', message: `${i + 1}-qator: summa manfiy bo‘lishi mumkin emas.`, line: i + 1 });
    if (d > 0 && c > 0) errors.push({ code: 'both_sides', message: `${i + 1}-qator: bir qatorda ham debet, ham kredit bo‘lishi mumkin emas.`, line: i + 1 });
    if (d === 0 && c === 0) errors.push({ code: 'zero_line', message: `${i + 1}-qator: summa kiritilmagan.`, line: i + 1 });
    debit += d; credit += c;
  });
  if (lines.length >= 2 && debit !== credit) {
    const diff = debit - credit;
    errors.push({
      code: 'unbalanced',
      message: `Yozuv balanslanmagan: debet ${U.fmtMoney(debit)}, kredit ${U.fmtMoney(credit)}. Farq: ${U.fmtMoney(Math.abs(diff))} ${diff > 0 ? '(debet ko‘p)' : '(kredit ko‘p)'}.`,
      details: { debit, credit, diff },
    });
  }
  if (lines.length >= 2 && debit === 0) errors.push({ code: 'zero_entry', message: 'Yozuv summasi nolga teng.' });
  const period = U.periodOf(input.date);
  if (input.date && isPeriodClosed(companyId, period) && !input.allow_closed_period) {
    errors.push({ code: 'period_closed', message: `${U.periodLabel(period)} davri yopilgan. Yopilgan davrga yozuv kiritish uchun davrni qayta ochish kerak.` });
  }
  return { ok: errors.length === 0, errors, totals: { debit, credit } };
}

/**
 * Jurnal yozuvini yaratish. Faqat balanslangan yozuv yoziladi.
 */
function postEntry(companyId, input) {
  const user = input.user || null;
  const lines = (input.lines || []).map(l => ({
    account: String(l.account),
    debit: Math.round(U.num(l.debit)),
    credit: Math.round(U.num(l.credit)),
    party_id: l.party_id || null,
    description: U.str(l.description || '', { max: 300 }),
    tax_code: l.tax_code || null,
    tax_amount: Math.round(U.num(l.tax_amount || 0)),
    tax_rate: l.tax_rate != null ? U.num(l.tax_rate) : null,
    product_id: l.product_id || null,
    qty: l.qty != null ? U.num(l.qty) : null,
  }));
  const payload = {
    date: input.date,
    lines,
    allow_closed_period: !!input.allow_closed_period,
  };
  const check = validateEntry(companyId, payload);
  if (!check.ok) {
    const primary = check.errors.find(e => e.code === 'unbalanced') || check.errors[0];
    throw new ApiError(primary.message, 422, 'invalid_entry', check.errors);
  }
  const period = U.periodOf(input.date);
  const entry = {
    id: store.uid('je'),
    company_id: companyId,
    no: `JE-${store.nextNumber(`journal_${companyId}`, 5)}`,
    date: input.date,
    period,
    memo: U.str(input.memo || '', { max: 400, required: true, field: 'Izoh' }),
    ref: U.str(input.ref || '', { max: 100 }),
    lines,
    source: input.source || { type: 'manual', id: null },
    status: input.status || ENTRY_STATUS.POSTED,
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 10).map(t => U.str(t, { max: 40 })) : [],
    attachments: Array.isArray(input.attachments) ? input.attachments : [],
    created_by: user ? user.id : null,
    created_at: store.nowISO(),
    posted_at: (input.status || ENTRY_STATUS.POSTED) === ENTRY_STATUS.POSTED ? store.nowISO() : null,
    approved_by: input.approved_by || null,
    reversal_of: input.reversal_of || null,
    reversed_by: null,
  };
  store.collection('entries').push(entry);
  store.nextSeq(`journal_${companyId}`);
  store.save();
  store.touch(companyId);
  return entry;
}

/** Yozuvni bekor qilish — o'chirilmaydi, teskari (reversal) yozuv yaratiladi. */
function reverseEntry(companyId, entryId, { user, reason = '', date } = {}) {
  const all = store.collection('entries');
  const original = all.find(e => e.id === entryId && e.company_id === companyId);
  if (!original) throw new ApiError('Jurnal yozuvi topilmadi.', 404, 'not_found');
  if (original.status === ENTRY_STATUS.VOID) throw new ApiError('Bu yozuv allaqachon bekor qilingan.', 409, 'already_void');
  if (original.reversed_by) throw new ApiError('Bu yozuv uchun teskari yozuv allaqachon mavjud.', 409, 'already_reversed');

  const revLines = original.lines.map(l => ({
    account: l.account, debit: l.credit, credit: l.debit, party_id: l.party_id,
    description: `Bekor qilish: ${l.description || original.memo}`.slice(0, 300),
  }));
  const reversal = postEntry(companyId, {
    date: date || original.date,
    memo: `BEKOR QILISH — ${original.no}: ${original.memo}${reason ? ` (${reason})` : ''}`.slice(0, 400),
    ref: original.ref,
    lines: revLines,
    source: { type: 'reversal', id: original.id },
    user,
    reversal_of: original.id,
    allow_closed_period: true,
  });
  original.status = ENTRY_STATUS.VOID;
  original.reversed_by = reversal.id;
  original.void_reason = reason;
  original.void_by = user ? user.id : null;
  original.void_at = store.nowISO();
  store.save();
  store.touch(companyId);
  return { original, reversal };
}

function pendingEntries(companyId) {
  return store.collection('entries').filter(e => e.company_id === companyId && e.status === ENTRY_STATUS.PENDING);
}
function findEntry(companyId, id) {
  return store.collection('entries').find(e => e.id === id && e.company_id === companyId) || null;
}

// ────────────────────────── Qoldiqlar va harakatlar ─────────────────────────

/**
 * Hisoblar bo'yicha harakat. Opening = `from` dan oldingi barcha yozuvlar.
 * Qaytaradi: Map(code → {opening, debit, credit, closing, movement, normal})
 * closing — hisobning normal tomoniga mos ishorali qoldiq.
 */
function accountMovements(companyId, { from = '1900-01-01', to = '2999-12-31', codes = null, includePending = false } = {}) {
  const list = accountsOf(companyId);
  const res = new Map();
  for (const a of list) {
    if (codes && !codes.includes(a.code)) continue;
    res.set(a.code, { account: a, opening: 0, debit: 0, credit: 0, closing: 0, normal: a.normal || defaultNormal(a.type) });
  }
  const filterCodes = codes ? new Set(codes) : null;
  for (const e of entries(companyId, { includePending })) {
    for (const l of e.lines) {
      if (filterCodes && !filterCodes.has(l.account)) continue;
      let row = res.get(l.account);
      if (!row) {
        const acc = tryAccount(companyId, l.account);
        if (!acc) continue;
        row = { account: acc, opening: 0, debit: 0, credit: 0, closing: 0, normal: acc.normal || defaultNormal(acc.type) };
        res.set(l.account, row);
      }
      const signedBefore = row.normal === 'credit' ? (l.credit - l.debit) : (l.debit - l.credit);
      if (e.date < from) row.opening += signedBefore;
      else if (e.date <= to) { row.debit += l.debit; row.credit += l.credit; }
    }
  }
  for (const row of res.values()) {
    const movement = row.normal === 'credit' ? (row.credit - row.debit) : (row.debit - row.credit);
    row.movement = movement;
    row.closing = row.opening + movement;
  }
  return res;
}
function defaultNormal(type) { return type === 'asset' || type === 'expense' ? 'debit' : 'credit'; }

/** Bitta hisob qoldig'i (normal ishora bilan) */
function balanceOf(companyId, code, { asOf = null, includePending = false } = {}) {
  const m = accountMovements(companyId, { from: '1900-01-01', to: asOf || '2999-12-31', codes: [String(code)], includePending });
  const row = m.get(String(code));
  return row ? row.closing : 0;
}

/** Bir guruh (rol) bo'yicha qoldiqlar yig'indisi */
function roleBalance(companyId, role, { asOf = null } = {}) {
  const settings = getSettings(companyId);
  const override = (settings.role_accounts || {})[role];
  const list = accountsOf(companyId).filter(a => (override ? a.code === override : a.role === role));
  let total = 0;
  for (const a of list) total += balanceOf(companyId, a.code, { asOf });
  return total;
}

/** Davr bo'yicha P&L va balans ko'rsatkichlari (yagona manba) */
function periodSummary(companyId, range, { includePending = false } = {}) {
  const moves = accountMovements(companyId, { from: range.from, to: range.to, includePending });
  let revenue = 0, otherIncome = 0, cos = 0, opex = 0, otherExpense = 0, finExpense = 0, incomeTax = 0;
  const expenseByAccount = new Map();
  const revenueByAccount = new Map();
  for (const row of moves.values()) {
    const acc = row.account;
    const amt = row.normal === 'credit' ? (row.credit - row.debit) : (row.debit - row.credit);
    if (acc.type === 'income') {
      if (acc.role === 'returns') revenue -= amt;          // kontra-daromad: sotuvdan qaytarishlar
      else if (acc.subtype === 'revenue') revenue += amt;
      else otherIncome += amt;
      revenueByAccount.set(acc.code, { code: acc.code, name: acc.name, amount: amt });
    } else if (acc.type === 'expense') {
      if (acc.subtype === 'cos') cos += amt;
      else if (acc.subtype === 'financial_expense') finExpense += amt;
      else if (acc.subtype === 'income_tax') incomeTax += amt;
      else if (acc.subtype === 'other_expense') otherExpense += amt;
      else opex += amt;
      expenseByAccount.set(acc.code, { code: acc.code, name: acc.name, amount: amt });
    }
  }
  const totalIncome = revenue + otherIncome;
  const totalExpense = cos + opex + otherExpense;
  const operatingProfit = revenue - cos - opex;
  const ebit = operatingProfit + otherIncome - otherExpense;
  const profitBeforeTax = ebit - finExpense;
  const netProfit = profitBeforeTax - incomeTax;
  return {
    range,
    revenue, otherIncome, totalIncome, cos, grossProfit: revenue - cos, opex, otherExpense,
    operatingProfit, finExpense, ebit, profitBeforeTax, incomeTax, netProfit, totalExpense,
    grossMargin: U.pct(revenue - cos, revenue),
    netMargin: U.pct(netProfit, revenue),
    expenseByAccount: [...expenseByAccount.values()].filter(x => x.amount !== 0).sort((a, b) => b.amount - a.amount),
    revenueByAccount: [...revenueByAccount.values()].filter(x => x.amount !== 0).sort((a, b) => b.amount - a.amount),
    entryCount: entries(companyId, { from: range.from, to: range.to, includePending }).length,
  };
}

/** Umumiy balans holati (Balance Sheet uchun) */
function balanceSheet(companyId, asOf) {
  const moves = accountMovements(companyId, { from: '1900-01-01', to: asOf });
  const groups = {
    assets: [], liabilities: [], equity: [],
  };
  let totalAssets = 0, totalLiabilities = 0, totalEquity = 0;
  for (const row of moves.values()) {
    const a = row.account;
    const amount = row.closing;
    if (amount === 0 && !a.is_system) continue;
    const item = { code: a.code, name: a.name, amount, subtype: a.subtype, role: a.role };
    if (a.type === 'asset') { groups.assets.push(item); totalAssets += amount; }
    else if (a.type === 'liability') { groups.liabilities.push(item); totalLiabilities += amount; }
    else if (a.type === 'equity') { groups.equity.push(item); totalEquity += amount; }
  }
  // Davr foydasi kapitalga qo'shiladi (davr yopilmagan bo'lsa)
  const all = accountMovements(companyId, { from: '1900-01-01', to: asOf });
  let cumulativeProfit = 0;
  for (const row of all.values()) {
    const a = row.account;
    if (a.type === 'income') cumulativeProfit += (row.credit - row.debit);
    if (a.type === 'expense') cumulativeProfit -= (row.debit - row.credit);
  }
  const retainedRows = groups.equity.filter(e => e.role === 'retained' || e.subtype === 'retained');
  const retainedMovement = U.sumBy(retainedRows, r => r.amount);
  const periodProfit = cumulativeProfit - retainedMovement;
  groups.equity.push({ code: '—', name: 'Hisobot davri sof foydasi', amount: periodProfit, role: 'profit', derived: true });
  totalEquity += periodProfit;

  const diff = totalAssets - (totalLiabilities + totalEquity);
  return {
    asOf,
    assets: U.sortBy(groups.assets, x => x.code),
    liabilities: U.sortBy(groups.liabilities, x => x.code),
    equity: U.sortBy(groups.equity, x => x.code),
    totalAssets, totalLiabilities, totalEquity,
    difference: diff,
    balanced: Math.abs(diff) < 1,
  };
}

/** Umumiy jurnal — yozuvlar ro'yxati (filtrlar bilan) */
function journalQuery(companyId, { from, to, account, party_id, source_type, search, includeVoid = false, includePending = false, limit = 300 } = {}) {
  const list = entries(companyId, { from, to, includeVoid, includePending })
    .map(e => ({
      ...e,
      total: U.sumBy(e.lines, l => l.debit),
    }))
    .filter(e => {
      if (account && !e.lines.some(l => l.account === account)) return false;
      if (party_id && !e.lines.some(l => l.party_id === party_id)) return false;
      if (source_type && e.source.type !== source_type) return false;
      if (search) {
        const hay = U.norm(`${e.no} ${e.memo} ${e.ref} ${e.lines.map(l => l.description).join(' ')}`);
        if (!hay.includes(U.norm(search))) return false;
      }
      return true;
    });
  return U.sortBy(list, e => `${e.date} ${e.created_at}`, 'desc').slice(0, limit);
}

/** Pul oqimi (Cash Flow) — kassa/bank hisoblarining real harakatidan */
function cashFlowStatement(companyId, range) {
  const cashCodes = accountsOf(companyId).filter(a => a.is_cash || a.is_bank).map(a => a.code);
  const cashSet = new Set(cashCodes);
  const moves = [];
  for (const e of entries(companyId, { from: range.from, to: range.to })) {
    for (const l of e.lines) {
      if (!cashSet.has(l.account)) continue;
      // qarshi tomon(lar) hisob turi bo'yicha tasniflaymiz
      const opposites = e.lines.filter(x => x !== l);
      const oppType = opposites.length ? (tryAccount(companyId, opposites[0].account) || {}) : {};
      let category = 'operating';
      let label = 'Operatsion faoliyat';
      if (oppType.type === 'income' || oppType.type === 'expense') { category = 'operating'; label = 'Operatsion faoliyat'; }
      else if (oppType.subtype === 'loan' || oppType.subtype === 'equity' || oppType.role === 'equity') { category = 'financing'; label = 'Moliyaviy faoliyat'; }
      else if (oppType.subtype === 'fixed_asset' || oppType.subtype === 'accumulated_dep') { category = 'investing'; label = 'Investitsiya faoliyati'; }
      else category = 'operating';
      const amount = l.debit - l.credit; // kassaga kirim +, chiqim −
      moves.push({
        entry_id: e.id, no: e.no, date: e.date, memo: e.memo, ref: e.ref,
        account: l.account, account_name: (tryAccount(companyId, l.account) || {}).name,
        amount, category, category_label: label,
        counterparty_account: opposites[0] ? opposites[0].account : null,
        party_id: l.party_id || (opposites[0] ? opposites[0].party_id : null) || null,
        source: e.source,
      });
    }
  }
  const byCat = { operating: 0, investing: 0, financing: 0 };
  for (const m of moves) byCat[m.category] += m.amount;
  const opening = U.sumBy(accountsOf(companyId).filter(a => cashSet.has(a.code)), a => {
    const mv = accountMovements(companyId, { from: '1900-01-01', to: U.addDays(range.from, -1), codes: [a.code] });
    return mv.get(a.code) ? mv.get(a.code).closing : 0;
  });
  const net = byCat.operating + byCat.investing + byCat.financing;
  return {
    range,
    opening,
    operating: byCat.operating,
    investing: byCat.investing,
    financing: byCat.financing,
    net,
    closing: opening + net,
    moves: U.sortBy(moves, m => m.date, 'desc'),
  };
}

/** Naqd (kassa+bank) joriy qoldiq */
function cashPosition(companyId, asOf = null) {
  const list = accountsOf(companyId).filter(a => a.is_cash || a.is_bank);
  const rows = list.map(a => ({
    code: a.code, name: a.name, type: a.is_cash ? 'cash' : 'bank',
    balance: balanceOf(companyId, a.code, { asOf }),
  }));
  return { rows, total: U.sumBy(rows, r => r.balance) };
}

/** Hisob bo'yicha tafsilotli daftar (General Ledger / account ledger) */
function accountLedger(companyId, code, { from, to } = {}) {
  const acc = getAccount(companyId, code);
  const openingRow = accountMovements(companyId, { from: '1900-01-01', to: U.addDays(from || '1900-01-01', -1), codes: [code] });
  let running = openingRow.get(code) ? openingRow.get(code).closing : 0;
  const opening = running;
  const rows = [];
  for (const e of entries(companyId, { from, to })) {
    for (const l of e.lines) {
      if (l.account !== code) continue;
      const normal = acc.normal || defaultNormal(acc.type);
      const delta = normal === 'credit' ? (l.credit - l.debit) : (l.debit - l.credit);
      running += delta;
      const opposite = e.lines.filter(x => x !== l);
      rows.push({
        entry_id: e.id, no: e.no, date: e.date, memo: l.description || e.memo, ref: e.ref,
        debit: l.debit, credit: l.credit, delta, balance: running,
        contra: opposite.map(o => `${o.account} ${(tryAccount(companyId, o.account) || {}).name || ''}`.trim()).join(' • '),
        party_id: l.party_id || opposite[0]?.party_id || null,
        source: e.source, status: e.status,
      });
    }
  }
  const sorted = U.sortBy(rows, r => `${r.date} ${r.no}`);
  return {
    account: acc, opening, closing: running, rows: sorted,
    totals: { debit: U.sumBy(sorted, r => r.debit), credit: U.sumBy(sorted, r => r.credit) },
  };
}

/** Sinov balansi (Trial Balance) */
function trialBalance(companyId, { from, to }) {
  const moves = accountMovements(companyId, { from, to });
  const rows = [];
  for (const row of moves.values()) {
    const a = row.account;
    const openingSigned = row.normal === 'credit' ? -row.opening : row.opening;
    if (row.opening === 0 && row.debit === 0 && row.credit === 0) continue;
    rows.push({
      code: a.code, name: a.name, type: a.type, subtype: a.subtype,
      opening: row.opening,
      debit: row.debit, credit: row.credit, closing: row.closing,
      closing_dr: row.closing > 0 ? (row.normal === 'debit' ? row.closing : 0) : 0,
      closing_cr: row.closing > 0 ? (row.normal === 'credit' ? row.closing : 0) : 0,
      negative: row.closing < 0,
    });
  }
  // Manfiy qoldiqlarni ham to'g'ri tomonlarga taqsimlash
  let dr = 0, cr = 0;
  for (const r of rows) {
    if (r.closing >= 0) { if (r.type === 'asset' || r.type === 'expense') dr += r.closing; else cr += r.closing; }
    else { if (r.type === 'asset' || r.type === 'expense') cr += -r.closing; else dr += -r.closing; }
  }
  const sorted = U.sortBy(rows, r => r.code);
  return {
    range: { from, to }, rows: sorted,
    totals: {
      opening_debit: U.sumBy(sorted, r => r.opening > 0 ? r.opening : 0),
      opening_credit: U.sumBy(sorted, r => r.opening < 0 ? -r.opening : 0),
      debit: U.sumBy(sorted, r => r.debit),
      credit: U.sumBy(sorted, r => r.credit),
      closing_debit: dr, closing_credit: cr,
    },
    balanced: Math.abs(U.sumBy(sorted, r => r.debit) - U.sumBy(sorted, r => r.credit)) < 1,
  };
}

/** Kunlik pul oqimi seriyasi (grafik uchun, real ma'lumot) */
function dailyCashFlow(companyId, range) {
  const cashCodes = new Set(accountsOf(companyId).filter(a => a.is_cash || a.is_bank).map(a => a.code));
  const days = Math.max(1, Math.min(400, U.daysBetween(range.from, range.to) + 1));
  const map = new Map();
  for (let i = 0; i < days; i++) {
    const d = U.addDays(range.from, i);
    map.set(d, { date: d, in: 0, out: 0, net: 0 });
  }
  for (const e of entries(companyId, { from: range.from, to: range.to })) {
    for (const l of e.lines) {
      if (!cashCodes.has(l.account)) continue;
      const row = map.get(e.date);
      if (!row) continue;
      row.in += l.debit; row.out += l.credit; row.net += l.debit - l.credit;
    }
  }
  return [...map.values()];
}

/** Oylik tendensiya (oxirgi N oy) — grafik/health uchun */
function monthlyTrend(companyId, nMonths = 6, endPeriod = U.currentPeriod()) {
  const out = [];
  for (const p of U.lastNPeriods(nMonths, endPeriod)) {
    const s = periodSummary(companyId, { from: U.periodStart(p), to: U.periodEnd(p) });
    out.push({
      period: p, label: `${U.MONTHS_SHORT_UZ[Number(p.slice(5, 7)) - 1]}`, full_label: U.periodLabel(p),
      revenue: s.revenue, expense: s.cos + s.opex + s.otherExpense, netProfit: s.netProfit, grossProfit: s.grossProfit,
      entryCount: s.entryCount,
    });
  }
  return out;
}

module.exports = {
  ENTRY_STATUS, DEFAULT_SETTINGS,
  accountsOf, accountMap, getAccount, tryAccount, roleCode, getSettings, saveSettings,
  entries, findEntry, postEntry, reverseEntry, validateEntry, pendingEntries,
  isPeriodClosed, periodClose, accountMovements, balanceOf, roleBalance,
  periodSummary, balanceSheet, journalQuery, cashFlowStatement, cashPosition,
  accountLedger, trialBalance, dailyCashFlow, monthlyTrend, defaultNormal,
};
