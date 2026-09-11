'use strict';
/**
 * BUXAI — Oy/davr yopish (Month-End Close) jarayoni.
 * Har bir tekshiruv real ma'lumotga asoslanadi: bajarildi / ogohlantirish / bajarilmadi.
 * Kritik xatolar mavjud bo'lsa, davrni faqat vakolatli foydalanuvchi (direktor/superadmin)
 * sabab ko'rsatib majburiy yopishi mumkin.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const ITEMS = [
  { key: 'bank_reconciliation', title: 'Bank solishtirish', critical: true, description: 'Bank ko‘chirmalari buxgalteriya yozuvlari bilan solishtirilgan' },
  { key: 'cash_reconciliation', title: 'Kassa solishtirish', critical: false, description: 'Kassa qoldiqlari haqiqiy sanoq bilan mos' },
  { key: 'receivables_review', title: 'Debitorlik qarzdorligini ko‘rib chiqish', critical: false, description: 'Muddati o‘tgan hisob-fakturalar tahlil qilingan' },
  { key: 'payables_review', title: 'Kreditorlik qarzdorligini ko‘rib chiqish', critical: false, description: 'To‘lanishi kerak hisoblar rejalashtirilgan' },
  { key: 'inventory_check', title: 'Ombor tekshiruvi', critical: true, description: 'Ombor qoldiqlari haqiqiy holatga mos, manfiy qoldiq yo‘q' },
  { key: 'missing_documents', title: 'Yetishmayotgan hujjatlar', critical: false, description: 'Yirik operatsiyalarga asos hujjatlar biriktirilgan' },
  { key: 'duplicates', title: 'Dublikat operatsiyalar', critical: true, description: 'Takroriy yozuvlar aniqlanmagan yoki tuzatilgan' },
  { key: 'unusual_transactions', title: 'Odatiy bo‘lmagan operatsiyalar', critical: false, description: 'Anomaliyalar ko‘rib chiqilgan' },
  { key: 'tax_review', title: 'Soliq tekshiruvi', critical: false, description: 'QQS/soliq hisob-kitoblari tekshirilgan' },
  { key: 'pnl_review', title: 'Foyda-zarar hisobotini tekshirish', critical: false, description: 'P&L ko‘rsatkichlari tasdiqlangan' },
  { key: 'balance_review', title: 'Balans hisobotini tekshirish', critical: true, description: 'Aktiv = Majburiyat + Kapital tengligi bajarilgan' },
  { key: 'radar_check', title: 'Xato Radar tekshiruvi', critical: true, description: 'Kritik topilmalar yo‘q yoki hal qilingan' },
];

function checklist(companyId, period) {
  if (!U.isValidPeriod(period)) throw new ApiError('Davr formati noto‘g‘ri (YYYY-MM).', 400, 'invalid_period');
  const from = U.periodStart(period), to = U.periodEnd(period);
  const close = ledger.periodClose(companyId, period);
  const items = [];
  const put = (key, status, detail, evidence = [], actions = []) => {
    const def = ITEMS.find(i => i.key === key);
    items.push({
      key, title: def.title, description: def.description, critical: def.critical,
      status, status_label: status === 'ok' ? 'Bajarildi' : status === 'warning' ? 'Ogohlantirish' : 'Bajarilmadi',
      detail, evidence, actions,
    });
  };

  // 1. Bank solishtirish
  const unmatchedRows = store.collection('bankRows').filter(r => r.company_id === companyId && r.status === 'unmatched');
  const imports = store.collection('bankImports').filter(i => i.company_id === companyId && i.period_start <= to && i.period_end >= from);
  const bankAccounts = ledger.accountsOf(companyId).filter(a => a.is_bank);
  if (!bankAccounts.length) put('bank_reconciliation', 'warning', 'Bank hisobi sozlanmagan — bank solishtirishni bajarish uchun hisob qo‘shing.', [], [{ label: 'Hisob qo‘shish', link: { page: 'bank', params: {} } }]);
  else if (!imports.length) put('bank_reconciliation', 'failed', `Davr uchun bank ko‘chirmasi yuklanmagan (${U.periodLabel(period)}).`, [{ label: 'Bank hisoblari', value: String(bankAccounts.length) }], [{ label: 'Ko‘chirma yuklash', link: { page: 'reconciliation', params: { period } } }]);
  else if (unmatchedRows.length) put('bank_reconciliation', unmatchedRows.length > 10 ? 'failed' : 'warning', `${unmatchedRows.length} ta bank harakati hali solishtirilmagan (${U.fmtMoney(U.sumBy(unmatchedRows, r => r.amount))}).`, [{ label: 'Solishtirilmagan', value: `${unmatchedRows.length} ta qator` }, { label: 'Summa', value: U.fmtMoney(U.sumBy(unmatchedRows, r => r.amount)) }], [{ label: 'Solishtirishni ochish', link: { page: 'reconciliation', params: {} } }]);
  else put('bank_reconciliation', 'ok', `${imports.length} ta ko‘chirma import qilingan, barcha qatorlar solishtirilgan.`, [{ label: 'Importlar', value: String(imports.length) }]);

  // 2. Kassa solishtirish
  const cashAccounts = ledger.accountsOf(companyId).filter(a => a.is_cash);
  if (!cashAccounts.length) put('cash_reconciliation', 'ok', 'Kassa hisobi yo‘q — tekshirish talab qilinmaydi.');
  else {
    const counts = store.collection('entries').filter(e => e.company_id === companyId && e.source.type === 'cash_count' && e.date >= from && e.date <= to);
    const cashBalance = U.sumBy(cashAccounts, a => ledger.balanceOf(companyId, a.code, { asOf: to }));
    if (counts.length) put('cash_reconciliation', 'ok', `Kassa sanoqi o‘tkazilgan (${counts.length} marta). Joriy qoldiq ${U.fmtMoney(cashBalance)}.`, [{ label: 'Kassa qoldig‘i', value: U.fmtMoney(cashBalance) }]);
    else put('cash_reconciliation', 'warning', `Davr uchun kassa sanoqi qayd etilmagan. Kassa qoldig‘i: ${U.fmtMoney(cashBalance)}.`, [{ label: 'Kassa qoldig‘i', value: U.fmtMoney(cashBalance) }], [{ label: 'Kassa sanoqini kiritish', link: { page: 'bank', params: {} } }]);
  }

  // 3. Debitorlik
  const ar = require('./invoices').receivablesSummary(companyId, { asOf: to });
  if (ar.overdue > 0) put('receivables_review', 'warning', `${ar.overdue_count} ta hisob-faktura muddati o‘tgan — ${U.fmtMoney(ar.overdue)}. Undirish rejasi kerak.`, [{ label: 'Muddati o‘tgan', value: U.fmtMoney(ar.overdue) }, { label: 'Jami AR', value: U.fmtMoney(ar.total) }], [{ label: 'Debitorlikni ko‘rish', link: { page: 'receivables', params: {} } }]);
  else put('receivables_review', 'ok', `Debitorlik ${U.fmtMoney(ar.total)} — muddati o‘tgan qarz yo‘q.`, [{ label: 'Jami AR', value: U.fmtMoney(ar.total) }]);

  // 4. Kreditorlik
  const ap = require('./bills').payablesSummary(companyId, { asOf: to });
  if (ap.overdue > 0) put('payables_review', 'warning', `${ap.overdue_count} ta hisob muddati o‘tgan — ${U.fmtMoney(ap.overdue)}.`, [{ label: 'Muddati o‘tgan', value: U.fmtMoney(ap.overdue) }], [{ label: 'Kreditorlikni ko‘rish', link: { page: 'payables', params: {} } }]);
  else put('payables_review', 'ok', `Kreditorlik ${U.fmtMoney(ap.total)} — muddati o‘tgan hisob yo‘q.`, [{ label: 'Jami AP', value: U.fmtMoney(ap.total) }]);

  // 5. Ombor
  const inv = require('./inventory').reconciliation(companyId);
  if (inv.negative_stock.length) put('inventory_check', 'failed', `${inv.negative_stock.length} ta mahsulotda manfiy qoldiq bor — buxgalteriya jihatidan mumkin emas.`, inv.negative_stock.slice(0, 5).map(p => ({ label: p.name, value: `${p.stock} ${p.unit}` })), [{ label: 'Omborni ko‘rish', link: { page: 'inventory', params: {} } }]);
  else if (!inv.consistent) put('inventory_check', 'warning', `Ombor qiymati (${U.fmtMoney(inv.total_value)}) va jurnaldagi qiymat (${U.fmtMoney(inv.ledger_value)}) o‘rtasida ${U.fmtMoney(inv.difference)} farq bor.`, [{ label: 'Ombor kartochkalari', value: U.fmtMoney(inv.total_value) }, { label: 'Jurnal', value: U.fmtMoney(inv.ledger_value) }], [{ label: 'Omborni ko‘rish', link: { page: 'inventory', params: {} } }]);
  else if (inv.low_stock.length) put('inventory_check', 'warning', `${inv.low_stock.length} ta mahsulot minimum darajadan past.`, inv.low_stock.slice(0, 5).map(p => ({ label: p.name, value: `${p.stock} ${p.unit}` })));
  else put('inventory_check', 'ok', `Ombor qiymati ${U.fmtMoney(inv.total_value)} — muammo aniqlanmadi.`, [{ label: 'Mahsulotlar', value: String(inv.total_skus) }]);

  // 6. Hujjatlar
  const settings = ledger.getSettings(companyId);
  const missingDocs = ledger.entries(companyId, { from, to }).filter(e => !(e.attachments || []).length && U.sumBy(e.lines, l => l.debit) >= (settings.document_required_above || 5000000));
  if (missingDocs.length) put('missing_documents', 'warning', `${missingDocs.length} ta operatsiyaga hujjat biriktirilmagan (${U.fmtMoney(U.sumBy(missingDocs, e => U.sumBy(e.lines, l => l.debit)))}).`, [{ label: 'Operatsiyalar', value: String(missingDocs.length) }], [{ label: 'Hujjatlarni ko‘rish', link: { page: 'documents', params: {} } }]);
  else put('missing_documents', 'ok', 'Barcha yirik operatsiyalarda hujjat mavjud yoki bunday operatsiya yo‘q.');

  // 7. Dublikatlar
  const radar = require('./radar').scanCached(companyId, { from: U.periodStart(U.addMonths(period, -2)), to });
  const dupes = radar.issues.filter(i => i.category === 'duplicates');
  if (dupes.length) put('duplicates', 'failed', `${dupes.length} ta dublikat shubhasi aniqlandi (${U.fmtMoney(U.sumBy(dupes, d => d.impact))}).`, dupes.slice(0, 5).map(d => ({ label: d.title, value: U.fmtMoney(d.impact), hint: d.what })), [{ label: 'Xato Radarni ochish', link: { page: 'radar', params: { category: 'duplicates' } } }]);
  else put('duplicates', 'ok', 'Dublikat operatsiyalar aniqlanmadi.');

  // 8. Anomaliyalar
  const anomalies = radar.issues.filter(i => i.category === 'anomalies');
  if (anomalies.length) put('unusual_transactions', 'warning', `${anomalies.length} ta odatiy bo‘lmagan operatsiya ko‘rib chiqilishi kerak.`, anomalies.slice(0, 5).map(a => ({ label: a.title, value: U.fmtMoney(a.impact), hint: a.what })), [{ label: 'Topilmalarni ko‘rish', link: { page: 'radar', params: { category: 'anomalies' } } }]);
  else put('unusual_transactions', 'ok', 'Odatiy bo‘lmagan operatsiyalar aniqlanmadi.');

  // 9. Soliq
  const taxSummary = require('./tax').summary(companyId, { from, to });
  const taxIssues = radar.issues.filter(i => i.category === 'tax');
  if (taxIssues.length) put('tax_review', 'warning', taxIssues.map(i => i.what).join(' '), taxIssues.flatMap(i => i.evidence).slice(0, 5), [{ label: 'Soliq markazi', link: { page: 'tax', params: {} } }]);
  else put('tax_review', 'ok', `QQS va soliq ko‘rsatkichlari tekshirildi. Sof QQS: ${U.fmtMoney(taxSummary.net_vat)}.`, [{ label: 'Sof QQS', value: U.fmtMoney(taxSummary.net_vat) }], [{ label: 'Soliq markazi', link: { page: 'tax', params: {} } }]);

  // 10. P&L
  const pnl = ledger.periodSummary(companyId, { from, to });
  put('pnl_review', pnl.entryCount ? 'ok' : 'warning',
    pnl.entryCount ? `Daromad ${U.fmtMoney(pnl.revenue)}, xarajat ${U.fmtMoney(pnl.totalExpense)}, sof natija ${U.fmtMoney(pnl.netProfit)} (${pnl.entryCount} yozuv).` : 'Davr uchun yozuvlar yo‘q — hisobot bo‘sh.',
    [{ label: 'Daromad', value: U.fmtMoney(pnl.revenue) }, { label: 'Sof foyda', value: U.fmtMoney(pnl.netProfit) }],
    [{ label: 'P&L hisobotini ochish', link: { page: 'reports', params: { report: 'pnl', from, to } } }]);

  // 11. Balans
  const bs = ledger.balanceSheet(companyId, to);
  if (!bs.balanced) put('balance_review', 'failed', `Balans tenglamasi buzilgan: farq ${U.fmtMoney(bs.difference)}.`, [{ label: 'Aktivlar', value: U.fmtMoney(bs.totalAssets) }, { label: 'Majburiyat + Kapital', value: U.fmtMoney(bs.totalLiabilities + bs.totalEquity) }], [{ label: 'Balansni ko‘rish', link: { page: 'reports', params: { report: 'balance_sheet', asOf: to } } }]);
  else put('balance_review', 'ok', `Aktivlar ${U.fmtMoney(bs.totalAssets)} = Majburiyat + Kapital.`, [{ label: 'Aktivlar', value: U.fmtMoney(bs.totalAssets) }], [{ label: 'Balansni ko‘rish', link: { page: 'reports', params: { report: 'balance_sheet', asOf: to } } }]);

  // 12. Xato Radar
  const critical = radar.issues.filter(i => i.severity === 'critical');
  const high = radar.issues.filter(i => i.severity === 'high');
  if (critical.length) put('radar_check', 'failed', `${critical.length} ta kritik topilma mavjud: ${critical.map(c => c.title).join(', ')}.`, critical.flatMap(c => c.evidence).slice(0, 5), [{ label: 'Xato Radarni ochish', link: { page: 'radar', params: { severity: 'critical' } } }]);
  else if (high.length) put('radar_check', 'warning', `${high.length} ta yuqori jiddiylikdagi topilma ko‘rib chiqilishi kerak.`, high.slice(0, 5).map(h => ({ label: h.title, value: U.fmtMoney(h.impact), hint: h.what })), [{ label: 'Topilmalarni ko‘rish', link: { page: 'radar', params: { severity: 'high' } } }]);
  else put('radar_check', 'ok', 'Kritik yoki yuqori jiddiylikdagi muammolar yo‘q.');

  const summary = {
    total: items.length,
    ok: items.filter(i => i.status === 'ok').length,
    warning: items.filter(i => i.status === 'warning').length,
    failed: items.filter(i => i.status === 'failed').length,
    critical_failed: items.filter(i => i.status === 'failed' && i.critical).length,
    progress: Math.round((items.filter(i => i.status === 'ok').length / items.length) * 100),
    can_close: items.filter(i => i.status === 'failed' && i.critical).length === 0,
  };
  const today = U.today();
  return {
    period, period_label: U.periodLabel(period), range: { from, to },
    status: close ? close.status : 'open',
    close: close || null,
    items, summary,
    should_close: today > to,
    radar: { total: radar.issues.length, critical: critical.length, high: high.length },
    pnl: { revenue: pnl.revenue, expense: pnl.totalExpense, netProfit: pnl.netProfit, entryCount: pnl.entryCount },
  };
}

function closePeriod(companyId, period, user, { override = false, override_reason = '', note = '' } = {}, meta = {}) {
  const check = checklist(companyId, period);
  if (check.status === 'closed') throw new ApiError(`${U.periodLabel(period)} davri allaqachon yopilgan.`, 409, 'already_closed');
  if (!check.summary.can_close && !override) {
    const blockers = check.items.filter(i => i.status === 'failed' && i.critical);
    throw new ApiError(
      `Davrni yopish mumkin emas: ${blockers.length} ta kritik tekshiruv bajarilmadi (${blockers.map(b => b.title).join(', ')}). Muammolarni tuzating yoki vakolatli foydalanuvchi sabab ko‘rsatib majburiy yopishi mumkin.`,
      409, 'close_blocked', blockers.map(b => ({ key: b.key, title: b.title, detail: b.detail }))
    );
  }
  if (!check.summary.can_close && override) {
    const role = require('./auth').roleInCompany(user, companyId) || user.role;
    if (!user.is_platform_admin && !['director', 'superadmin'].includes(role)) {
      throw new ApiError('Majburiy yopish faqat direktor yoki SuperAdmin tomonidan amalga oshiriladi.', 403, 'forbidden_override');
    }
    if (!U.str(override_reason || '', { max: 500 })) throw new ApiError('Majburiy yopish uchun sabab ko‘rsatilishi shart.', 400, 'reason_required');
  }
  const col = store.collection('closes');
  let close = col.find(c => c.company_id === companyId && c.period === period);
  if (!close) {
    close = { id: store.uid('cls'), company_id: companyId, period, status: 'closed', created_at: store.nowISO() };
    col.push(close);
  }
  close.status = 'closed';
  close.closed_at = store.nowISO();
  close.closed_by = user ? user.id : null;
  close.closed_by_name = user ? user.name : null;
  close.note = U.str(note, { max: 1000 });
  close.summary = check.summary;
  close.checklist = check.items.map(i => ({ key: i.key, title: i.title, status: i.status, detail: i.detail, critical: i.critical }));
  close.override = !!override;
  close.override_reason = U.str(override_reason, { max: 500 });
  close.override_by = override ? (user ? user.id : null) : null;
  store.save();
  require('./audit').log({
    company_id: companyId, user, action: override ? 'period.close_override' : 'period.close',
    entity: 'period', entity_id: period,
    summary: `${U.periodLabel(period)} davri yopildi${override ? ` (MAJBURIY: ${override_reason})` : ''} — ${check.summary.ok}/${check.summary.total} tekshiruv bajarildi`,
    before: { status: 'open' }, after: { status: 'closed', ok: check.summary.ok, warning: check.summary.warning, failed: check.summary.failed }, meta,
  });
  return { close, checklist: check };
}

function reopenPeriod(companyId, period, user, reason, meta = {}) {
  const role = require('./auth').roleInCompany(user, companyId) || user.role;
  if (!user.is_platform_admin && !['director', 'superadmin'].includes(role)) {
    throw new ApiError('Davrni qayta ochish faqat direktor yoki SuperAdmin huquqida.', 403, 'forbidden');
  }
  const close = store.collection('closes').find(c => c.company_id === companyId && c.period === period);
  if (!close || close.status !== 'closed') throw new ApiError('Bu davr yopilmagan.', 409, 'not_closed');
  close.status = 'reopened';
  close.reopened_at = store.nowISO();
  close.reopened_by = user ? user.id : null;
  close.reopen_reason = U.str(reason || '', { max: 500 });
  store.save();
  require('./audit').log({
    company_id: companyId, user, action: 'period.reopen', entity: 'period', entity_id: period,
    summary: `${U.periodLabel(period)} davri qayta ochildi${reason ? `: ${reason}` : ''}`,
    before: { status: 'closed' }, after: { status: 'reopened' }, meta,
  });
  return close;
}

function listCloses(companyId) {
  const closed = store.collection('closes').filter(c => c.company_id === companyId && c.status === 'closed');
  const periods = U.lastNPeriods(12);
  return periods.map(p => {
    const c = closed.find(x => x.period === p);
    return {
      period: p, label: U.periodLabel(p), status: c ? 'closed' : (p === U.currentPeriod() ? 'open' : (p < U.currentPeriod() ? 'not_closed' : 'future')),
      closed_at: c ? c.closed_at : null, closed_by_name: c ? c.closed_by_name : null,
      ok: c ? c.summary.ok : null, warning: c ? c.summary.warning : null, failed: c ? c.summary.failed : null,
      override: c ? !!c.override : false,
    };
  });
}

module.exports = { ITEMS, checklist, closePeriod, reopenPeriod, listCloses };
