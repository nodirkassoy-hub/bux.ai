'use strict';
/**
 * BUXAI — REST API.
 * Har bir endpoint: autentifikatsiya → kompaniya izolyatsiyasi → ruxsat tekshiruvi → handler.
 * Ruxsatlar SERVERDA tekshiriladi (frontendga ishonilmaydi).
 */
const U = require('./util');
const store = require('./store');
const auth = require('./auth');
const ledger = require('./ledger');
const COA = require('./coa');
const audit = require('./audit');
const companiesMod = require('./companies');
const { ApiError } = U;

const R = (method, path, handler, opts = {}) => ({ method, path, handler, ...opts });

function reportKey(key) {
  return String(key || '').trim().toLowerCase().replace(/-/g, '_').replace(/\s+/g, '_');
}

function toCsv(rows, columns) {
  const cols = columns || Object.keys(rows[0] || {});
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(';')];
  for (const r of rows) lines.push(cols.map(c => esc(typeof c === 'function' ? c(r) : r[c])).join(';'));
  return '\uFEFF' + lines.join('\r\n');
}

const API = [
  // ═══════════════════════════ Autentifikatsiya ═══════════════════════════
  R('POST', '/api/auth/login', async (ctx) => {
    const { email, password } = ctx.body;
    if (!email || !password) throw new ApiError('Email va parolni kiriting.', 400, 'missing_credentials');
    const { token, user } = auth.login(email, password, { ip: ctx.ip, agent: ctx.ua });
    const companies = auth.companiesFor(user);
    const activeId = (user.last_company_id && companies.some(c => c.id === user.last_company_id)) ? user.last_company_id : (companies[0] ? companies[0].id : null);
    user.last_company_id = activeId;
    store.save();
    audit.log({ company_id: activeId, user, action: 'auth.login', entity: 'user', entity_id: user.id, summary: `${user.name} tizimga kirdi`, meta: { ip: ctx.ip, ua: ctx.ua } });
    ctx.setCookie(token);
    return { user: auth.publicUser(user), companies: companies.map(c => ({ id: c.id, name: c.name, role: auth.roleInCompany(user, c.id) })), active_company_id: activeId };
  }, { public: true, rateLimit: { max: 20 } }),

  R('POST', '/api/auth/logout', async (ctx) => {
    if (ctx.sessionToken) auth.logout(ctx.sessionToken);
    ctx.clearCookie();
    return { ok: true };
  }, { public: true }),

  R('POST', '/api/auth/register', async (ctx) => {
    const { name, email, password, company_name, seed, phone, legal_form, inn, tax_mode } = ctx.body;
    if (!company_name) throw new ApiError('Kompaniya nomini kiriting.', 400, 'company_required');
    const user = auth.createUser({ name, email, password, role: 'director', phone });
    const company = companiesMod.createCompany({ name: company_name, legal_form, inn, tax_mode, phone }, user, { seed: seed !== false });
    user.last_company_id = company.id;
    store.save();
    const { token } = auth.login(email, password, { ip: ctx.ip, agent: ctx.ua });
    ctx.setCookie(token);
    audit.log({ company_id: company.id, user, action: 'auth.register', entity: 'user', entity_id: user.id, summary: `Yangi kompaniya ro‘yxatdan o‘tdi: ${company.name}`, meta: { ip: ctx.ip } });
    return { user: auth.publicUser(user), company: companiesMod.companySummary(company.id) };
  }, { public: true, rateLimit: { max: 10 } }),

  R('GET', '/api/auth/me', async (ctx) => {
    const companies = auth.companiesFor(ctx.user);
    const active = ctx.companyId || (companies[0] ? companies[0].id : null);
    const company = active ? store.collection('companies').find(c => c.id === active) : null;
    const sub = active ? companiesMod.subscriptionFor(active) : null;
    return {
      user: auth.publicUser(ctx.user),
      companies: companies.map(c => ({ id: c.id, name: c.name, role: auth.roleInCompany(ctx.user, c.id) })),
      active_company_id: active,
      company: company ? companiesMod.companySummary(company.id) : null,
      permissions: auth.permissionsFor(auth.roleInCompany(ctx.user, active) || ctx.user.role),
      role: auth.roleInCompany(ctx.user, active) || ctx.user.role,
      subscription: sub ? { plan: sub.plan, plan_name: sub.plan_def.name, status: sub.effective_status, trial_days_left: sub.trial_days_left, limits: sub.plan_def.limits, renews_at: sub.renews_at } : null,
      settings: active ? ledger.getSettings(active) : null,
      notifications: active ? require('./notifications').counts(active) : { unread: 0, critical: 0 },
      radar: active ? require('./radar').counts(active) : { total: 0, high: 0, impact: 0 },
    };
  }),

  R('POST', '/api/auth/password', async (ctx) => {
    const { current_password, new_password } = ctx.body;
    if (!auth.verifyPassword(current_password, ctx.user.password_hash)) throw new ApiError('Joriy parol xato.', 400, 'invalid_password');
    auth.validatePasswordStrength(new_password);
    ctx.user.password_hash = auth.hashPassword(new_password);
    store.save();
    audit.log({ company_id: ctx.companyId, user: ctx.user, action: 'auth.password_change', entity: 'user', entity_id: ctx.user.id, summary: 'Parol o‘zgartirildi' });
    return { ok: true };
  }),

  R('POST', '/api/companies/:id/switch', async (ctx) => {
    const { company, role } = auth.requireCompanyAccess(ctx.user, ctx.params.id);
    ctx.user.last_company_id = company.id;
    if (ctx.session) ctx.session.active_company_id = company.id;
    store.save();
    return { active_company_id: company.id, role, company: companiesMod.companySummary(company.id) };
  }),

  // ═══════════════════════════ Meta / konfiguratsiya ══════════════════════
  R('GET', '/api/meta', async () => ({
    categories: { expense: COA.EXPENSE_CATEGORIES, income: COA.INCOME_CATEGORIES },
    methods: require('./transactions').METHODS,
    payment_methods: require('./payments').METHODS,
    transaction_types: require('./transactions').TYPES,
    units: require('./inventory').UNITS,
    stock_move_types: require('./inventory').MOVE_TYPES,
    document_types: require('./documents').DOC_TYPES,
    legal_forms: companiesMod.LEGAL_FORMS,
    plans: companiesMod.PLANS,
    roles: auth.ROLE_LIST,
    goal_metrics: require('./dashboard').GOAL_METRICS,
    close_items: require('./close').ITEMS,
    invoice_statuses: require('./invoices').STATUS_LABELS,
    bill_statuses: require('./bills').STATUS_LABELS,
    radar_categories: require('./radar').CATEGORY_LABELS,
    nav: require('./search').PAGES,
  })),

  // ═════════════════════════════ Dashboard ════════════════════════════════
  R('GET', '/api/dashboard', async (ctx) => require('./dashboard').overview(ctx.companyId, { range: U.resolveRange(ctx.query) }), { permission: 'dashboard.view' }),

  R('GET', '/api/dashboard/goals', async (ctx) => ({ goals: require('./dashboard').listGoals(ctx.companyId), metrics: require('./dashboard').GOAL_METRICS }), { permission: 'dashboard.view' }),
  R('POST', '/api/dashboard/goals', async (ctx) => require('./dashboard').createGoal(ctx.companyId, ctx.body, ctx.user), { permission: 'goals.manage' }),
  R('DELETE', '/api/dashboard/goals/:id', async (ctx) => require('./dashboard').archiveGoal(ctx.companyId, ctx.params.id, ctx.user), { permission: 'goals.manage' }),

  // ═════════════════════════════ Operatsiyalar ════════════════════════════
  R('GET', '/api/transactions', async (ctx) => {
    const q = ctx.query;
    return require('./transactions').list(ctx.companyId, {
      from: q.from, to: q.to, type: q.type, category: q.category, party_id: q.party_id, account: q.account,
      search: q.search, status: q.status, method: q.method, tag: q.tag,
      min_amount: q.min_amount ? U.num(q.min_amount) : null, max_amount: q.max_amount ? U.num(q.max_amount) : null,
      sort: q.sort, page: Number(q.page || 1), pageSize: Number(q.page_size || 25), include_void: q.include_void === '1',
    });
  }, { permission: 'transactions.view' }),

  R('POST', '/api/transactions', async (ctx) => require('./transactions').create(ctx.companyId, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'transactions.create' }),
  R('POST', '/api/transactions/validate', async (ctx) => require('./transactions').validate(ctx.companyId, ctx.body), { permission: 'transactions.view' }),
  R('GET', '/api/transactions/export', async (ctx) => {
    const data = require('./transactions').list(ctx.companyId, { from: ctx.query.from, to: ctx.query.to, search: ctx.query.search, pageSize: 5000 });
    const csv = toCsv(data.items.map(t => ({
      Sana: t.date, Hujjat: t.no, Turi: t.type_label, Izoh: t.memo, Kontragent: t.counterparty_name,
      Kategoriya: t.category_label, Hisob: t.account_name || '', Summa: t.total, QQS: t.vat_amount,
      Holat: t.status, Manba: t.source_type,
    })));
    return { _file: { buffer: Buffer.from(csv, 'utf8'), filename: `operatsiyalar-${ctx.companyId.slice(0, 6)}-${U.today()}.csv`, contentType: 'text/csv; charset=utf-8', download: true } };
  }, { permission: 'reports.export' }),
  R('GET', '/api/transactions/series', async (ctx) => ({ series: require('./transactions').series(ctx.companyId, U.resolveRange(ctx.query), ctx.query.group || 'day') }), { permission: 'transactions.view' }),
  R('GET', '/api/transactions/:id', async (ctx) => require('./transactions').get(ctx.companyId, ctx.params.id), { permission: 'transactions.view' }),
  R('PATCH', '/api/transactions/:id', async (ctx) => require('./transactions').update(ctx.companyId, ctx.params.id, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'transactions.edit' }),
  R('POST', '/api/transactions/:id/duplicate', async (ctx) => require('./transactions').duplicate(ctx.companyId, ctx.params.id, ctx.user), { permission: 'transactions.create' }),
  R('POST', '/api/transactions/:id/reverse', async (ctx) => require('./transactions').reverse(ctx.companyId, ctx.params.id, ctx.user, ctx.body.reason, ctx.meta), { permission: 'transactions.reverse' }),

  // ═══════════════════════════ Hisob-fakturalar ══════════════════════════
  R('GET', '/api/invoices', async (ctx) => require('./invoices').list(ctx.companyId, {
    status: ctx.query.status, customer_id: ctx.query.customer_id, from: ctx.query.from, to: ctx.query.to,
    search: ctx.query.search, aging_bucket: ctx.query.aging_bucket, sort: ctx.query.sort,
    page: Number(ctx.query.page || 1), pageSize: Number(ctx.query.page_size || 25), include_cancelled: ctx.query.include_cancelled === '1',
  }), { permission: 'invoices.view' }),
  R('POST', '/api/invoices', async (ctx) => require('./invoices').create(ctx.companyId, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'invoices.manage' }),
  R('GET', '/api/invoices/:id', async (ctx) => require('./invoices').get(ctx.companyId, ctx.params.id), { permission: 'invoices.view' }),
  R('PATCH', '/api/invoices/:id', async (ctx) => require('./invoices').update(ctx.companyId, ctx.params.id, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'invoices.manage' }),
  R('POST', '/api/invoices/:id/issue', async (ctx) => require('./invoices').issue(ctx.companyId, ctx.params.id, ctx.user, { meta: ctx.meta }), { permission: 'invoices.manage' }),
  R('POST', '/api/invoices/:id/mark-sent', async (ctx) => {
    const inv = require('./invoices').find(ctx.companyId, ctx.params.id);
    inv.sent_at = inv.sent_at || store.nowISO();
    inv.status = 'sent';
    store.save();
    audit.log({ company_id: ctx.companyId, user: ctx.user, action: 'invoice.mark_sent', entity: 'invoice', entity_id: inv.id, summary: `${inv.no} «yuborilgan» deb belgilandi (email integratsiyasi sozlanmagan)` });
    return { invoice: require('./invoices').decorate(ctx.companyId, inv), integration_note: 'Email yuborish integratsiyasi sozlanmagan (SMTP/provider kaliti yo‘q). Holat qo‘lda belgilandi.' };
  }, { permission: 'invoices.manage' }),
  R('POST', '/api/invoices/:id/cancel', async (ctx) => require('./invoices').cancel(ctx.companyId, ctx.params.id, ctx.body.reason, ctx.user, { meta: ctx.meta }), { permission: 'invoices.manage' }),
  R('POST', '/api/invoices/:id/refund', async (ctx) => require('./invoices').refund(ctx.companyId, ctx.params.id, { ...ctx.body, user: ctx.user }, ctx.meta), { permission: 'invoices.manage' }),

  R('GET', '/api/receivables', async (ctx) => {
    const summary = require('./invoices').receivablesSummary(ctx.companyId, { asOf: ctx.query.asOf || U.today() });
    return {
      ...summary,
      late_payers: require('./invoices').latePayers(ctx.companyId, 8),
      report: require('./reports').receivablesReport(ctx.companyId, { asOf: ctx.query.asOf || U.today() }),
    };
  }, { permission: 'invoices.view' }),

  // ══════════════════════════════ To'lovlar ══════════════════════════════
  R('GET', '/api/payments', async (ctx) => require('./payments').list(ctx.companyId, {
    type: ctx.query.type, party_id: ctx.query.party_id, from: ctx.query.from, to: ctx.query.to, method: ctx.query.method,
    search: ctx.query.search, page: Number(ctx.query.page || 1), pageSize: Number(ctx.query.page_size || 25),
  }), { permission: 'payments.manage' }),
  R('POST', '/api/payments', async (ctx) => require('./payments').create(ctx.companyId, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'payments.manage' }),
  R('GET', '/api/payments/open-documents', async (ctx) => ({
    documents: require('./payments').openDocuments(ctx.companyId, ctx.query.party_id, ctx.query.type || 'incoming'),
    advances: require('./payments').unallocatedAdvances(ctx.companyId),
  }), { permission: 'payments.manage' }),
  R('POST', '/api/payments/:id/cancel', async (ctx) => require('./payments').cancel(ctx.companyId, ctx.params.id, ctx.body.reason, ctx.user, { meta: ctx.meta }), { permission: 'payments.manage' }),

  // ════════════════════════════ Xarid hisoblari ══════════════════════════
  R('GET', '/api/bills', async (ctx) => require('./bills').list(ctx.companyId, {
    status: ctx.query.status, supplier_id: ctx.query.supplier_id, from: ctx.query.from, to: ctx.query.to,
    search: ctx.query.search, page: Number(ctx.query.page || 1), pageSize: Number(ctx.query.page_size || 25),
  }), { permission: 'bills.view' }),
  R('POST', '/api/bills', async (ctx) => require('./bills').create(ctx.companyId, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'bills.manage' }),
  R('GET', '/api/bills/:id', async (ctx) => require('./bills').get(ctx.companyId, ctx.params.id), { permission: 'bills.view' }),
  R('PATCH', '/api/bills/:id', async (ctx) => require('./bills').update(ctx.companyId, ctx.params.id, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'bills.manage' }),
  R('POST', '/api/bills/:id/receive', async (ctx) => require('./bills').receiveBill(ctx.companyId, ctx.params.id, ctx.user, { meta: ctx.meta }), { permission: 'bills.manage' }),
  R('POST', '/api/bills/:id/cancel', async (ctx) => require('./bills').cancel(ctx.companyId, ctx.params.id, ctx.body.reason, ctx.user, { meta: ctx.meta }), { permission: 'bills.manage' }),
  R('GET', '/api/payables', async (ctx) => ({
    ...require('./bills').payablesSummary(ctx.companyId, { asOf: ctx.query.asOf || U.today() }),
    upcoming: require('./bills').upcoming(ctx.companyId, Number(ctx.query.days || 30)),
    report: require('./reports').payablesReport(ctx.companyId, { asOf: ctx.query.asOf || U.today() }),
  }), { permission: 'bills.view' }),

  // ══════════════════════ Kontragentlar (CRM) ═════════════════════════════
  R('GET', '/api/parties', async (ctx) => ({
    items: require('./parties').list(ctx.companyId, { kind: ctx.query.kind, search: ctx.query.search, status: ctx.query.status, sort: ctx.query.sort }),
    kinds: require('./parties').KINDS,
  }), { permission: 'parties.view' }),
  R('POST', '/api/parties', async (ctx) => require('./parties').create(ctx.companyId, ctx.body, ctx.user), { permission: 'parties.manage' }),
  R('GET', '/api/parties/:id', async (ctx) => require('./parties').profile(ctx.companyId, ctx.params.id, { limit: Number(ctx.query.limit || 100) }), { permission: 'parties.view' }),
  R('PATCH', '/api/parties/:id', async (ctx) => require('./parties').update(ctx.companyId, ctx.params.id, ctx.body, ctx.user), { permission: 'parties.manage' }),
  R('DELETE', '/api/parties/:id', async (ctx) => require('./parties').archive(ctx.companyId, ctx.params.id, ctx.user), { permission: 'parties.manage' }),
  R('GET', '/api/parties-aging', async (ctx) => ({
    receivables: require('./parties').aging(ctx.companyId, 'ar'),
    payables: require('./parties').aging(ctx.companyId, 'ap'),
  }), { permission: 'parties.view' }),

  // ════════════════════ Mahsulotlar va ombor ═════════════════════════════
  R('GET', '/api/products', async (ctx) => ({
    items: require('./inventory').list(ctx.companyId, { search: ctx.query.search, category: ctx.query.category, warehouse: ctx.query.warehouse, low_stock: ctx.query.low_stock === '1', sort: ctx.query.sort }),
    categories: require('./inventory').categoriesOf(ctx.companyId),
    valuation: require('./inventory').valuation(ctx.companyId),
  }), { permission: 'products.view' }),
  R('POST', '/api/products', async (ctx) => require('./inventory').create(ctx.companyId, ctx.body, ctx.user), { permission: 'products.manage' }),
  R('PATCH', '/api/products/:id', async (ctx) => require('./inventory').update(ctx.companyId, ctx.params.id, ctx.body, ctx.user), { permission: 'products.manage' }),
  R('GET', '/api/products/:id/moves', async (ctx) => ({
    moves: require('./inventory').stockMoves(ctx.companyId, { product_id: ctx.params.id, from: ctx.query.from, to: ctx.query.to }),
    evaluation: require('./inventory').evaluate(ctx.companyId, ctx.params.id),
    product: require('./inventory').decorate(ctx.companyId, require('./inventory').findProduct(ctx.companyId, ctx.params.id)),
  }), { permission: 'inventory.view' }),
  R('POST', '/api/inventory/receive', async (ctx) => require('./inventory').receive(ctx.companyId, ctx.body, ctx.user), { permission: 'inventory.manage' }),
  R('POST', '/api/inventory/issue', async (ctx) => require('./inventory').issue(ctx.companyId, ctx.body, ctx.user), { permission: 'inventory.manage' }),
  R('POST', '/api/inventory/adjust', async (ctx) => require('./inventory').stockAdjust(ctx.companyId, ctx.body, ctx.user), { permission: 'inventory.manage' }),
  R('GET', '/api/inventory/valuation', async (ctx) => require('./inventory').reconciliation(ctx.companyId), { permission: 'inventory.view' }),
  R('GET', '/api/inventory/moves', async (ctx) => ({
    items: require('./inventory').stockMoves(ctx.companyId, { from: ctx.query.from, to: ctx.query.to, type: ctx.query.type, product_id: ctx.query.product_id, limit: Number(ctx.query.limit || 200) }),
  }), { permission: 'inventory.view' }),

  // ═════════════════════════ Bank va kassa ═══════════════════════════════
  R('GET', '/api/bank/accounts', async (ctx) => ({
    accounts: require('./banking').accountsOf(ctx.companyId),
    cash_position: ledger.cashPosition(ctx.companyId),
    imports: require('./banking').importsList(ctx.companyId, {}),
  }), { permission: 'banking.view' }),
  R('POST', '/api/bank/accounts', async (ctx) => require('./banking').createAccount(ctx.companyId, ctx.body, ctx.user), { permission: 'banking.manage' }),
  R('PATCH', '/api/bank/accounts/:id', async (ctx) => require('./banking').updateAccount(ctx.companyId, ctx.params.id, ctx.body, ctx.user), { permission: 'banking.manage' }),
  R('GET', '/api/bank/accounts/:code', async (ctx) => require('./banking').accountDetail(ctx.companyId, ctx.params.code, { from: ctx.query.from, to: ctx.query.to }), { permission: 'banking.view' }),
  R('POST', '/api/bank/cash-count', async (ctx) => require('./banking').cashCount(ctx.companyId, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'banking.manage' }),

  R('POST', '/api/bank/import', async (ctx) => {
    const file = ctx.files && (ctx.files.file || Object.values(ctx.files)[0]);
    const account = ctx.body.account || (ctx.fields && ctx.fields.account);
    if (!account) throw new ApiError('Hisobni tanlang.', 400, 'account_required');
    if (!file) throw new ApiError('Ko‘chirma faylini yuklang.', 400, 'file_required');
    const name = file.filename || 'kochirma.csv';
    const lower = name.toLowerCase();
    const format = lower.endsWith('.xlsx') || lower.endsWith('.xls') ? 'excel' : lower.endsWith('.pdf') ? 'pdf' : 'csv';
    return require('./banking').importStatement(ctx.companyId, {
      account, filename: name, format,
      content: format === 'csv' ? file.data.toString('utf8') : null,
      buffer: format === 'csv' ? null : file.data,
      period_start: ctx.body.period_start, period_end: ctx.body.period_end,
    }, ctx.user, { meta: ctx.meta });
  }, { permission: 'banking.manage' }),

  R('GET', '/api/bank/imports', async (ctx) => ({ items: require('./banking').importsList(ctx.companyId, { account: ctx.query.account }) }), { permission: 'banking.view' }),
  R('DELETE', '/api/bank/imports/:id', async (ctx) => require('./banking').deleteImport(ctx.companyId, ctx.params.id, ctx.user), { permission: 'banking.manage' }),

  // ═════════════════════ Bank solishtirish (reconciliation) ══════════════
  R('GET', '/api/reconciliation', async (ctx) => require('./banking').reconcile(ctx.companyId, {
    account: ctx.query.account, import_id: ctx.query.import_id, from: ctx.query.from, to: ctx.query.to,
  }), { permission: 'reconciliation.view' }),
  R('GET', '/api/reconciliation/rows/:id', async (ctx) => require('./banking').rowCandidates(ctx.companyId, ctx.params.id), { permission: 'reconciliation.view' }),
  R('POST', '/api/reconciliation/rows/:id/accept', async (ctx) => require('./banking').acceptMatch(ctx.companyId, ctx.params.id, ctx.body.entry_id, ctx.user, { meta: ctx.meta }), { permission: 'reconciliation.manage' }),
  R('POST', '/api/reconciliation/rows/:id/reject', async (ctx) => require('./banking').rejectMatch(ctx.companyId, ctx.params.id, ctx.user, ctx.body.reason), { permission: 'reconciliation.manage' }),
  R('POST', '/api/reconciliation/rows/:id/ignore', async (ctx) => require('./banking').ignoreRow(ctx.companyId, ctx.params.id, ctx.user, ctx.body.reason), { permission: 'reconciliation.manage' }),
  R('POST', '/api/reconciliation/rows/:id/create', async (ctx) => require('./banking').createFromRow(ctx.companyId, ctx.params.id, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'reconciliation.manage' }),

  // ════════════════════════════ Hujjatlar ════════════════════════════════
  R('GET', '/api/documents', async (ctx) => require('./documents').list(ctx.companyId, {
    type: ctx.query.type, party_id: ctx.query.party_id, search: ctx.query.search, status: ctx.query.status,
    from: ctx.query.from, to: ctx.query.to, page: Number(ctx.query.page || 1), pageSize: Number(ctx.query.page_size || 25),
  }), { permission: 'documents.view' }),
  R('POST', '/api/documents', async (ctx) => {
    const file = ctx.files && (ctx.files.file || Object.values(ctx.files)[0]);
    if (!file) throw new ApiError('Fayl yuklanmadi.', 400, 'file_required');
    const links = {
      party_id: ctx.body.party_id || null, invoice_id: ctx.body.invoice_id || null,
      bill_id: ctx.body.bill_id || null, entry_id: ctx.body.entry_id || null, product_id: ctx.body.product_id || null,
    };
    return require('./documents').upload(ctx.companyId, {
      name: file.filename, mime: file.contentType, buffer: file.data, size: file.data.length,
      type: ctx.body.type, tags: ctx.body.tags ? String(ctx.body.tags).split(',').map(s => s.trim()) : [],
      note: ctx.body.note, links,
    }, ctx.user, { meta: ctx.meta });
  }, { permission: 'documents.manage' }),
  R('GET', '/api/documents/:id', async (ctx) => {
    const doc = require('./documents').decorate(ctx.companyId, require('./documents').find(ctx.companyId, ctx.params.id));
    return { ...doc, linked: {
      party: doc.party_id ? require('./parties').tryFind(ctx.companyId, doc.party_id) : null,
      invoice: doc.invoice_id ? (require('./invoices').all(ctx.companyId).find(i => i.id === doc.invoice_id) || null) : null,
      bill: doc.bill_id ? (require('./bills').all(ctx.companyId).find(b => b.id === doc.bill_id) || null) : null,
      entry: doc.entry_id ? ledger.findEntry(ctx.companyId, doc.entry_id) : null,
      product: doc.product_id ? require('./inventory').tryProduct(ctx.companyId, doc.product_id) : null,
    } };
  }, { permission: 'documents.view' }),
  R('GET', '/api/documents/:id/file', async (ctx) => {
    const { doc, path } = require('./documents').filePath(ctx.companyId, ctx.params.id);
    const fs = require('fs');
    return { _file: { buffer: fs.readFileSync(path), filename: doc.name, contentType: doc.mime, download: ctx.query.download === '1' } };
  }, { permission: 'documents.view' }),
  R('PATCH', '/api/documents/:id', async (ctx) => require('./documents').update(ctx.companyId, ctx.params.id, ctx.body, ctx.user), { permission: 'documents.manage' }),
  R('DELETE', '/api/documents/:id', async (ctx) => require('./documents').remove(ctx.companyId, ctx.params.id, ctx.user), { permission: 'documents.manage' }),
  R('POST', '/api/documents/:id/extract', async (ctx) => require('./documents').extract(ctx.companyId, ctx.params.id, ctx.user, { meta: ctx.meta }), { permission: 'documents.manage' }),
  R('POST', '/api/documents/:id/approve-extraction', async (ctx) => require('./documents').approveExtraction(ctx.companyId, ctx.params.id, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'documents.manage' }),

  // ═════════════════════════════ Xato Radar ══════════════════════════════
  R('GET', '/api/radar', async (ctx) => require('./radar').list(ctx.companyId, {
    severity: ctx.query.severity, category: ctx.query.category, search: ctx.query.search,
    from: ctx.query.from, to: ctx.query.to, status: ctx.query.status,
  }), { permission: 'radar.view' }),
  R('POST', '/api/radar/scan', async (ctx) => require('./radar').scan(ctx.companyId, { from: ctx.body.from, to: ctx.body.to, force: true }, ctx.user), { permission: 'radar.view' }),
  R('GET', '/api/radar/:id', async (ctx) => require('./radar').get(ctx.companyId, ctx.params.id), { permission: 'radar.view' }),
  R('POST', '/api/radar/:id/ignore', async (ctx) => require('./radar').ignore(ctx.companyId, ctx.params.id, ctx.body, ctx.user), { permission: 'radar.resolve' }),
  R('POST', '/api/radar/:id/resolve', async (ctx) => require('./radar').resolve(ctx.companyId, ctx.params.id, ctx.body, ctx.user), { permission: 'radar.resolve' }),
  R('POST', '/api/radar/:id/fix', async (ctx) => require('./radar').applyFix(ctx.companyId, ctx.params.id, ctx.body, ctx.user, { meta: ctx.meta }), { permission: 'radar.resolve' }),

  // ══════════════════════════════ Hisobotlar ═════════════════════════════
  R('GET', '/api/reports', async () => ({ catalog: require('./reports').CATALOG }), { permission: 'reports.view' }),
  R('GET', '/api/reports/:key', async (ctx) => require('./reports').run(ctx.companyId, reportKey(ctx.params.key), ctx.query), { permission: 'reports.view' }),
  R('GET', '/api/reports/:key/export', async (ctx) => {
    const report = require('./reports').run(ctx.companyId, reportKey(ctx.params.key), ctx.query);
    const rows = flattenReport(report);
    const csv = toCsv(rows);
    return { _file: { buffer: Buffer.from(csv, 'utf8'), filename: `${ctx.params.key}-${U.today()}.csv`, contentType: 'text/csv; charset=utf-8', download: true } };
  }, { permission: 'reports.export' }),
  R('GET', '/api/drill', async (ctx) => require('./reports').drillDown(ctx.companyId, ctx.query.type, {
    ...ctx.query,
    to: ctx.query.to, from: ctx.query.from,
  }), { permission: 'reports.view' }),

  // ════════════════════════════════ AI ══════════════════════════════════
  R('POST', '/api/ai/ask', async (ctx) => {
    const question = ctx.body.message || ctx.body.question || ctx.body.q;
    if (!question) throw new ApiError('Savolni kiriting.', 400, 'missing_message');
    const range = ctx.body.range || (ctx.body.from && ctx.body.to ? { from: ctx.body.from, to: ctx.body.to, label: `${ctx.body.from} — ${ctx.body.to}`, key: 'custom' } : undefined);
    return require('./ai').ask(ctx.companyId, question, ctx.user, { range, meta: ctx.meta });
  }, { permission: 'ai.use' }),
  R('GET', '/api/ai/history', async (ctx) => ({ items: require('./ai').history(ctx.companyId, { limit: Number(ctx.query.limit || 40) }) }), { permission: 'ai.use' }),
  R('GET', '/api/ai/advisor', async (ctx) => require('./ai').advisor(ctx.companyId), { permission: 'ai.use' }),
  R('GET', '/api/ai/health', async (ctx) => require('./ai').financialHealth(ctx.companyId, { range: U.resolveRange(ctx.query) }), { permission: 'ai.use' }),
  R('GET', '/api/ai/forecast', async (ctx) => require('./ai').cashForecast(ctx.companyId, Number(ctx.query.days || 30)), { permission: 'ai.use' }),
  R('GET', '/api/ai/insight', async (ctx) => require('./ai').dailyInsight(ctx.companyId), { permission: 'ai.use' }),
  R('GET', '/api/ai/suggestions', async (ctx) => ({
    questions: [
      'Bu oy qancha foyda qildik?', 'Eng katta xarajatimiz nima?', 'Qaysi mijozlardan pul olishimiz kerak?',
      'Qaysi invoice overdue?', 'Cash flow keyingi oy qanday bo‘ladi?', 'Xarajatlarimiz nega oshdi?',
      'Qaysi supplier eng ko‘p xarajat keltiryapti?', 'Bugun buxgalter sifatida nima qilishim kerak?',
      'Qaysi xatolar bor?', 'Qaysi invoice’lar to‘lanmagan?', 'Moliyaviy salomatlik qanday?', 'Ombor holati qanday?',
    ],
    provider: require('./ai').providerConfig() ? 'LLM provayderi ulangan' : 'Ichki dvigatel (ma’lumotga bog‘langan)',
  }), { permission: 'ai.use' }),

  // ════════════════════════ Mening ishim / vazifalar ═════════════════════
  R('GET', '/api/my-work', async (ctx) => require('./work').myWork(ctx.companyId, ctx.user), { permission: 'dashboard.view' }),
  R('POST', '/api/tasks', async (ctx) => require('./work').createTask(ctx.companyId, ctx.body, ctx.user), { permission: 'dashboard.view' }),
  R('POST', '/api/tasks/:id/complete', async (ctx) => require('./work').completeTask(ctx.companyId, ctx.params.id, ctx.user), { permission: 'dashboard.view' }),
  R('DELETE', '/api/tasks/:id', async (ctx) => require('./work').deleteTask(ctx.companyId, ctx.params.id, ctx.user), { permission: 'dashboard.view' }),

  // ═════════════════════════════ Tasdiqlash ══════════════════════════════
  R('GET', '/api/approvals', async (ctx) => require('./approvals').list(ctx.companyId, {
    status: ctx.query.status || 'pending', mine: ctx.query.mine === '1', user: ctx.user,
  }), { permission: 'approvals.view' }),
  R('POST', '/api/approvals/:id/approve', async (ctx) => require('./approvals').approve(ctx.companyId, ctx.params.id, ctx.user, ctx.body.note, { meta: ctx.meta }), { permission: 'approvals.approve' }),
  R('POST', '/api/approvals/:id/reject', async (ctx) => require('./approvals').reject(ctx.companyId, ctx.params.id, ctx.user, ctx.body.note, { meta: ctx.meta }), { permission: 'approvals.approve' }),

  // ════════════════════════════ Bildirishnomalar ═════════════════════════
  R('GET', '/api/notifications', async (ctx) => {
    const list = require('./notifications').list(ctx.companyId, {
      unread_only: ctx.query.unread === '1', type: ctx.query.type, limit: Number(ctx.query.limit || 50),
    });
    return { ...list, counts: require('./notifications').counts(ctx.companyId) };
  }, { permission: 'notifications.manage' }),
  R('POST', '/api/notifications/read-all', async (ctx) => require('./notifications').markAllRead(ctx.companyId, ctx.user), { permission: 'notifications.manage' }),
  R('POST', '/api/notifications/:id/read', async (ctx) => require('./notifications').markRead(ctx.companyId, ctx.params.id, ctx.user), { permission: 'notifications.manage' }),
  R('DELETE', '/api/notifications/:id', async (ctx) => require('./notifications').remove(ctx.companyId, ctx.params.id), { permission: 'notifications.manage' }),

  // ═════════════════════════════ Davr yopish ════════════════════════════
  R('GET', '/api/close', async (ctx) => {
    const checklist = require('./close').checklist(ctx.companyId, ctx.query.period || U.currentPeriod());
    return { ...checklist, checklist, periods: require('./close').listCloses(ctx.companyId) };
  }, { permission: 'close.manage' }),
  R('POST', '/api/close', async (ctx) => require('./close').closePeriod(ctx.companyId, ctx.body.period || U.currentPeriod(), ctx.user, ctx.body, ctx.meta), { permission: 'close.manage' }),
  R('POST', '/api/close/reopen', async (ctx) => require('./close').reopenPeriod(ctx.companyId, ctx.body.period, ctx.user, ctx.body.reason, ctx.meta), { permission: 'close.manage' }),

  // ════════════════════════════════ Soliq ════════════════════════════════
  R('GET', '/api/tax', async (ctx) => ({
    summary: require('./tax').summary(ctx.companyId, U.resolveRange(ctx.query)),
    calendar: require('./tax').calendar(ctx.companyId),
  }), { permission: 'tax.view' }),
  R('POST', '/api/tax/mark', async (ctx) => require('./tax').markDone(ctx.companyId, ctx.body, ctx.user), { permission: 'tax.manage' }),
  R('POST', '/api/tax/unmark', async (ctx) => require('./tax').unmark(ctx.companyId, ctx.body, ctx.user), { permission: 'tax.manage' }),
  R('POST', '/api/tax/verify-deadline', async (ctx) => require('./tax').verifyDeadline(ctx.companyId, ctx.body.key, ctx.body, ctx.user), { permission: 'tax.manage' }),

  // ═══════════════════════════════ Qidiruv ═══════════════════════════════
  R('GET', '/api/search', async (ctx) => require('./search').search(ctx.companyId, ctx.query.q || '', { limit: Number(ctx.query.limit || 6) })),
  R('GET', '/api/search/suggestions', async (ctx) => ({ items: require('./search').suggestions(ctx.companyId) })),

  // ═══════════════════════════ Buхgalteriya (COA) ════════════════════════
  R('GET', '/api/accounts', async (ctx) => {
    const items = ledger.accountsOf(ctx.companyId).map(a => ({
      ...a,
      balance: ledger.balanceOf(ctx.companyId, a.code),
      movement_count: ledger.entries(ctx.companyId).filter(e => e.lines.some(l => l.account === a.code)).length,
    }));
    return {
      items, accounts: items, total: items.length,
      trial_balance: ledger.trialBalance(ctx.companyId, { from: ctx.query.from || U.periodStart(U.currentPeriod()), to: ctx.query.to || U.periodEnd(U.currentPeriod()) }),
    };
  }, { permission: 'reports.view' }),
  R('POST', '/api/accounts', async (ctx) => {
    const { code, name, type, subtype, normal } = ctx.body;
    if (!code || !name) throw new ApiError('Kod va nom kiritilishi shart.', 400, 'missing_fields');
    if (ledger.tryAccount(ctx.companyId, code)) throw new ApiError(`«${code}» kodi band.`, 409, 'duplicate_code');
    if (!COA.TYPES.includes(type)) throw new ApiError('Hisob turi noto‘g‘ri.', 400, 'invalid_type');
    const acc = {
      id: store.uid('acc'), company_id: ctx.companyId, code: U.str(code, { max: 10, required: true, field: 'Kod' }),
      name: U.str(name, { max: 120, required: true, field: 'Nom' }), type,
      subtype: subtype || null, role: null,
      normal: normal === 'credit' ? 'credit' : (normal === 'debit' ? 'debit' : (type === 'asset' || type === 'expense' ? 'debit' : 'credit')),
      is_cash: false, is_bank: false, is_system: false, active: true, created_at: store.nowISO(),
    };
    store.collection('accounts').push(acc);
    store.save();
    audit.log({ company_id: ctx.companyId, user: ctx.user, action: 'account.create', entity: 'account', entity_id: acc.id, summary: `Hisob qo‘shildi: ${acc.code} ${acc.name}`, after: acc, meta: ctx.meta });
    return acc;
  }, { permission: 'settings.manage' }),
  R('PATCH', '/api/accounts/:id', async (ctx) => {
    const acc = ledger.accountsOf(ctx.companyId).find(a => a.id === ctx.params.id);
    if (!acc) throw new ApiError('Hisob topilmadi.', 404, 'not_found');
    const before = { ...acc };
    if (ctx.body.name) acc.name = U.str(ctx.body.name, { max: 120, required: true, field: 'Nom' });
    if (ctx.body.active !== undefined) {
      if (acc.is_system && ctx.body.active === false) throw new ApiError('Tizim hisobini o‘chirib bo‘lmaydi.', 400, 'system_account');
      acc.active = !!ctx.body.active;
    }
    if (ctx.body.role !== undefined) {
      if (!acc.is_system) acc.role = ctx.body.role || null;
    }
    store.save();
    audit.log({ company_id: ctx.companyId, user: ctx.user, action: 'account.update', entity: 'account', entity_id: acc.id, summary: `Hisob tahrirlandi: ${acc.code} ${acc.name}`, before, after: { ...acc }, meta: ctx.meta });
    return acc;
  }, { permission: 'settings.manage' }),

  // ═══════════════════════════ Jurnal yozuvlari ══════════════════════════
  R('GET', '/api/journal', async (ctx) => ({
    entries: ledger.journalQuery(ctx.companyId, {
      from: ctx.query.from, to: ctx.query.to, account: ctx.query.account, party_id: ctx.query.party_id,
      source_type: ctx.query.source_type, search: ctx.query.search, include_void: ctx.query.include_void === '1',
      limit: Number(ctx.query.limit || 200),
    }),
    trial_balance: ledger.trialBalance(ctx.companyId, { from: ctx.query.from || U.periodStart(U.currentPeriod()), to: ctx.query.to || U.periodEnd(U.currentPeriod()) }),
  }), { permission: 'transactions.view' }),

  // ═════════════════════════════ Audit jurnali ═══════════════════════════
  R('GET', '/api/audit', async (ctx) => ({
    items: audit.query(ctx.companyId, {
      user_id: ctx.query.user_id, entity: ctx.query.entity, entity_id: ctx.query.entity_id,
      action: ctx.query.action, from: ctx.query.from, to: ctx.query.to, search: ctx.query.search,
      limit: Number(ctx.query.limit || 200),
    }),
  }), { permission: 'audit.view' }),

  // ═══════════════════════════ Jamo a'zolari ═════════════════════════════
  R('GET', '/api/users', async (ctx) => ({ items: auth.membersOf(ctx.companyId) }), { permission: 'users.view' }),
  R('POST', '/api/users', async (ctx) => {
    const role = ctx.body.role || 'accountant';
    let user = auth.findUserByEmail(ctx.body.email);
    let created = false;
    if (!user) {
      user = auth.createUser({ name: ctx.body.name, email: ctx.body.email, password: ctx.body.password || 'Buxai2026!', role, phone: ctx.body.phone });
      created = true;
    }
    const existing = auth.roleInCompany(user, ctx.companyId);
    if (existing) throw new ApiError('Bu foydalanuvchi allaqachon kompaniyaga qo‘shilgan.', 409, 'already_member');
    const sub = companiesMod.subscriptionFor(ctx.companyId);
    const members = auth.membersOf(ctx.companyId).length;
    if (members + 1 > sub.plan_def.limits.users) {
      throw new ApiError(`Tarif bo‘yicha foydalanuvchi limiti: ${sub.plan_def.limits.users}. Tarifni yangilang.`, 402, 'plan_limit', { limit: sub.plan_def.limits.users });
    }
    auth.addMembership(user.id, ctx.companyId, role);
    audit.log({ company_id: ctx.companyId, user: ctx.user, action: 'user.invite', entity: 'user', entity_id: user.id, summary: `Foydalanuvchi qo‘shildi: ${user.name} (${auth.ROLES[role].label})`, after: { role, email: user.email }, meta: ctx.meta });
    return { user: auth.publicUser(user), created, temporary_password: created ? (ctx.body.password || 'Buxai2026!') : null };
  }, { permission: 'users.manage' }),
  R('PATCH', '/api/users/:id', async (ctx) => {
    const user = auth.findUser(ctx.params.id);
    if (!user) throw new ApiError('Foydalanuvchi topilmadi.', 404, 'not_found');
    const role = ctx.body.role;
    if (role && !auth.ROLES[role]) throw new ApiError('Rol noto‘g‘ri.', 400, 'invalid_role');
    if (ctx.params.id === ctx.user.id && role && role !== 'director' && auth.roleInCompany(ctx.user, ctx.companyId) === 'director') {
      throw new ApiError('O‘z rolingizni pasaytira olmaysiz. Buni boshqa rahbar amalga oshirishi mumkin.', 400, 'self_demote');
    }
    const before = auth.roleInCompany(user, ctx.companyId);
    auth.addMembership(user.id, ctx.companyId, role || before || 'accountant');
    if (ctx.body.name) user.name = U.str(ctx.body.name, { max: 120, required: true, field: 'Ism' });
    if (ctx.body.phone !== undefined) user.phone = U.str(ctx.body.phone, { max: 30 });
    if (ctx.body.status && ['active', 'blocked'].includes(ctx.body.status)) user.status = ctx.body.status;
    store.save();
    audit.log({ company_id: ctx.companyId, user: ctx.user, action: 'user.update', entity: 'user', entity_id: user.id, summary: `Foydalanuvchi yangilandi: ${user.name} (${before} → ${role || before})`, before: { role: before }, after: { role: role || before, status: user.status }, meta: ctx.meta });
    return auth.publicUser(user);
  }, { permission: 'users.manage' }),
  R('DELETE', '/api/users/:id', async (ctx) => {
    if (ctx.params.id === ctx.user.id) throw new ApiError('O‘zingizni kompaniyadan chiqara olmaysiz.', 400, 'self_remove');
    const m = store.collection('memberships').find(x => x.user_id === ctx.params.id && x.company_id === ctx.companyId);
    if (!m) throw new ApiError('A’zolik topilmadi.', 404, 'not_found');
    const directors = store.collection('memberships').filter(x => x.company_id === ctx.companyId && x.role === 'director' && x.status !== 'removed');
    if (m.role === 'director' && directors.length <= 1) throw new ApiError('Kompaniyada kamida bitta rahbar qolishi kerak.', 409, 'last_director');
    m.status = 'removed';
    m.removed_at = store.nowISO();
    store.save();
    const u = auth.findUser(ctx.params.id);
    audit.log({ company_id: ctx.companyId, user: ctx.user, action: 'user.remove', entity: 'user', entity_id: ctx.params.id, summary: `Foydalanuvchi kompaniyadan chiqarildi: ${u ? u.name : ctx.params.id}`, meta: ctx.meta });
    return { removed: true };
  }, { permission: 'users.manage' }),

  // ═════════════════════════════ Sozlamalar ══════════════════════════════
  R('GET', '/api/settings', async (ctx) => ({
    settings: ledger.getSettings(ctx.companyId),
    company: store.collection('companies').find(c => c.id === ctx.companyId),
    role_accounts: Object.fromEntries(Object.keys(COA.DEFAULT_ROLE_MAP).map(role => [role, ledger.roleCode(ctx.companyId, role)])),
    subscription: companiesMod.subscriptionFor(ctx.companyId),
    usage: companiesMod.usageFor(ctx.companyId),
  }), { permission: 'company.view' }),
  R('PATCH', '/api/settings', async (ctx) => {
    const allowed = ['vat_rate', 'vat_enabled', 'tax_mode', 'approval_threshold', 'document_required_above', 'fiscal_year_start', 'lock_after_close', 'auto_approve_journal', 'role_accounts'];
    const patch = {};
    for (const k of allowed) if (ctx.body[k] !== undefined) patch[k] = ctx.body[k];
    if (patch.vat_rate != null) patch.vat_rate = U.clamp(U.num(patch.vat_rate), 0, 100);
    if (patch.approval_threshold != null) patch.approval_threshold = U.amount(patch.approval_threshold);
    if (patch.document_required_above != null) patch.document_required_above = U.amount(patch.document_required_above);
    if (patch.tax_mode && !['simplified', 'vat', 'none'].includes(patch.tax_mode)) throw new ApiError('Soliq rejimi noto‘g‘ri.', 400, 'invalid_tax_mode');
    if (patch.tax_mode) patch.vat_enabled = patch.tax_mode === 'vat';
    const { before, after } = ledger.saveSettings(ctx.companyId, patch, ctx.user);
    audit.log({ company_id: ctx.companyId, user: ctx.user, action: 'settings.update', entity: 'settings', entity_id: ctx.companyId, summary: 'Kompaniya sozlamalari yangilandi', before, after, meta: ctx.meta });
    return { settings: after, changed: Object.keys(patch) };
  }, { permission: 'settings.manage' }),

  // ═══════════════════════════ Kompaniyalar ══════════════════════════════
  R('GET', '/api/companies', async (ctx) => ({
    items: auth.companiesFor(ctx.user).map(c => companiesMod.companySummary(c.id)),
    active_company_id: ctx.companyId,
  })),
  R('POST', '/api/companies', async (ctx) => {
    if (!ctx.body.name) throw new ApiError('Kompaniya nomini kiriting.', 400, 'name_required');
    if (!auth.canAnywhere(ctx.user, 'companies.create')) {
      throw new ApiError('Kompaniya yaratish uchun direktor huquqi kerak.', 403, 'forbidden');
    }
    const owned = auth.companiesFor(ctx.user).length;
    if (ctx.companyId) {
      const limits = companiesMod.subscriptionFor(ctx.companyId).plan_def.limits;
      if (owned >= limits.companies) {
        throw new ApiError(`Joriy tarifda ${limits.companies} ta kompaniya ruxsat etilgan. Tarifni yangilang.`, 402, 'plan_limit', { limit: limits.companies });
      }
    }
    const company = companiesMod.createCompany(ctx.body, ctx.user, { seed: !!ctx.body.seed });
    ctx.user.last_company_id = company.id;
    store.save();
    return { ok: true, company: companiesMod.companySummary(company.id), companies: auth.companiesFor(ctx.user).map(c => companiesMod.companySummary(c.id)) };
  }),
  R('PATCH', '/api/companies/:id', async (ctx) => {
    auth.requireCompanyAccess(ctx.user, ctx.params.id);
    auth.requirePermission(ctx.user, 'settings.manage', ctx.params.id);
    return companiesMod.updateCompany(ctx.params.id, ctx.body, ctx.user);
  }),
  R('POST', '/api/companies/:id/seed', async (ctx) => {
    auth.requireCompanyAccess(ctx.user, ctx.params.id);
    auth.requirePermission(ctx.user, 'settings.manage', ctx.params.id);
    const result = require('./seed').seedCompany(ctx.params.id, ctx.user, ctx.body.profile || 'demo');
    require('./radar').invalidate(ctx.params.id);
    return result;
  }),
  R('DELETE', '/api/companies/:id', async (ctx) => {
    auth.requireCompanyAccess(ctx.user, ctx.params.id);
    auth.requirePermission(ctx.user, 'subscription.manage', ctx.params.id);
    return companiesMod.archiveCompany(ctx.params.id, ctx.user);
  }),

  // ═════════════════════════════ Obuna ══════════════════════════════════
  R('GET', '/api/subscription', async (ctx) => {
    const sub = companiesMod.subscriptionFor(ctx.companyId);
    return {
      subscription: sub, plans: companiesMod.PLANS,
      usage: companiesMod.usageFor(ctx.companyId),
      limits: sub.plan_def.limits,
      payments: sub.payments || [],
      payment_integration: {
        configured: !!(process.env.PAYME_MERCHANT_ID || process.env.CLICK_SERVICE_ID || process.env.STRIPE_SECRET_KEY),
        note: (process.env.PAYME_MERCHANT_ID || process.env.CLICK_SERVICE_ID || process.env.STRIPE_SECRET_KEY)
          ? 'To‘lov tizimi sozlangan.'
          : 'Onlayn to‘lov tizimi sozlanmagan (Payme/Click/Stripe kalitlari yo‘q). Tarif o‘zgarishlari hozircha qo‘lda — hisob-faktura asosida amalga oshiriladi.',
      },
    };
  }, { permission: 'company.view' }),
  R('POST', '/api/subscription/change', async (ctx) => {
    if (ctx.body.confirm !== true) throw new ApiError('Tarifni o‘zgartirish uchun tasdiqlash kerak.', 400, 'confirm_required');
    const sub = companiesMod.changePlan(ctx.companyId, ctx.body.plan, ctx.user, { period: ctx.body.period || 'monthly' });
    const notes = [];
    if (!(process.env.PAYME_MERCHANT_ID || process.env.CLICK_SERVICE_ID || process.env.STRIPE_SECRET_KEY)) {
      notes.push('Onlayn to‘lov tizimi sozlanmagan — tarif qo‘lda o‘zgartirildi va hisob-faktura asosida to‘lanadi.');
    }
    if (sub.plan !== 'trial' && companiesMod.plan(sub.plan).price_monthly) {
      sub.payments = sub.payments || [];
      sub.payments.push({ date: U.today(), amount: 0, note: `Tarif o‘zgarishi: ${companiesMod.plan(sub.plan).name} (to‘lov qayd etilmagan)`, recorded_by: ctx.user.id });
    }
    store.save();
    return { subscription: sub, notes };
  }, { permission: 'subscription.manage' }),

  // ════════════════════════════ SuperAdmin ═══════════════════════════════
  R('GET', '/api/platform/overview', async (ctx) => { platform().requirePlatformAdmin(ctx.user); return platform().overview({ days: Number(ctx.query.days || 30) }); }),
  R('GET', '/api/platform/users', async (ctx) => { platform().requirePlatformAdmin(ctx.user); const r = platform().listUsers({ ...ctx.query, page: Number(ctx.query.page || 1), pageSize: Number(ctx.query.page_size || 50) }); return { items: r.rows, total: r.total, page: r.page, page_size: r.pageSize, pages: r.totalPages }; }),
  R('PATCH', '/api/platform/users/:id', async (ctx) => { platform().requirePlatformAdmin(ctx.user); return platform().updateUser(ctx.params.id, ctx.body, ctx.user); }),
  R('GET', '/api/platform/companies', async (ctx) => { platform().requirePlatformAdmin(ctx.user); const r = platform().listCompaniesAdmin({ ...ctx.query, page: Number(ctx.query.page || 1), pageSize: Number(ctx.query.page_size || 50) }); return { items: r.rows, total: r.total, page: r.page, page_size: r.pageSize, pages: r.totalPages }; }),
  R('GET', '/api/platform/errors', async (ctx) => { platform().requirePlatformAdmin(ctx.user); return { items: platform().errors(Number(ctx.query.limit || 100)) }; }),
  R('DELETE', '/api/platform/errors', async (ctx) => { platform().requirePlatformAdmin(ctx.user); return platform().clearErrors(); }),
  R('GET', '/api/platform/tickets', async (ctx) => { platform().requirePlatformAdmin(ctx.user); return { items: platform().listTickets({ status: ctx.query.status, company_id: ctx.query.company_id }) }; }),
  R('POST', '/api/platform/tickets/:id/reply', async (ctx) => { platform().requirePlatformAdmin(ctx.user); return platform().replyTicket(ctx.params.id, ctx.body, ctx.user); }),
  R('POST', '/api/support/tickets', async (ctx) => platform().createTicket(ctx.companyId, ctx.body, ctx.user)),
  R('GET', '/api/support/tickets', async (ctx) => ({ items: platform().listTickets({ company_id: ctx.companyId }) })),

  // ═══════════════════════════════ Tizim ═════════════════════════════════
  R('GET', '/api/health', async () => ({
    status: store.writeError ? 'degraded' : 'ok',
    storage: { driver: 'json-file', file: require('path').basename(store.DB_FILE), write_error: store.writeError ? String(store.writeError.message) : null },
    storage_warning: store.writeError ? 'Ma’lumotlarni saqlashda xatolik yuz berdi! Iltimos, administratorga murojaat qiling.' : null,
    version: require('../package.json').version,
    schema: store.SCHEMA,
    integrations: {
      llm: require('./ai').providerConfig() ? 'configured' : 'not_configured',
      email: process.env.SMTP_HOST ? 'configured' : 'not_configured',
      sms: process.env.SMS_PROVIDER_KEY ? 'configured' : 'not_configured',
      payments: (process.env.PAYME_MERCHANT_ID || process.env.CLICK_SERVICE_ID || process.env.STRIPE_SECRET_KEY) ? 'configured' : 'not_configured',
      ocr: process.env.BUXAI_OCR_PROVIDER ? 'configured' : 'local_text_layer',
    },
    time: store.nowISO(),
    today: U.today(),
  }), { public: true }),
];

function platform() { return require('./platform'); }

function flattenReport(report) {
  const rows = [];
  const walk = (node, prefix = '') => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${prefix}${i + 1}.`)); return; }
    if (node.rows && Array.isArray(node.rows)) {
      for (const r of node.rows) {
        const label = r.label || r.name || r.no || r.code || '';
        const value = r.value != null ? r.value : (r.amount != null ? r.amount : (r.total != null ? r.total : ''));
        rows.push({ bo_lim: prefix + (node.title || ''), qator: label, qiymat: value, eslatma: r.hint || r.note || '' });
      }
      return;
    }
    if (node.sections && Array.isArray(node.sections)) { for (const s of node.sections) walk(s, `${prefix}${s.title}: `); return; }
    if (node.items && Array.isArray(node.items)) { walk({ rows: node.items, title: node.title }, prefix); return; }
  };
  walk({ rows: report.rows || [], title: report.title });
  if (!rows.length && report.sections) walk(report, '');
  if (!rows.length && report.accounts) walk({ rows: report.accounts, title: report.title }, '');
  if (!rows.length && report.by_category) walk({ rows: report.by_category, title: report.title }, '');
  if (!rows.length && report.parties) walk({ rows: report.parties, title: report.title }, '');
  if (!rows.length && report.suppliers) walk({ rows: report.suppliers, title: report.title }, '');
  if (!rows.length && report.products) walk({ rows: report.products, title: report.title }, '');
  if (!rows.length && report.customers) walk({ rows: report.customers, title: report.title }, '');
  if (!rows.length) rows.push({ bo_lim: report.title, qator: 'Ma’lumot yo‘q', qiymat: '', eslatma: '' });
  return rows;
}

module.exports = { API, toCsv };
