'use strict';
/**
 * BUXAI — kompaniyalar, a'zolik, tariflar (subscription) va limitlar.
 * Limitlar SERVERDA tekshiriladi — frontendda ko'rsatilgan narsa ishlamasa, bu yolg'on bo'ladi.
 */
const store = require('./store');
const U = require('./util');
const COA = require('./coa');
const auth = require('./auth');
const ledger = require('./ledger');
const { ApiError } = U;

const LEGAL_FORMS = [
  { key: 'mchj', label: 'MChJ (Mas’uliyati cheklangan jamiyat)' },
  { key: 'aj', label: 'AJ (Aksiyadorlik jamiyati)' },
  { key: 'yatt', label: 'YaTT (Yakka tartibdagi tadbirkor)' },
  { key: 'qk', label: 'Qo‘shma korxona' },
  { key: 'nnt', label: 'Nodavlat notijorat tashkilot' },
  { key: 'boshqa', label: 'Boshqa' },
];

const PLANS = [
  {
    key: 'trial', name: 'Sinov (Trial)', price_monthly: 0, price_yearly: 0, currency: 'UZS', trial_days: 14,
    limits: { companies: 1, users: 2, transactions_month: 150, documents_mb: 200, ai_questions_month: 30, ocr_month: 10, bank_import: false, api: false, export: true, multi_currency: false },
    features: ['Asosiy dashboard', 'Tranzaksiyalar', 'Hisob-fakturalar', 'Xato Radar (asosiy)', 'AI 30 savol/oy'],
  },
  {
    key: 'starter', name: 'Starter', price_monthly: 299000, price_yearly: 2990000, currency: 'UZS',
    limits: { companies: 1, users: 3, transactions_month: 1500, documents_mb: 2048, ai_questions_month: 300, ocr_month: 100, bank_import: true, api: false, export: true, multi_currency: false },
    features: ['Barcha asosiy modullar', 'Bank importi (CSV/Excel)', 'Xato Radar to‘liq', 'Hisobotlar', 'AI 300 savol/oy'],
  },
  {
    key: 'business', name: 'Business', price_monthly: 799000, price_yearly: 7990000, currency: 'UZS',
    limits: { companies: 3, users: 10, transactions_month: 20000, documents_mb: 10240, ai_questions_month: 2000, ocr_month: 500, bank_import: true, api: true, export: true, multi_currency: true },
    features: ['3 kompaniya', 'OCR hujjat tahlili', 'Bank reconciliation', 'Oy yopish jarayoni', 'Approval Center', 'AI CFO 2000 savol/oy'],
  },
  {
    key: 'enterprise', name: 'Professional / Enterprise', price_monthly: null, price_yearly: null, currency: 'UZS', custom: true,
    limits: { companies: 100, users: 1000, transactions_month: 1000000, documents_mb: 102400, ai_questions_month: 100000, ocr_month: 50000, bank_import: true, api: true, export: true, multi_currency: true },
    features: ['Cheksiz kompaniya va foydalanuvchi', 'API integratsiya', 'Maxsus hisoblar rejasi', 'Prioritet qo‘llab-quvvatlash', 'Korporativ xavfsizlik sozlamalari'],
  },
];
const PLAN_MAP = new Map(PLANS.map(p => [p.key, p]));

function plan(key) { return PLAN_MAP.get(key) || PLAN_MAP.get('trial'); }

function subscriptionFor(companyId) {
  let sub = store.collection('subscriptions').find(s => s.company_id === companyId);
  if (!sub) {
    sub = {
      id: store.uid('sub'), company_id: companyId, plan: 'trial', status: 'trialing',
      started_at: store.nowISO(),
      trial_ends_at: new Date(Date.now() + (plan('trial').trial_days || 14) * 86400000).toISOString(),
      renews_at: null, cancelled_at: null, payments: [],
    };
    store.collection('subscriptions').push(sub);
    store.save();
  }
  const p = plan(sub.plan);
  const trialEnds = sub.trial_ends_at ? new Date(sub.trial_ends_at) : null;
  const expired = sub.status === 'trialing' && trialEnds && trialEnds.getTime() < Date.now();
  return { ...sub, plan_def: p, effective_status: expired ? 'expired' : sub.status, trial_days_left: trialEnds ? Math.max(0, Math.ceil((trialEnds.getTime() - Date.now()) / 86400000)) : null };
}

function usageFor(companyId, period = U.currentPeriod()) {
  const rows = store.collection('usage').filter(u => u.company_id === companyId && u.period === period);
  const get = (metric) => { const r = rows.find(x => x.metric === metric); return r ? r.count : 0; };
  const docBytes = store.collection('documents').filter(d => d.company_id === companyId && d.deleted_at == null).reduce((a, d) => a + (d.size || 0), 0);
  const company = store.collection('companies').find(c => c.id === companyId);
  const ownedCompanies = company && company.owner_id
    ? store.collection('companies').filter(c => c.owner_id === company.owner_id && c.status !== 'archived').length
    : 1;
  return {
    period,
    transactions_month: get('transaction') + get('invoice') + get('bill') + get('payment') + get('journal'),
    ai_questions_month: get('ai_question'),
    ocr_month: get('ocr'),
    documents_mb: Math.round((docBytes / 1048576) * 10) / 10,
    users: store.collection('memberships').filter(m => m.company_id === companyId && m.status !== 'removed').length,
    companies: Math.max(1, ownedCompanies),
  };
}

function bump(companyId, metric, by = 1) {
  const period = U.currentPeriod();
  const col = store.collection('usage');
  let row = col.find(u => u.company_id === companyId && u.period === period && u.metric === metric);
  if (!row) { row = { id: store.uid('usg'), company_id: companyId, period, metric, count: 0 }; col.push(row); }
  row.count += by;
  store.save();
  return row.count;
}

/**
 * Limitni tekshirish. Limit tugagan bo'lsa aniq xato beradi (foydalanuvchi nima qilishni biladi).
 */
function checkLimit(companyId, metric, increment = 1) {
  const sub = subscriptionFor(companyId);
  const limits = sub.plan_def.limits;
  if (sub.effective_status === 'expired' || sub.effective_status === 'cancelled') {
    throw new ApiError(`Obuna muddati tugagan (${sub.plan_def.name}). Davom ettirish uchun tarifni yangilang.`, 402, 'subscription_expired', { plan: sub.plan });
  }
  if (metric === 'bank_import' && !limits.bank_import) throw new ApiError('Bank importi joriy tarifda mavjud emas. Starter tarifiga o‘ting.', 402, 'plan_limit', { metric });
  if (metric === 'ocr_month' && !limits.ocr_month) throw new ApiError('OCR hujjat tahlili joriy tarifda mavjud emas.', 402, 'plan_limit', { metric });
  const usage = usageFor(companyId);
  if (metric === 'ai_question' && usage.ai_questions_month + increment > limits.ai_questions_month) {
    throw new ApiError(`AI savollar limiti tugadi (${limits.ai_questions_month}/oy). Tarifni yangilang.`, 402, 'plan_limit', { metric, limit: limits.ai_questions_month });
  }
  if (metric === 'ocr' && usage.ocr_month + increment > limits.ocr_month) {
    throw new ApiError(`OCR limiti tugadi (${limits.ocr_month}/oy). Tarifni yangilang.`, 402, 'plan_limit', { metric, limit: limits.ocr_month });
  }
  if ((metric === 'transaction' || metric === 'invoice' || metric === 'bill' || metric === 'payment' || metric === 'journal') &&
      usage.transactions_month + increment > limits.transactions_month) {
    throw new ApiError(`Oylik operatsiyalar limiti tugadi (${limits.transactions_month}/oy). Tarifni yangilang.`, 402, 'plan_limit', { metric, limit: limits.transactions_month });
  }
  return true;
}

function changePlan(companyId, newPlan, user, { period = 'monthly' } = {}) {
  const p = PLAN_MAP.get(newPlan);
  if (!p) throw new ApiError('Tarif topilmadi.', 404, 'plan_not_found');
  const col = store.collection('subscriptions');
  let sub = col.find(s => s.company_id === companyId);
  const before = sub ? { plan: sub.plan, status: sub.status } : null;
  if (!sub) { subscriptionFor(companyId); sub = col.find(s => s.company_id === companyId); }
  sub.plan = newPlan;
  sub.status = 'active';
  sub.started_at = store.nowISO();
  sub.renews_at = new Date(Date.now() + (period === 'yearly' ? 365 : 30) * 86400000).toISOString();
  sub.cancelled_at = null;
  sub.billing_period = period;
  store.save();
  require('./audit').log({
    company_id: companyId, user, action: 'subscription.change', entity: 'subscription', entity_id: sub.id,
    summary: `Tarif ${before ? plan(before.plan).name : '—'} → ${p.name}`,
    before, after: { plan: newPlan, status: 'active', period },
  });
  return sub;
}

// ─────────────────────────────── Kompaniyalar ───────────────────────────────

function createCompany(input, owner, { seed = false } = {}) {
  const name = U.str(input.name, { max: 160, required: true, field: 'Kompaniya nomi' });
  const company = {
    id: store.uid('cmp'),
    name,
    legal_form: LEGAL_FORMS.some(f => f.key === input.legal_form) ? input.legal_form : 'mchj',
    inn: U.str(input.inn || '', { max: 20 }),
    mfo: U.str(input.mfo || '', { max: 10 }),
    bank_account: U.str(input.bank_account || '', { max: 30 }),
    bank_name: U.str(input.bank_name || '', { max: 120 }),
    address: U.str(input.address || '', { max: 250 }),
    phone: U.str(input.phone || '', { max: 40 }),
    email: U.str(input.email || '', { max: 160 }),
    director_name: U.str(input.director_name || '', { max: 120 }),
    accountant_name: U.str(input.accountant_name || '', { max: 120 }),
    currency: 'UZS',
    tax_mode: ['simplified', 'vat', 'none'].includes(input.tax_mode) ? input.tax_mode : 'simplified',
    fiscal_year_start: '01',
    created_at: store.nowISO(),
    created_by: owner ? owner.id : null,
    owner_id: owner ? owner.id : null,
    status: 'active',
    industry: U.str(input.industry || '', { max: 80 }),
  };
  validateCompanyFields(company);
  store.collection('companies').push(company);
  if (owner) auth.addMembership(owner.id, company.id, 'director');
  initChartOfAccounts(company.id);
  ledger.saveSettings(company.id, {
    vat_enabled: company.tax_mode === 'vat',
    tax_mode: company.tax_mode,
    vat_rate: company.tax_mode === 'vat' ? 12 : 0,
  }, owner);
  subscriptionFor(company.id);
  store.save();
  if (seed) require('./seed').seedCompany(company.id, owner, input.seed_profile || 'demo');
  require('./audit').log({
    company_id: company.id, user: owner, action: 'company.create', entity: 'company', entity_id: company.id,
    summary: `Kompaniya yaratildi: ${company.name}`, after: { name: company.name, inn: company.inn },
  });
  return company;
}

function validateCompanyFields(c) {
  if (c.inn && !U.isINN(c.inn)) throw new ApiError('STIR/INN 9 yoki 14 raqamdan iborat bo‘lishi kerak.', 400, 'invalid_inn', { field: 'inn' });
  if (c.mfo && !U.isMFO(c.mfo)) throw new ApiError('MFO 5 raqamdan iborat bo‘lishi kerak.', 400, 'invalid_mfo', { field: 'mfo' });
  if (c.bank_account && !U.isBankAccount(c.bank_account)) throw new ApiError('Hisob raqami 20 raqamdan iborat bo‘lishi kerak.', 400, 'invalid_account', { field: 'bank_account' });
  if (c.email && !U.isEmail(c.email)) throw new ApiError('Email manzil noto‘g‘ri.', 400, 'invalid_email', { field: 'email' });
  return true;
}

function updateCompany(companyId, patch, user) {
  const company = store.collection('companies').find(c => c.id === companyId);
  if (!company) throw new ApiError('Kompaniya topilmadi.', 404, 'company_not_found');
  const before = { ...company };
  const allowed = ['name', 'legal_form', 'inn', 'mfo', 'bank_account', 'bank_name', 'address', 'phone', 'email',
    'director_name', 'accountant_name', 'tax_mode', 'industry', 'fiscal_year_start'];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    const max = k === 'address' ? 250 : k === 'name' ? 160 : 120;
    company[k] = U.str(patch[k], { max });
  }
  validateCompanyFields(company);
  company.updated_at = store.nowISO();
  store.save();
  if (patch.tax_mode) {
    ledger.saveSettings(companyId, { tax_mode: company.tax_mode, vat_enabled: company.tax_mode === 'vat' }, user);
  }
  require('./audit').log({
    company_id: companyId, user, action: 'company.update', entity: 'company', entity_id: companyId,
    summary: 'Kompaniya rekvizitlari yangilandi', before, after: { ...company },
  });
  return company;
}

/** Har bir yangi kompaniya uchun standart hisoblar rejasi yaratiladi */
function initChartOfAccounts(companyId) {
  const col = store.collection('accounts');
  if (col.some(a => a.company_id === companyId)) return col.filter(a => a.company_id === companyId);
  const created = [];
  for (const t of COA.TEMPLATE) {
    const acc = {
      id: store.uid('acc'), company_id: companyId,
      code: t.code, name: t.name,
      type: t.type, subtype: t.subtype, role: t.role || null,
      normal: t.normal || (t.type === 'asset' || t.type === 'expense' ? 'debit' : 'credit'),
      is_cash: !!t.is_cash, is_bank: !!t.is_bank,
      is_system: true, active: true, currency: 'UZS',
      created_at: store.nowISO(),
    };
    col.push(acc);
    created.push(acc);
  }
  store.save();
  return created;
}

function companyById(id) { return store.collection('companies').find(c => c.id === id) || null; }

function companySummary(companyId) {
  const c = companyById(companyId);
  if (!c) return null;
  const sub = subscriptionFor(companyId);
  const cash = ledger.cashPosition(companyId);
  const period = U.currentPeriod();
  const pnl = ledger.periodSummary(companyId, { from: U.periodStart(period), to: U.periodEnd(period) });
  return {
    ...c,
    subscription: { plan: sub.plan, plan_name: sub.plan_def.name, status: sub.effective_status, trial_days_left: sub.trial_days_left, renews_at: sub.renews_at },
    usage: usageFor(companyId),
    limits: sub.plan_def.limits,
    stats: { cash: cash.total, month_revenue: pnl.revenue, month_expense: pnl.totalExpense, month_profit: pnl.netProfit },
  };
}

function archiveCompany(companyId, user) {
  const c = companyById(companyId);
  if (!c) throw new ApiError('Kompaniya topilmadi.', 404, 'company_not_found');
  c.status = 'archived';
  c.archived_at = store.nowISO();
  store.save();
  require('./audit').log({ company_id: companyId, user, action: 'company.archive', entity: 'company', entity_id: companyId, summary: `Kompaniya arxivlandi: ${c.name}` });
  return c;
}

module.exports = {
  LEGAL_FORMS, PLANS, PLAN_MAP, plan, subscriptionFor, usageFor, bump, checkLimit, changePlan,
  createCompany, updateCompany, initChartOfAccounts, companyById, companySummary, archiveCompany, validateCompanyFields,
};
