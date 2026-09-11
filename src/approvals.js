'use strict';
/**
 * BUXAI — Tasdiqlash markazi (Approval Center).
 * Muhim amallar (yirik xarajat, AI tuzatishlari, jurnal yozuvlari, qaytarishlar)
 * direktor tasdig'isiz bajarilmaydi. Har bir qaror audit jurnaliga yoziladi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const STATUS_LABELS = { pending: 'Kutilmoqda', approved: 'Tasdiqlandi', rejected: 'Rad etildi', cancelled: 'Bekor qilindi' };

function all(companyId) { return store.collection('approvals').filter(a => a.company_id === companyId); }
function find(companyId, id) {
  const a = all(companyId).find(x => x.id === id);
  if (!a) throw new ApiError('Tasdiqlash so‘rovi topilmadi.', 404, 'not_found');
  return a;
}

function create(companyId, { type, entity_id, title, summary, amount = 0, requested_by, payload = {}, impact = '' }) {
  const existing = all(companyId).find(a => a.status === 'pending' && a.type === type && a.entity_id === entity_id);
  if (existing) return existing;
  const approval = {
    id: store.uid('apr'), company_id: companyId, type, entity_id,
    title: U.str(title, { max: 200, required: true }),
    summary: U.str(summary || '', { max: 1000 }),
    amount: U.round(U.num(amount), 0),
    impact: U.str(impact, { max: 500 }),
    payload,
    status: 'pending',
    requested_by: requested_by ? requested_by.id : null,
    requested_by_name: requested_by ? requested_by.name : 'Tizim',
    requested_at: store.nowISO(),
    decided_by: null, decided_by_name: null, decided_at: null, decision_note: null,
  };
  store.collection('approvals').push(approval);
  store.save();
  require('./notifications').onApproval(companyId, approval);
  require('./audit').log({
    company_id: companyId, user: requested_by, action: 'approval.request', entity: 'approval', entity_id: approval.id,
    summary: `Tasdiqlash so‘raldi: ${approval.title}`, after: { type, amount: approval.amount, entity_id },
  });
  return approval;
}

function decorate(a) {
  const requester = a.requested_by ? store.collection('users').find(u => u.id === a.requested_by) : null;
  const decider = a.decided_by ? store.collection('users').find(u => u.id === a.decided_by) : null;
  return {
    ...a,
    status_label: STATUS_LABELS[a.status] || a.status,
    requested_by_avatar: requester ? (requester.name || '').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() : 'TI',
    decided_by_name: decider ? decider.name : a.decided_by_name,
    is_overdue: a.status === 'pending' && U.daysBetween((a.requested_at || '').slice(0, 10), U.today()) > 2,
    age_days: U.daysBetween((a.requested_at || '').slice(0, 10), U.today()),
    link: linkFor(a),
  };
}
function linkFor(a) {
  switch (a.type) {
    case 'transaction': return { page: 'transactions', params: { id: a.entity_id } };
    case 'radar_fix': return { page: 'radar', params: { id: a.entity_id } };
    case 'journal': return { page: 'transactions', params: { id: a.entity_id } };
    case 'invoice_cancel': return { page: 'invoices', params: { id: a.entity_id } };
    case 'refund': return { page: 'invoices', params: { id: a.entity_id } };
    default: return { page: 'approvals', params: { id: a.id } };
  }
}

function list(companyId, { status = 'pending', mine = false, user } = {}) {
  let rows = all(companyId);
  if (status && status !== 'all') rows = rows.filter(a => a.status === status);
  if (mine && user) rows = rows.filter(a => a.requested_by === user.id);
  const out = U.sortBy(rows, a => a.requested_at, 'desc').map(decorate);
  return {
    items: out,
    summary: {
      pending: all(companyId).filter(a => a.status === 'pending').length,
      pending_amount: U.sumBy(all(companyId).filter(a => a.status === 'pending'), a => a.amount),
      approved_30d: all(companyId).filter(a => a.status === 'approved' && a.decided_at > U.addDays(U.today(), -30)).length,
      rejected_30d: all(companyId).filter(a => a.status === 'rejected' && a.decided_at > U.addDays(U.today(), -30)).length,
      by_type: [...U.groupBy(all(companyId).filter(a => a.status === 'pending'), a => a.type).entries()].map(([type, items]) => ({ type, count: items.length, amount: U.sumBy(items, i => i.amount) })),
    },
  };
}

/** So'rovni tasdiqlash — payload bo'yicha amal bajariladi */
function approve(companyId, id, user, note = '', { meta = {} } = {}) {
  const approval = find(companyId, id);
  if (approval.status !== 'pending') throw new ApiError(`So‘rov allaqachon ${STATUS_LABELS[approval.status].toLowerCase()}.`, 409, 'already_decided');
  if (approval.requested_by === user.id && !user.is_platform_admin && require('./auth').roleInCompany(user, companyId) !== 'director') {
    throw new ApiError('O‘z so‘rovingizni o‘zingiz tasdiqlay olmaysiz — boshqa rahbar yoki direktorga murojaat qiling.', 403, 'self_approval');
  }
  let result = null;
  if (approval.type === 'transaction' || approval.type === 'journal') {
    const entry = ledger.findEntry(companyId, approval.entity_id);
    if (!entry) throw new ApiError('Tegishli yozuv topilmadi (o‘chirilgan bo‘lishi mumkin).', 404, 'entry_not_found');
    if (entry.status === 'pending_approval') {
      entry.status = ledger.ENTRY_STATUS.POSTED;
      entry.posted_at = store.nowISO();
      entry.approved_by = user.id;
      store.save();
      result = { entry: { id: entry.id, no: entry.no, status: 'posted' } };
    }
  } else if (approval.type === 'radar_fix') {
    const entryId = approval.payload?.fix?.entry_id || approval.payload?.fix?.params?.entry_id;
    if (approval.payload?.fix?.type === 'reverse_entry' && entryId) {
      result = { reversal: require('./transactions').reverse(companyId, entryId, user, `Xato Radar tuzatishi: ${approval.title}`, meta) };
    } else {
      result = { manual: true };
    }
  } else if (approval.type === 'invoice_cancel') {
    result = { invoice: require('./invoices').cancel(companyId, approval.entity_id, approval.payload?.reason || note, user, { meta }) };
  } else if (approval.type === 'refund') {
    result = { invoice: require('./invoices').refund(companyId, approval.entity_id, { ...(approval.payload || {}), user }, meta) };
  } else {
    result = { manual: true };
  }
  approval.status = 'approved';
  approval.decided_by = user.id;
  approval.decided_by_name = user.name;
  approval.decided_at = store.nowISO();
  approval.decision_note = U.str(note || '', { max: 500 });
  approval.result = result && result.entry ? { entry: result.entry } : (result && result.reversal ? { reversal: result.reversal.reversal.no } : (result && result.invoice ? { invoice: result.invoice.no } : null));
  store.save();
  require('./notifications').onApprovalDecided(companyId, approval, user);
  require('./audit').log({
    company_id: companyId, user, action: 'approval.approve', entity: 'approval', entity_id: id,
    summary: `Tasdiqlandi: ${approval.title}${note ? ` — ${note}` : ''}`,
    before: { status: 'pending' }, after: { status: 'approved', result: approval.result }, meta,
  });
  return decorate(approval);
}

function reject(companyId, id, user, note = '', { meta = {} } = {}) {
  const approval = find(companyId, id);
  if (approval.status !== 'pending') throw new ApiError('So‘rov allaqachon hal qilingan.', 409, 'already_decided');
  approval.status = 'rejected';
  approval.decided_by = user.id;
  approval.decided_by_name = user.name;
  approval.decided_at = store.nowISO();
  approval.decision_note = U.str(note || '', { max: 500 });
  // Kutayotgan yozuv bekor qilinadi (e'tiborga olinmaydi, lekin tarix saqlanadi)
  if (approval.type === 'transaction' || approval.type === 'journal') {
    const entry = ledger.findEntry(companyId, approval.entity_id);
    if (entry && entry.status === 'pending_approval') {
      entry.status = ledger.ENTRY_STATUS.VOID;
      entry.void_reason = `Tasdiqlash rad etildi: ${note || 'sabab ko‘rsatilmagan'}`;
      entry.void_by = user.id;
      entry.void_at = store.nowISO();
      store.save();
    }
  }
  store.save();
  require('./notifications').onApprovalDecided(companyId, approval, user);
  require('./audit').log({
    company_id: companyId, user, action: 'approval.reject', entity: 'approval', entity_id: id,
    summary: `Rad etildi: ${approval.title}${note ? ` — ${note}` : ''}`, before: { status: 'pending' }, after: { status: 'rejected' }, meta,
  });
  return decorate(approval);
}

module.exports = { STATUS_LABELS, all, find, create, list, approve, reject, decorate };
