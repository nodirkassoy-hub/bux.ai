'use strict';
/**
 * BUXAI — Aqlli bildirishnomalar.
 * Faqat HARAKAT TALAB QILADIGAN holatlar uchun xabar yaratiladi (spam yo'q):
 * har bir bildirishnoma dedupe kaliti bilan bir marta yaratiladi va holat o'zgarsa yangilanadi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const TYPES = {
  invoice_overdue: { icon: 'invoice', severity: 'high', label: 'Hisob-faktura muddati o‘tgan' },
  payment_due: { icon: 'payment', severity: 'medium', label: 'To‘lov muddati yaqin' },
  payment_overdue: { icon: 'payment', severity: 'high', label: 'To‘lov muddati o‘tgan' },
  duplicate_transaction: { icon: 'radar', severity: 'high', label: 'Dublikat shubhasi' },
  low_inventory: { icon: 'inventory', severity: 'medium', label: 'Ombor qoldig‘i kam' },
  negative_inventory: { icon: 'inventory', severity: 'high', label: 'Manfiy ombor qoldig‘i' },
  bank_mismatch: { icon: 'bank', severity: 'medium', label: 'Bank solishtirish' },
  cashflow_risk: { icon: 'cashflow', severity: 'high', label: 'Pul oqimi riski' },
  missing_document: { icon: 'document', severity: 'low', label: 'Hujjat yetishmayapti' },
  unusual_expense: { icon: 'radar', severity: 'medium', label: 'Odatiy bo‘lmagan xarajat' },
  approval_pending: { icon: 'approval', severity: 'medium', label: 'Tasdiqlash kutilmoqda' },
  radar_critical: { icon: 'radar', severity: 'critical', label: 'Xato Radar: kritik muammo' },
  subscription: { icon: 'settings', severity: 'medium', label: 'Obuna' },
  tax_deadline: { icon: 'tax', severity: 'high', label: 'Soliq muddati' },
  system: { icon: 'settings', severity: 'low', label: 'Tizim' },
};

function all(companyId) { return store.collection('notifications').filter(n => n.company_id === companyId); }

function push(companyId, { type, title, body, link, dedupe_key, severity, data = null, min_interval_days = 1 }) {
  const t = TYPES[type] || TYPES.system;
  const key = dedupe_key || `${type}:${U.today()}`;
  const existing = all(companyId).find(n => n.dedupe_key === key);
  const now = store.nowISO();
  if (existing) {
    if (existing.read && U.daysBetween(existing.created_at.slice(0, 10), U.today()) < min_interval_days) return existing;
    const changed = existing.title !== title || existing.body !== body;
    existing.title = title;
    existing.body = body;
    existing.link = link || existing.link;
    existing.severity = severity || t.severity;
    existing.updated_at = now;
    if (changed) { existing.read = false; existing.reopened_at = now; }
    existing.count = (existing.count || 1) + 1;
    store.save();
    return existing;
  }
  const n = {
    id: store.uid('ntf'), company_id: companyId, type,
    icon: t.icon, severity: severity || t.severity,
    title: U.str(title, { max: 200 }), body: U.str(body || '', { max: 600 }),
    link: link || null, data, dedupe_key: key, read: false, count: 1,
    created_at: now, updated_at: now,
  };
  const col = store.collection('notifications');
  col.unshift(n);
  if (col.length > 5000) col.length = 5000;
  store.save();
  return n;
}

/** Kunlik/soatlik tekshiruv: real holatlardan bildirishnoma yaratadi */
function generate(companyId) {
  const created = [];
  try {
    // 1. Muddati o‘tgan hisob-fakturalar
    const ar = require('./invoices').receivablesSummary(companyId);
    for (const inv of ar.invoices.filter(i => i.is_overdue)) {
      created.push(push(companyId, {
        type: 'invoice_overdue',
        title: `${inv.no} — to‘lov muddati ${inv.overdue_days} kun o‘tgan`,
        body: `${inv.customer_name}: ${U.fmtMoney(inv.open_amount)} to‘lanmagan (muddat: ${inv.due_date}).`,
        link: { page: 'invoices', params: { id: inv.id } },
        dedupe_key: `invoice_overdue:${inv.id}`, min_interval_days: 7,
      }));
    }
    // 2. Yaqin to‘lovlar
    for (const b of require('./bills').upcoming(companyId, 3)) {
      created.push(push(companyId, {
        type: b.due_date < U.today() ? 'payment_overdue' : 'payment_due',
        title: `${b.supplier_name} — ${b.due_date} sanasida to‘lov`,
        body: `${b.no}: ${U.fmtMoney(b.open_amount)}${b.due_date < U.today() ? ' (muddati o‘tgan)' : ''}.`,
        link: { page: 'bills', params: { id: b.id } },
        dedupe_key: `bill_due:${b.id}`, min_interval_days: 3,
      }));
    }
    // 3. Bank solishtirish
    const unmatched = store.collection('bankRows').filter(r => r.company_id === companyId && r.status === 'unmatched');
    if (unmatched.length) {
      created.push(push(companyId, {
        type: 'bank_mismatch',
        title: `${unmatched.length} ta bank harakati solishtirilmagan`,
        body: `Jami ${U.fmtMoney(U.sumBy(unmatched, r => r.amount))}. Solishtirish bo‘limida ko‘rib chiqing.`,
        link: { page: 'reconciliation', params: {} },
        dedupe_key: `bank_mismatch:${unmatched.length > 20 ? 'many' : unmatched.length}`, min_interval_days: 2,
      }));
    }
    // 4. Xato Radar muhim topilmalari
    const radar = require('./radar').counts(companyId);
    if (radar.critical) {
      created.push(push(companyId, {
        type: 'radar_critical',
        title: `Xato Radar: ${radar.critical} ta kritik muammo`,
        body: radar.top.filter(t => t.severity === 'critical' || t.severity === 'high').map(t => t.title).join(' • ') || 'Kritik topilmalar mavjud.',
        link: { page: 'radar', params: { severity: 'critical' } },
        dedupe_key: `radar_critical:${radar.critical}`, min_interval_days: 1,
      }));
    }
    // 5. Ombor
    const inv = require('./inventory').reconciliation(companyId);
    for (const p of inv.negative_stock) {
      created.push(push(companyId, {
        type: 'negative_inventory',
        title: `Manfiy qoldiq: ${p.name}`,
        body: `Qoldiq ${p.stock} ${p.unit} — kirim yoki inventarizatsiya kerak.`,
        link: { page: 'inventory', params: { product_id: p.id } },
        dedupe_key: `neg_stock:${p.id}`, min_interval_days: 3,
      }));
    }
    if (inv.low_stock.length) {
      created.push(push(companyId, {
        type: 'low_inventory',
        title: `${inv.low_stock.length} ta mahsulot minimum darajadan past`,
        body: inv.low_stock.slice(0, 5).map(p => `${p.name} (${p.stock} ${p.unit})`).join(', '),
        link: { page: 'inventory', params: { low_stock: true } },
        dedupe_key: `low_stock:${inv.low_stock.length}`, min_interval_days: 7,
      }));
    }
    // 6. Pul oqimi riski
    const forecast = require('./ai').cashForecast(companyId, 30);
    if (forecast.available && forecast.risk.level === 'high') {
      created.push(push(companyId, {
        type: 'cashflow_risk',
        title: 'Pul oqimi riski aniqlandi',
        body: forecast.risk.message,
        link: { page: 'cashflow', params: {} },
        dedupe_key: `cashflow_risk:${forecast.totals.min_balance_date}`, min_interval_days: 3,
      }));
    }
    // 7. Hujjatsiz yirik operatsiyalar
    const settings = ledger.getSettings(companyId);
    const missing = ledger.entries(companyId, { from: U.addDays(U.today(), -30), to: U.today() })
      .filter(e => !(e.attachments || []).length && U.sumBy(e.lines, l => l.debit) >= (settings.document_required_above || 5000000));
    if (missing.length) {
      created.push(push(companyId, {
        type: 'missing_document',
        title: `${missing.length} ta yirik operatsiyada hujjat yo‘q`,
        body: `Oxirgi 30 kunda ${U.fmtMoney(U.sumBy(missing, e => U.sumBy(e.lines, l => l.debit)))} summasi uchun asos hujjat biriktirilmagan.`,
        link: { page: 'radar', params: { category: 'documents' } },
        dedupe_key: `missing_docs:${missing.length}`, min_interval_days: 7,
      }));
    }
    // 8. Tasdiqlash kutayotganlar
    const pending = ledger.pendingEntries(companyId);
    if (pending.length) {
      created.push(push(companyId, {
        type: 'approval_pending',
        title: `${pending.length} ta yozuv tasdiqlashni kutmoqda`,
        body: `Jami ${U.fmtMoney(U.sumBy(pending, e => U.sumBy(e.lines, l => l.debit)))}.`,
        link: { page: 'approvals', params: {} },
        dedupe_key: `approvals:${pending.length}`, min_interval_days: 2,
      }));
    }
    // 9. Obuna muddati
    const sub = require('./companies').subscriptionFor(companyId);
    if (sub.effective_status === 'trialing' && sub.trial_days_left != null && sub.trial_days_left <= 5) {
      created.push(push(companyId, {
        type: 'subscription',
        title: sub.trial_days_left <= 0 ? 'Sinov muddati tugadi' : `Sinov muddati ${sub.trial_days_left} kundan keyin tugaydi`,
        body: 'Tarifni tanlang — limitlar saqlanib qolishi uchun.',
        link: { page: 'subscription', params: {} },
        dedupe_key: `trial:${sub.trial_days_left}`, min_interval_days: 1,
      }));
    } else if (sub.effective_status === 'expired') {
      created.push(push(companyId, {
        type: 'subscription', severity: 'high',
        title: 'Obuna muddati tugagan',
        body: 'Yangi yozuvlar kiritilmaydi. Tarifni yangilang.',
        link: { page: 'subscription', params: {} },
        dedupe_key: 'trial:expired', min_interval_days: 1,
      }));
    }
    // 10. Soliq muddatlari
    for (const t of require('./tax').calendar(companyId).filter(e => e.status === 'overdue' || e.status === 'due_soon')) {
      created.push(push(companyId, {
        type: 'tax_deadline', severity: t.status === 'overdue' ? 'high' : 'medium',
        title: `${t.title} — ${t.status === 'overdue' ? 'muddat o‘tgan' : 'muddat yaqin'}`,
        body: `${U.periodLabel(t.period)} uchun muddat: ${t.due_date}.`,
        link: { page: 'tax', params: {} },
        dedupe_key: `tax:${t.key}:${t.period}`, min_interval_days: 1,
      }));
    }
  } catch (e) {
    console.error('[notifications] generate:', e.message);
  }
  return created;
}

function list(companyId, { unread_only = false, type, limit = 50 } = {}) {
  generate(companyId);
  let rows = all(companyId);
  if (unread_only) rows = rows.filter(n => !n.read);
  if (type) rows = rows.filter(n => n.type === type);
  const out = U.sortBy(rows, n => n.updated_at || n.created_at, 'desc').slice(0, limit);
  return {
    items: out,
    summary: {
      unread: all(companyId).filter(n => !n.read).length,
      total: all(companyId).length,
      critical: all(companyId).filter(n => !n.read && (n.severity === 'critical' || n.severity === 'high')).length,
      by_type: U.uniq(all(companyId).filter(n => !n.read).map(n => n.type)),
    },
  };
}

function markRead(companyId, id, user) {
  const n = all(companyId).find(x => x.id === id);
  if (!n) throw new ApiError('Bildirishnoma topilmadi.', 404, 'not_found');
  n.read = true;
  n.read_at = store.nowISO();
  n.read_by = user ? user.id : null;
  store.save();
  return n;
}
function markAllRead(companyId, user) {
  let count = 0;
  for (const n of all(companyId)) if (!n.read) { n.read = true; n.read_at = store.nowISO(); n.read_by = user ? user.id : null; count++; }
  store.save();
  return { marked: count };
}
function remove(companyId, id) {
  const col = store.collection('notifications');
  const i = col.findIndex(n => n.id === id && n.company_id === companyId);
  if (i >= 0) { col.splice(i, 1); store.save(); }
  return { deleted: true };
}

function counts(companyId) {
  const unread = all(companyId).filter(n => !n.read);
  return { unread: unread.length, critical: unread.filter(n => n.severity === 'critical' || n.severity === 'high').length, latest: unread.slice(0, 5) };
}

// Hodisalar uchun hook'lar
function onTransaction(companyId, entry, user) {
  const total = U.sumBy(entry.lines, l => l.debit);
  const settings = ledger.getSettings(companyId);
  if (total >= (settings.approval_threshold || Infinity) && entry.status === 'pending_approval') {
    push(companyId, {
      type: 'approval_pending', severity: 'high',
      title: 'Yirik operatsiya tasdiqlashni kutmoqda',
      body: `${entry.no}: ${U.fmtMoney(total)} — ${entry.memo}`,
      link: { page: 'approvals', params: {} },
      dedupe_key: `approval_tx:${entry.id}`,
    });
  }
}
function onApproval(companyId, approval) {
  push(companyId, {
    type: 'approval_pending',
    title: `Tasdiqlash so‘rovi: ${approval.title}`,
    body: `${approval.requested_by_name} tomonidan yuborilgan${approval.amount ? ` • ${U.fmtMoney(approval.amount)}` : ''}.`,
    link: { page: 'approvals', params: { id: approval.id } },
    dedupe_key: `approval:${approval.id}`,
  });
}
function onApprovalDecided(companyId, approval, user) {
  push(companyId, {
    type: 'system', severity: approval.status === 'approved' ? 'low' : 'medium',
    title: `${approval.status === 'approved' ? 'Tasdiqlandi' : 'Rad etildi'}: ${approval.title}`,
    body: `${user.name} tomonidan ${approval.status === 'approved' ? 'tasdiqlandi' : 'rad etildi'}.`,
    link: { page: 'approvals', params: { id: approval.id } },
    dedupe_key: `approval_decided:${approval.id}`,
  });
}

module.exports = { TYPES, generate, list, markRead, markAllRead, remove, counts, push, onTransaction, onApproval, onApprovalDecided };
