'use strict';
/**
 * BUXAI — «Mening ishim» (My Work): buxgalterning kunlik ish markazi.
 * Barcha vazifalar real ma'lumotlardan hosil qilinadi (bo'sh ro'yxat = ish yo'q).
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

function taskList(companyId) { return store.collection('tasks').filter(t => t.company_id === companyId); }

function createTask(companyId, input, user) {
  const task = {
    id: store.uid('tsk'), company_id: companyId,
    title: U.str(input.title, { max: 200, required: true, field: 'Vazifa nomi' }),
    detail: U.str(input.detail || '', { max: 1000 }),
    due_date: U.isValidDate(input.due_date) ? input.due_date : U.today(),
    priority: ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium',
    assignee_id: input.assignee_id || (user ? user.id : null),
    link: input.link || null,
    status: 'open', created_by: user ? user.id : null, created_at: store.nowISO(),
    completed_at: null,
  };
  store.collection('tasks').push(task);
  store.save();
  require('./audit').log({ company_id: companyId, user, action: 'task.create', entity: 'task', entity_id: task.id, summary: `Vazifa yaratildi: ${task.title}`, after: task });
  return task;
}
function completeTask(companyId, id, user) {
  const t = taskList(companyId).find(x => x.id === id);
  if (!t) throw new ApiError('Vazifa topilmadi.', 404, 'not_found');
  t.status = 'done';
  t.completed_at = store.nowISO();
  t.completed_by = user ? user.id : null;
  store.save();
  require('./audit').log({ company_id: companyId, user, action: 'task.complete', entity: 'task', entity_id: id, summary: `Vazifa bajarildi: ${t.title}` });
  return t;
}
function deleteTask(companyId, id, user) {
  const col = store.collection('tasks');
  const i = col.findIndex(x => x.id === id && x.company_id === companyId);
  if (i < 0) throw new ApiError('Vazifa topilmadi.', 404, 'not_found');
  const [t] = col.splice(i, 1);
  store.save();
  require('./audit').log({ company_id: companyId, user, action: 'task.delete', entity: 'task', entity_id: id, summary: `Vazifa o‘chirildi: ${t.title}`, before: t });
  return t;
}

/**
 * Kunlik ish ro'yxati. Har bir element: title, detail, count, amount, link, severity, source.
 */
function myWork(companyId, user = null, { skipAi = false } = {}) {
  const today = U.today();
  const priorities = [];
  const income = require('./invoices');
  const billsMod = require('./bills');
  const banking = require('./banking');

  // 1. Tasdiqlash kutayotgan yozuvlar
  const pending = ledger.pendingEntries(companyId);
  if (pending.length) {
    priorities.push({
      key: 'approvals', title: 'Tasdiqlash kutilmoqda', count: pending.length,
      amount: U.sumBy(pending, e => U.sumBy(e.lines, l => l.debit)),
      detail: `${pending.length} ta yozuv tasdiqlashni kutmoqda (jami ${U.fmtMoney(U.sumBy(pending, e => U.sumBy(e.lines, l => l.debit)))}).`,
      severity: 'high', link: { page: 'approvals', params: {} }, icon: 'approval',
      items: pending.slice(0, 5).map(e => ({ id: e.id, title: e.no, detail: e.memo, amount: U.sumBy(e.lines, l => l.debit), date: e.date })),
    });
  }

  // 2. Xato Radar muhim topilmalari
  const radar = require('./radar').counts(companyId);
  if (radar.total) {
    priorities.push({
      key: 'radar', title: 'Xato Radar topilmalari', count: radar.total,
      amount: radar.impact, severity: radar.critical ? 'critical' : radar.high ? 'high' : 'medium',
      detail: `${radar.total} ta topilma, shundan ${radar.high + radar.critical} tasi muhim. Moliyaviy ta’sir ~${U.fmtMoney(radar.impact)}.`,
      link: { page: 'radar', params: {} }, icon: 'radar',
      items: radar.top.map(i => ({ id: i.id, title: i.title, detail: i.what, amount: i.impact, severity: i.severity })),
    });
  }

  // 3. Bank solishtirish
  const unmatched = store.collection('bankRows').filter(r => r.company_id === companyId && r.status === 'unmatched');
  if (unmatched.length) {
    priorities.push({
      key: 'reconciliation', title: 'Bank solishtirish', count: unmatched.length,
      amount: U.sumBy(unmatched, r => r.amount), severity: unmatched.length > 20 ? 'high' : 'medium',
      detail: `${unmatched.length} ta bank harakati buxgalteriya bilan solishtirilmagan (${U.fmtMoney(U.sumBy(unmatched, r => r.amount))}).`,
      link: { page: 'reconciliation', params: {} }, icon: 'bank',
    });
  }

  // 4. Muddati o‘tgan hisob-fakturalar
  const ar = income.receivablesSummary(companyId);
  if (ar.overdue > 0) {
    priorities.push({
      key: 'overdue_invoices', title: 'Muddati o‘tgan hisob-fakturalar', count: ar.overdue_count,
      amount: ar.overdue, severity: 'high',
      detail: `${ar.overdue_count} ta hisob-faktura bo‘yicha ${U.fmtMoney(ar.overdue)} undirilishi kerak.`,
      link: { page: 'receivables', params: {} }, icon: 'invoice',
      items: ar.invoices.filter(i => i.is_overdue).slice(0, 5).map(i => ({ id: i.id, title: `${i.no} — ${i.customer_name}`, detail: `${i.overdue_days} kun o‘tgan`, amount: i.open_amount })),
    });
  }

  // 5. Yaqin 7 kunda to‘lanadigan hisoblar
  const upcomingBills = billsMod.upcoming(companyId, 7);
  if (upcomingBills.length) {
    const total = U.sumBy(upcomingBills, b => b.open_amount);
    const cash = ledger.cashPosition(companyId).total;
    priorities.push({
      key: 'upcoming_payments', title: 'Yaqin to‘lovlar', count: upcomingBills.length,
      amount: total, severity: cash < total ? 'high' : 'medium',
      detail: `${upcomingBills.length} ta hisob 7 kun ichida to‘lanishi kerak — ${U.fmtMoney(total)}. ${cash < total ? `Mavjud pul ${U.fmtMoney(cash)} — yetarli emas.` : `Mavjud pul: ${U.fmtMoney(cash)}.`}`,
      link: { page: 'payables', params: {} }, icon: 'payment',
      items: upcomingBills.slice(0, 5).map(b => ({ id: b.id, title: `${b.no} — ${b.supplier_name}`, detail: `muddat: ${b.due_date}`, amount: b.open_amount })),
    });
  }

  // 6. Qoralama hisob-fakturalar (rasmiylashtirilmagan)
  const drafts = store.collection('invoices').filter(i => i.company_id === companyId && i.status === 'draft');
  if (drafts.length) {
    priorities.push({
      key: 'draft_invoices', title: 'Rasmiylashtirilmagan hisob-fakturalar', count: drafts.length,
      amount: U.sumBy(drafts, i => i.total), severity: 'medium',
      detail: `${drafts.length} ta qoralama hisob-faktura rasmiylashtirilishi kerak (${U.fmtMoney(U.sumBy(drafts, i => i.total))}).`,
      link: { page: 'invoices', params: { status: 'draft' } }, icon: 'draft',
    });
  }

  // 7. OCR tasdiqlash kutayotgan hujjatlar
  const pendingDocs = store.collection('documents').filter(d => d.company_id === companyId && !d.deleted_at && d.status === 'pending_review');
  if (pendingDocs.length) {
    priorities.push({
      key: 'documents_review', title: 'Hujjat tahlilini tasdiqlash', count: pendingDocs.length, amount: 0, severity: 'medium',
      detail: `${pendingDocs.length} ta hujjat uchun OCR natijasi tasdiqlanmagan.`,
      link: { page: 'documents', params: { status: 'pending_review' } }, icon: 'document',
    });
  }

  // 8. Davr yopish (oy oxiri)
  const closeMod = require('./close');
  const checklist = closeMod.checklist(companyId, U.currentPeriod());
  if (checklist.should_close || checklist.status !== 'closed') {
    if (checklist.summary.failed || checklist.summary.warning || U.today() >= U.periodEnd(U.currentPeriod()).slice(0, 8) + '25') {
      priorities.push({
        key: 'month_close', title: `${U.periodLabel(U.currentPeriod())} davrini yopish`, count: checklist.items.filter(i => i.status !== 'ok').length,
        amount: 0, severity: checklist.summary.failed ? 'high' : 'medium',
        detail: checklist.status === 'closed' ? 'Davr yopilgan.' : `${checklist.items.filter(i => i.status === 'ok').length}/${checklist.items.length} tekshiruv bajarildi.`,
        link: { page: 'close', params: { period: U.currentPeriod() } }, icon: 'close',
      });
    }
  }

  // 9. Shaxsiy vazifalar
  const tasks = taskList(companyId).filter(t => t.status === 'open');
  const overdueTasks = tasks.filter(t => t.due_date < today);
  if (overdueTasks.length) {
    priorities.push({
      key: 'tasks_overdue', title: 'Muddati o‘tgan shaxsiy vazifalar', count: overdueTasks.length, amount: 0, severity: 'medium',
      detail: `${overdueTasks.length} ta vazifa muddati o‘tgan.`,
      link: { page: 'my-work', params: { filter: 'overdue' } }, icon: 'task',
      items: overdueTasks.slice(0, 5).map(t => ({ id: t.id, title: t.title, detail: `muddat: ${t.due_date}` })),
    });
  }

  // 10. To‘lanmagan avanslar
  const advances = require('./payments').unallocatedAdvances(companyId).filter(p => U.daysBetween(p.date, today) > 30);
  if (advances.length) {
    priorities.push({
      key: 'advances', title: 'Taqsimlanmagan avanslar', count: advances.length,
      amount: U.sumBy(advances, a => a.unallocated), severity: 'low',
      detail: `${advances.length} ta to‘lov 30 kundan ortiq taqsimlanmagan (${U.fmtMoney(U.sumBy(advances, a => a.unallocated))}).`,
      link: { page: 'payments', params: {} }, icon: 'payment',
    });
  }

  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  priorities.sort((a, b) => (severityOrder[a.severity] - severityOrder[b.severity]) || (b.amount - a.amount));

  const dueToday = tasks.filter(t => t.due_date === today);
  const upcoming = tasks.filter(t => t.due_date > today).sort((a, b) => (a.due_date > b.due_date ? 1 : -1));
  const todayActions = priorities.filter(p => ['critical', 'high'].includes(p.severity));

  return {
    date: today,
    user: user ? { id: user.id, name: user.name, role: user.role } : null,
    greeting: priorities.length ? `Bugun ${priorities.length} ta ish bor` : 'Bugun shoshilinch ish yo‘q',
    totals: {
      total: priorities.length,
      critical: priorities.filter(p => p.severity === 'critical').length,
      high: priorities.filter(p => p.severity === 'high').length,
      items: U.sumBy(priorities, p => p.count || 0),
      financial_impact: U.sumBy(priorities, p => p.amount || 0),
    },
    priorities,
    today: {
      tasks: dueToday,
      actions: todayActions.slice(0, 5),
    },
    upcoming: upcoming.slice(0, 20),
    overdue: overdueTasks,
    tasks,
    approvals_pending: pending.length,
    ai_recommendations: skipAi ? [] : require('./ai').advisor(companyId).recommendations.slice(0, 3),
    radar: { total: radar.total, high: radar.high + radar.critical, impact: radar.impact },
    attention: {
      what_happened: buildWhatHappened(companyId, user),
      what_is_wrong: priorities.filter(p => ['critical', 'high'].includes(p.severity)).map(p => p.detail),
      what_is_next: priorities.slice(0, 3).map(p => p.title),
    },
  };
}

function buildWhatHappened(companyId, user) {
  const rows = require('./audit').query(companyId, { limit: 5 });
  return rows.map(r => ({ at: r.at, who: r.user_name, what: r.summary }));
}

module.exports = { myWork, createTask, completeTask, deleteTask, taskList };
