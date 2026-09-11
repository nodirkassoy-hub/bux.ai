'use strict';
/**
 * BUXAI — SuperAdmin (platforma darajasi).
 * Faqat platforma administratorlari uchun. Ko'rsatkichlar real ma'lumotlardan;
 * daromad faqat HAQIQATDA qayd etilgan to'lovlardan hisoblanadi (o'ylab topilmaydi).
 */
const store = require('./store');
const U = require('./util');
const auth = require('./auth');
const ledger = require('./ledger');
const companiesMod = require('./companies');
const { ApiError } = U;

function requirePlatformAdmin(user) {
  if (!user || !user.is_platform_admin) throw new ApiError('Bu bo‘lim faqat platforma administratori uchun.', 403, 'forbidden');
  return true;
}

function overview({ days = 30 } = {}) {
  const since = U.addDays(U.today(), -days);
  const users = store.collection('users');
  const companies = store.collection('companies').filter(c => c.status !== 'archived');
  const subs = store.collection('subscriptions');
  const byPlan = companiesMod.PLANS.map(p => {
    const list = subs.filter(s => s.plan === p.key);
    return {
      plan: p.key, name: p.name, count: list.length,
      price_monthly: p.price_monthly,
      mrr: p.price_monthly ? p.price_monthly * list.filter(s => s.status === 'active' && s.plan === p.key).length : null,
    };
  });
  const allPayments = store.collection('subscriptions').flatMap(s => (s.payments || []).map(p => ({ ...p, company_id: s.company_id, plan: s.plan })));
  const payments30 = allPayments.filter(p => (p.date || '') >= since);
  const entries30 = store.collection('entries').filter(e => (e.created_at || '') >= `${since}T00:00:00.000Z`).length;
  const usageRows = store.collection('usage').filter(u => u.period >= U.periodOf(since));
  const documents = store.collection('documents').filter(d => !d.deleted_at);
  const storageBytes = U.sumBy(documents, d => d.size || 0);
  return {
    generated_at: store.nowISO(),
    period_days: days,
    users: {
      total: users.length, active: users.filter(u => u.status !== 'blocked').length,
      blocked: users.filter(u => u.status === 'blocked').length,
      platform_admins: users.filter(u => u.is_platform_admin).length,
      new_30d: users.filter(u => (u.created_at || '') >= since).length,
    },
    companies: {
      total: companies.length,
      active: companies.length,
      new_30d: companies.filter(c => (c.created_at || '') >= since).length,
      with_activity_30d: U.uniq(store.collection('entries').filter(e => e.created_at >= `${since}T00:00:00.000Z`).map(e => e.company_id)).length,
      archived: store.collection('companies').filter(c => c.status === 'archived').length,
    },
    subscriptions: {
      by_plan: byPlan,
      trialing: subs.filter(s => s.status === 'trialing').length,
      active: subs.filter(s => s.status === 'active').length,
      expired: subs.filter(s => s.status === 'expired' || s.status === 'cancelled').length,
      mrr_configured: U.sumBy(byPlan.filter(p => p.mrr), p => p.mrr),
      mrr_note: 'MRR faol obunalar va tarif narxlari bo‘yicha hisoblangan. Haqiqiy tushum faqat qayd etilgan to‘lovlardan olinadi.',
    },
    revenue: {
      recorded_payments_30d: U.sumBy(payments30, p => U.num(p.amount)),
      recorded_payments_total: U.sumBy(allPayments, p => U.num(p.amount)),
      payment_count: allPayments.length,
      note: allPayments.length ? null : 'Obuna to‘lovlari hali qayd etilmagan — bu ko‘rsatkich 0, chunki real to‘lov ma’lumoti yo‘q. To‘lov tizimi ulangach (Payme/Click/Stripe) to‘lovlar shu yerda ko‘rinadi.',
    },
    activity: {
      entries_30d: entries30,
      entries_total: store.collection('entries').length,
      invoices_total: store.collection('invoices').length,
      documents_total: documents.length,
      ai_questions_30d: U.sumBy(usageRows.filter(u => u.metric === 'ai_question'), u => u.count),
      ocr_runs_30d: U.sumBy(usageRows.filter(u => u.metric === 'ocr'), u => u.count),
      transactions_30d: U.sumBy(usageRows.filter(u => u.metric !== 'ai_question' && u.metric !== 'ocr'), u => u.count),
      bank_rows_total: store.collection('bankRows').length,
      radar_issues_open: (() => { try { return store.collection('radarStates').filter(s => s.status === 'open').length; } catch (e) { return 0; } })(),
    },
    storage: {
      bytes: storageBytes,
      mb: U.round(storageBytes / 1048576, 1),
      documents: documents.length,
      by_company: U.sortBy(U.uniq(documents.map(d => d.company_id)).map(cid => {
        const rows = documents.filter(d => d.company_id === cid);
        const c = store.collection('companies').find(x => x.id === cid);
        return { company_id: cid, company: c ? c.name : '—', bytes: U.sumBy(rows, r => r.size), count: rows.length, mb: U.round(U.sumBy(rows, r => r.size) / 1048576, 1) };
      }), x => x.bytes, 'desc').slice(0, 10),
    },
    errors: errors(30),
    top_companies: U.sortBy(companies.map(c => {
      const entries = store.collection('entries').filter(e => e.company_id === c.id);
      const cash = ledger.cashPosition(c.id).total;
      return {
        id: c.id, name: c.name, inn: c.inn, created_at: c.created_at,
        entries: entries.length, cash,
        users: store.collection('memberships').filter(m => m.company_id === c.id).length,
        last_entry: entries.length ? U.sortBy(entries, e => e.created_at, 'desc')[0].created_at : null,
        plan: (store.collection('subscriptions').find(s => s.company_id === c.id) || {}).plan || 'trial',
      };
    }), c => c.entries, 'desc').slice(0, 10),
    support_tickets: store.collection('supportTickets').filter(t => t.status !== 'closed').length,
  };
}

function errors(limit = 50) {
  return U.sortBy(store.collection('errorLog'), e => e.at, 'desc').slice(0, limit);
}
function logError(entry) {
  const col = store.collection('errorLog');
  col.unshift({ id: store.uid('err'), at: store.nowISO(), ...entry });
  if (col.length > 1000) col.length = 1000;
  store.save();
}
function clearErrors() {
  const col = store.collection('errorLog');
  const n = col.length;
  col.length = 0;
  store.save();
  return { cleared: n };
}

function listUsers({ search, role, status, company_id, page = 1, pageSize = 50 } = {}) {
  let rows = store.collection('users');
  if (search) {
    const q = U.norm(search);
    rows = rows.filter(u => U.norm(`${u.name} ${u.email} ${u.phone || ''}`).includes(q));
  }
  if (role) rows = rows.filter(u => u.role === role);
  if (status) rows = rows.filter(u => (u.status || 'active') === status);
  if (company_id) {
    const ids = new Set(store.collection('memberships').filter(m => m.company_id === company_id).map(m => m.user_id));
    rows = rows.filter(u => ids.has(u.id));
  }
  const out = U.sortBy(rows, u => u.created_at, 'desc').map(u => ({
    ...auth.publicUser(u),
    companies: store.collection('memberships').filter(m => m.user_id === u.id && m.status !== 'removed').map(m => {
      const c = store.collection('companies').find(x => x.id === m.company_id);
      return { id: m.company_id, name: c ? c.name : '—', role: m.role };
    }),
    last_login_at: u.last_login_at || null,
    status: u.status || 'active',
  }));
  return U.paginate(out, { page, pageSize });
}

function updateUser(userId, patch, actor) {
  requirePlatformAdmin(actor);
  const user = store.collection('users').find(u => u.id === userId);
  if (!user) throw new ApiError('Foydalanuvchi topilmadi.', 404, 'not_found');
  const before = auth.publicUser(user);
  if (patch.status && ['active', 'blocked'].includes(patch.status)) {
    if (user.id === actor.id) throw new ApiError('O‘z hisobingizni bloklay olmaysiz.', 400, 'self_block');
    user.status = patch.status;
  }
  if (patch.is_platform_admin !== undefined) {
    if (user.id === actor.id && !patch.is_platform_admin) throw new ApiError('O‘z platforma huquqingizni olib tashlay olmaysiz.', 400, 'self_demote');
    user.is_platform_admin = !!patch.is_platform_admin;
  }
  if (patch.role && auth.ROLES[patch.role]) user.role = patch.role;
  if (patch.name) user.name = U.str(patch.name, { max: 120, required: true, field: 'Ism' });
  if (patch.phone !== undefined) user.phone = U.str(patch.phone, { max: 30 });
  store.save();
  require('./audit').log({ company_id: null, user: actor, action: 'platform.user_update', entity: 'user', entity_id: userId, summary: `Foydalanuvchi yangilandi: ${user.name}`, before, after: auth.publicUser(user) });
  return auth.publicUser(user);
}

function listCompaniesAdmin({ search, status, page = 1, pageSize = 50 } = {}) {
  let rows = store.collection('companies');
  if (status && status !== 'all') rows = rows.filter(c => (c.status || 'active') === status);
  if (search) {
    const q = U.norm(search);
    rows = rows.filter(c => U.norm(`${c.name} ${c.inn || ''} ${c.email || ''}`).includes(q));
  }
  const out = U.sortBy(rows, c => c.created_at, 'desc').map(c => companiesMod.companySummary(c.id));
  return U.paginate(out, { page, pageSize });
}

// ─────────────────────────── Qo'llab-quvvatlash ─────────────────────────────

function createTicket(companyId, { subject, message, category = 'other', priority = 'medium' }, user) {
  const t = {
    id: store.uid('sup'), company_id: companyId,
    subject: U.str(subject, { max: 200, required: true, field: 'Mavzu' }),
    message: U.str(message, { max: 3000, required: true, field: 'Xabar' }),
    category, priority,
    status: 'open', created_by: user ? user.id : null, created_by_name: user ? user.name : '—',
    created_at: store.nowISO(), replies: [],
  };
  store.collection('supportTickets').unshift(t);
  store.save();
  require('./audit').log({ company_id: companyId, user, action: 'support.create', entity: 'support', entity_id: t.id, summary: `Qo‘llab-quvvatlash so‘rovi: ${t.subject}` });
  return t;
}

function listTickets({ status, company_id } = {}) {
  let rows = store.collection('supportTickets');
  if (status && status !== 'all') rows = rows.filter(t => t.status === status);
  if (company_id) rows = rows.filter(t => t.company_id === company_id);
  return U.sortBy(rows, t => t.created_at, 'desc').map(t => ({
    ...t,
    company_name: (store.collection('companies').find(c => c.id === t.company_id) || {}).name || '—',
  }));
}

function replyTicket(id, { message, status = 'answered' }, user) {
  const t = store.collection('supportTickets').find(x => x.id === id);
  if (!t) throw new ApiError('So‘rov topilmadi.', 404, 'not_found');
  t.replies.push({ at: store.nowISO(), by: user ? user.name : '—', by_id: user ? user.id : null, message: U.str(message, { max: 3000, required: true, field: 'Javob' }) });
  t.status = status;
  t.updated_at = store.nowISO();
  store.save();
  require('./audit').log({ company_id: t.company_id, user, action: 'support.reply', entity: 'support', entity_id: id, summary: `Qo‘llab-quvvatlash javobi: ${t.subject}` });
  return t;
}

function closeTicket(id, user) {
  const t = store.collection('supportTickets').find(x => x.id === id);
  if (!t) throw new ApiError('So‘rov topilmadi.', 404, 'not_found');
  t.status = 'closed';
  t.closed_at = store.nowISO();
  store.save();
  require('./audit').log({ company_id: t.company_id, user, action: 'support.close', entity: 'support', entity_id: id, summary: `So‘rov yopildi: ${t.subject}` });
  return t;
}

module.exports = { requirePlatformAdmin, overview, errors, logError, clearErrors, listUsers, updateUser, listCompaniesAdmin, createTicket, listTickets, replyTicket, closeTicket };
