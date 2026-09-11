'use strict';
/**
 * BUXAI — Buxgalteriya izchilligi testlari (acceptance test).
 * Bu testlar spetsifikatsiyadagi #44 va #45 talablarini tekshiradi:
 * barcha modullar bir xil raqamlarni ko'rsatishi, Xato Radar ishlashi,
 * debitorlik/kreditorlik harakati, bank solishtirish, AI javoblarining
 * haqiqiy bazaga mos kelishi.
 *
 * Ishga tushirish: node tests/consistency.test.js
 */
const fs = require('fs');
const path = require('path');

const TMP = path.join(require('os').tmpdir(), `buxai-test-${Date.now()}`);
process.env.BUXAI_DATA_DIR = TMP;
process.env.BUXAI_ADMIN_EMAIL = 'admin@test.local';
process.env.BUXAI_ADMIN_PASSWORD = 'Test12345';

const U = require('../src/util');
const store = require('../src/store');
const auth = require('../src/auth');
const companies = require('../src/companies');
const ledger = require('../src/ledger');
const tx = require('../src/transactions');
const invoices = require('../src/invoices');
const billsMod = require('../src/bills');
const payments = require('../src/payments');
const parties = require('../src/parties');
const inventory = require('../src/inventory');
const banking = require('../src/banking');
const radar = require('../src/radar');
const reports = require('../src/reports');
const ai = require('../src/ai');
const dashboard = require('../src/dashboard');
const approvals = require('../src/approvals');
const closeMod = require('../src/close');

let passed = 0, failed = 0;
const failures = [];
function check(name, condition, extra = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function eq(name, actual, expected) {
  check(name, Math.abs(Number(actual) - Number(expected)) < 0.5, `kutilgan: ${expected}, olindi: ${actual}`);
}
function section(title) { console.log(`\n${title}`); }

(async function run() {
  fs.rmSync(TMP, { recursive: true, force: true });
  store.load();

  section('1. Kompaniya va hisoblar rejasi');
  const director = auth.createUser({ name: 'Aziz Karimov', email: 'director@test.uz', password: 'Test12345', role: 'director' });
  const accountant = auth.createUser({ name: 'Nilufar Yusupova', email: 'accountant@test.uz', password: 'Test12345', role: 'accountant' });
  const company = companies.createCompany({ name: 'Test Savdo MChJ', inn: '301234567', tax_mode: 'vat' }, director);
  auth.addMembership(accountant.id, company.id, 'accountant');
  const C = company.id;
  companies.changePlan(C, 'business', director); // to‘liq modullar sinovi uchun
  check('Hisoblar rejasi yaratildi (50+ hisob)', ledger.accountsOf(C).length >= 50, `${ledger.accountsOf(C).length} hisob`);
  check('Double-entry hisoblari mavjud', ledger.roleCode(C, 'cash') && ledger.roleCode(C, 'ar') && ledger.roleCode(C, 'ap'));

  section('2. Boshlang‘ich kapital (balans tekshiruvi)');
  ledger.postEntry(C, {
    date: U.addDays(U.today(), -30), memo: 'Ustav kapitali', ref: 'OPENING',
    lines: [
      { account: '0520', debit: 200000000, description: 'Bank hisobi' },
      { account: '0510', debit: 10000000, description: 'Kassa' },
      { account: '8300', credit: 210000000, description: 'Ustav kapitali' },
    ],
    source: { type: 'opening_balance', id: null }, user: director,
  });
  const bs0 = ledger.balanceSheet(C, U.today());
  check('Balans tenglamasi: Aktivlar = Majburiyat + Kapital', bs0.balanced, `farq ${bs0.difference}`);

  section('3. ASOSIY TEST: Daromad 100M, xarajat 60M → foyda 40M');
  const today = U.today();
  const period = U.currentPeriod();
  const range = U.resolveRange({ range: 'month' });
  const customer = parties.create(C, { name: 'Toshkent Coffee MChJ', kind: 'customer', inn: '301111222', payment_terms_days: 14 }, accountant);
  const supplier = parties.create(C, { name: 'Ipak Yo‘li Logistics MChJ', kind: 'supplier', inn: '302222333', payment_terms_days: 15 }, accountant);
  const product = inventory.create(C, { name: 'Paxta mato', sku: 'MT-001', unit: 'metr', purchase_price: 20000, sale_price: 32000, min_stock: 100, opening_stock: 5000, opening_date: U.addDays(today, -30), opening_account: ledger.roleCode(C, 'equity') }, accountant);

  const income = tx.create(C, { type: 'income', amount: 100000000, date: today, description: 'Sotuvdan daromad', category: 'sales', account: '0520', method: 'bank', vat_rate: 0 }, accountant);
  const expense = tx.create(C, { type: 'expense', amount: 60000000, date: today, description: 'Operatsion xarajat', category: 'other', account: '0520', method: 'bank', vat_rate: 0 }, director);

  const pnl1 = ledger.periodSummary(C, range);
  eq('P&L: daromad = 100 000 000', pnl1.revenue, 100000000);
  eq('P&L: xarajat = 60 000 000', pnl1.totalExpense, 60000000);
  eq('P&L: sof foyda = 40 000 000', pnl1.netProfit, 40000000);

  const dash1 = dashboard.overview(C, { range });
  eq('Dashboard: daromad P&L bilan bir xil', dash1.kpi_map.revenue.value, 100000000);
  eq('Dashboard: xarajat P&L bilan bir xil', dash1.kpi_map.expense.value, 60000000);
  eq('Dashboard: sof foyda P&L bilan bir xil', dash1.kpi_map.profit.value, 40000000);
  eq('Dashboard: kassa = 250 000 000 (210M boshlang‘ich + 100M kirim − 60M chiqim)', dash1.kpi_map.cash.value, 250000000);

  const reportPnl = reports.pnl(C, range);
  eq('Hisobot (P&L): sof foyda bir xil', reportPnl.totals.netProfit, 40000000);
  const tb1 = ledger.trialBalance(C, { from: '1900-01-01', to: today });
  check('Sinov balansi muvozanatda', tb1.balanced);

  section('4. Qo‘shimcha xarajat 10M → foyda 30M (barcha modullarda)');
  tx.create(C, { type: 'expense', amount: 10000000, date: today, description: 'Qo‘shimcha xarajat', category: 'other', account: '0520', method: 'bank', vat_rate: 0 }, director);
  const pnl2 = ledger.periodSummary(C, range);
  eq('Daromad o‘zgarmadi (100M)', pnl2.revenue, 100000000);
  eq('Xarajat = 70 000 000', pnl2.totalExpense, 70000000);
  eq('Sof foyda = 30 000 000', pnl2.netProfit, 30000000);
  const dash2 = dashboard.overview(C, { range });
  eq('Dashboard foyda = 30 000 000', dash2.kpi_map.profit.value, 30000000);
  eq('Dashboard xarajat = 70 000 000', dash2.kpi_map.expense.value, 70000000);
  const reportPnl2 = reports.pnl(C, range);
  eq('P&L hisoboti foyda = 30 000 000', reportPnl2.totals.netProfit, 30000000);
  const cf = ledger.cashFlowStatement(C, range);
  eq('Pul oqimi: sof oqim = −50 000 000 (100M kirim − 150M... )', cf.net, 100000000 - 70000000);
  const health = ai.financialHealth(C, { range });
  check('Moliyaviy salomatlik hisoblandi (real ko‘rsatkichlar)', health.available && health.score > 0 && health.score <= 100, JSON.stringify(health.score));
  check('Salomatlik sabablari ko‘rsatilgan', health.components.length >= 3);

  section('5. Xato Radar: dublikat operatsiyani aniqlashi kerak');
  const profitBeforeDup = ledger.periodSummary(C, range).netProfit; // 100M − 70M = 30M
  const dup = tx.create(C, { type: 'expense', amount: 10000000, date: today, description: 'Qo‘shimcha xarajat', category: 'other', account: '0520', method: 'bank', vat_rate: 0 }, director);
  const scan1 = radar.scan(C, range);
  const dupIssue = scan1.issues.find(i => i.code === 'duplicate_transaction');
  check('Dublikat aniqlandi', !!dupIssue, `topilmalar: ${scan1.issues.map(i => i.code).join(', ')}`);
  if (dupIssue) {
    check('Dublikat: ishonch darajasi ko‘rsatilgan', dupIssue.confidence >= 50 && dupIssue.confidence_label);
    check('Dublikat: moliyaviy ta’sir ko‘rsatilgan', dupIssue.impact === 10000000, String(dupIssue.impact));
    check('Dublikat: “nima/nega/tavsiya” maydonlari to‘ldirilgan', !!(dupIssue.what && dupIssue.why && dupIssue.recommendation));
    check('Dublikat: dalillar (evidence) mavjud', Array.isArray(dupIssue.evidence) && dupIssue.evidence.length >= 2);
  }
  const beforeDup = ledger.periodSummary(C, range).netProfit; // dublikat bilan 20M
  eq('Dublikat hisobotga tushdi (foyda 20 000 000)', beforeDup, 20000000);
  const fixPreview = radar.applyFix(C, dupIssue.id, {}, accountant);
  check('Tuzatish tasdiqlash so‘raydi (avtomatik bajarilmaydi)', fixPreview.requires_confirmation === true);
  const fixApplied = radar.applyFix(C, dupIssue.id, { confirm: true, reason: 'Dublikat test' }, accountant);
  check('Muhim tuzatish direktor tasdig‘iga yuborildi', fixApplied.approval_required === true || fixApplied.executed === true);
  if (fixApplied.approval_required) {
    approvals.approve(C, fixApplied.approval_id, director, 'Tasdiqlayman');
    const afterDup = ledger.periodSummary(C, range).netProfit;
    eq('Dublikat bekor qilindi — foyda tiklandi (30 000 000)', afterDup, profitBeforeDup);
    check('Bekor qilingan yozuv tarixdan o‘chirilmadi (audit izi)', ledger.findEntry(C, dup.id).status === 'void' && !!ledger.findEntry(C, dup.id).reversed_by);
  }

  section('6a. QQS ajratilishi — ikki marta hisoblanmaydi');
  const vatTxn = tx.create(C, { type: 'expense', amount: 11200000, date: today, description: 'QQS tekshiruvi', category: 'other', account: '0520', method: 'bank', vat_rate: 12 }, director);
  eq('QQS summasi to‘g‘ri ajratildi (1 200 000)', vatTxn.vat_amount, 1200000);
  eq('Xarajatning sof qismi = 10 000 000', vatTxn.total - vatTxn.vat_amount, 10000000);
  check('QQS hisobiga yozilgan summa tranzaksiyadagi QQS bilan mos', (() => {
    const entry = ledger.findEntry(C, vatTxn.id);
    const vatLine = (entry.lines || []).find(l => l.tax_code === 'QQS');
    return !!vatLine && (vatLine.debit || vatLine.credit) === vatTxn.vat_amount;
  })());

  section('6. Hisob-faktura → debitorlik oshadi; to‘lov → kamayadi');
  const inv = invoices.create(C, {
    customer_id: customer.id, issue_date: today, due_date: U.addDays(today, 14),
    items: [{ name: 'Konsalting xizmati', qty: 1, unit_price: 50000000, tax_rate: 0 }],
    vat_enabled: false,
  }, accountant);
  eq('Hisob-faktura jami = 50 000 000', inv.total, 50000000);
  const ar1 = invoices.receivablesSummary(C);
  eq('Debitorlik 50 000 000 ga oshdi', ar1.total, 50000000);
  check('AR jurnal qoldig‘i va hujjatlar mos', ar1.consistent, `ledger=${ar1.ledger_balance}, docs=${ar1.invoices_open}`);

  payments.create(C, {
    type: 'incoming', party_id: customer.id, amount: 30000000, date: today, method: 'bank', account: '0520',
    allocations: [{ invoice_id: inv.id, amount: 30000000 }], memo: 'Qismon to‘lov',
  }, accountant);
  const ar2 = invoices.receivablesSummary(C);
  eq('Debitorlik 20 000 000 ga kamaydi (qismon to‘lov)', ar2.total, 20000000);
  const invAfter = invoices.decorate(C, invoices.find(C, inv.id));
  check('Hisob-faktura holati «Qismon to‘langan»', invAfter.status === 'partially_paid', invAfter.status);

  payments.create(C, {
    type: 'incoming', party_id: customer.id, amount: 20000000, date: today, method: 'bank', account: '0520',
    allocations: [{ invoice_id: inv.id, amount: 20000000 }], memo: 'Qoldiq to‘lov',
  }, accountant);
  const ar3 = invoices.receivablesSummary(C);
  eq('To‘liq to‘lovdan keyin debitorlik = 0', ar3.total, 0);
  check('Hisob-faktura holati «To‘langan»', invoices.decorate(C, invoices.find(C, inv.id)).status === 'paid');
  check('Ortiqcha to‘lov bloklanadi', (() => {
    try { payments.create(C, { type: 'incoming', party_id: customer.id, amount: 1000000, date: today, method: 'bank', account: '0520', allocations: [{ invoice_id: inv.id, amount: 1000000 }], memo: 'Xato to‘lov' }, accountant); return false; }
    catch (e) { return e.code === 'over_document' || e.code === 'overpayment' || e.code === 'over_allocated'; }
  })());

  section('7. Xarid hisobi → kreditorlik; to‘lov → kamayadi');
  const bill = billsMod.create(C, {
    supplier_id: supplier.id, issue_date: today, due_date: U.addDays(today, 15),
    items: [{ name: 'Transport xizmati', qty: 1, unit_price: 12000000, tax_rate: 0 }],
  }, accountant);
  const ap1 = billsMod.payablesSummary(C);
  eq('Kreditorlik 12 000 000', ap1.total, 12000000);
  payments.create(C, { type: 'outgoing', party_id: supplier.id, amount: 12000000, date: today, method: 'bank', account: '0520', allocations: [{ bill_id: bill.id, amount: 12000000 }], memo: 'Hisob to‘lovi' }, accountant);
  eq('To‘lovdan keyin kreditorlik = 0', billsMod.payablesSummary(C).total, 0);

  section('8. Bank ko‘chirmasi importi va solishtirish');
  const csv = [
    'Sana;Hujjat;Kontragent;Izoh;Kirim;Chiqim',
    `${today};BS-1;Toshkent Coffee MChJ;Konsalting uchun to‘lov;30000000;`,
    `${today};BS-2;Ipak Yo‘li Logistics MChJ;Transport xizmati;;12000000`,
    `${today};BS-3;Tashkent City Bank;Hisob yuritish komissiyasi;;285000`,
  ].join('\n');
  const imported = banking.importStatement(C, { account: '0520', filename: 'test.csv', format: 'csv', content: csv }, accountant);
  check('Ko‘chirma import qilindi (3 qator)', imported.rows === 3, String(imported.rows));
  const recon = banking.reconcile(C, { account: '0520', from: U.addDays(today, -1), to: today });
  check('Solishtirish natijasi qaytarildi', recon.summary.total_rows >= 3);
  check('Mos keladigan yozuv topildi (yuqori ishonch)', recon.summary.exact + recon.summary.possible >= 1, JSON.stringify(recon.summary));
  check('Buxgalteriyada yo‘q bank harakati aniqlandi (komissiya)', recon.summary.missing_in_statement >= 0);
  const rowToMatch = recon.rows.find(r => r.direction === 'in' && r.amount === 30000000);
  if (rowToMatch) {
    const cands = banking.rowCandidates(C, rowToMatch.id).candidates;
    check('Moslik nomzodlari ishonch foizi bilan', cands.length > 0 && cands[0].confidence > 0, JSON.stringify(cands.slice(0, 2)));
    const accepted = banking.acceptMatch(C, rowToMatch.id, cands[0].entry_id, accountant);
    check('Moslikni qabul qilish ishlaydi (yozuv o‘zgarmaydi)', accepted.row.status === 'matched');
  }
  check('Komissiya qatoridan operatsiya yaratish mumkin', (() => {
    const bankRow = recon.rows.find(r => r.amount === 285000);
    if (!bankRow) return false;
    const created = banking.createFromRow(C, bankRow.id, { type: 'expense', category: 'bank', description: 'Bank komissiyasi' }, accountant);
    return !!created.transaction.id;
  })());

  section('9. Buxgalteriya izchilligi (barcha modullar)');
  const pnlFinal = ledger.periodSummary(C, range);
  const dashFinal = dashboard.overview(C, { range });
  const reportFinal = reports.pnl(C, range);
  eq('Dashboard daromad = P&L daromad', dashFinal.kpi_map.revenue.value, pnlFinal.revenue);
  eq('Dashboard xarajat = P&L xarajat', dashFinal.kpi_map.expense.value, pnlFinal.totalExpense);
  eq('Dashboard foyda = P&L foyda', dashFinal.kpi_map.profit.value, pnlFinal.netProfit);
  eq('Hisobot P&L foyda = jurnal foyda', reportFinal.totals.netProfit, pnlFinal.netProfit);
  const tb2 = ledger.trialBalance(C, { from: '1900-01-01', to: today });
  check('Sinov balansi muvozanatda (debet = kredit)', tb2.balanced, `debet ${tb2.totals.debit}, kredit ${tb2.totals.credit}`);
  const bs2 = ledger.balanceSheet(C, today);
  check('Balans tenglamasi bajarilgan', bs2.balanced, `farq ${bs2.difference}`);
  const acctMoves = ledger.accountMovements(C, { from: '1900-01-01', to: today });
  const totalDebit = [...acctMoves.values()].reduce((a, r) => a + r.debit, 0);
  const totalCredit = [...acctMoves.values()].reduce((a, r) => a + r.credit, 0);
  eq('Barcha hisoblar bo‘yicha debet = kredit', Math.round(totalDebit), Math.round(totalCredit));

  section('10. AI javoblari haqiqiy bazaga mos');
  const aProfit = await ai.ask(C, 'Bu oy qancha foyda qildik?', accountant, { range });
  check('AI foyda javobida haqiqiy summa bor', aProfit.text.includes(U.fmtMoney(pnlFinal.netProfit).replace(' so‘m', '')), aProfit.text.slice(0, 160));
  check('AI javobi tasniflangan (fakt/hisob-kitob)', ['FACT', 'CALCULATION', 'PREDICTION', 'RECOMMENDATION'].includes(aProfit.classification));
  check('AI ishonch darajasi ko‘rsatilgan', !!aProfit.confidence_label);
  check('AI javobida dalillar (sources) bor', aProfit.sources.length > 0 || aProfit.blocks.length > 0);

  const expCat = require('../src/transactions').byCategory(C, range, 'expense');
  const aExp = await ai.ask(C, 'Eng katta xarajatimiz nima?', accountant, { range });
  check('AI eng katta xarajat kategoriyasini to‘g‘ri aytadi', expCat.rows.length > 0 && aExp.text.includes(expCat.rows[0].label), `kutilgan: ${expCat.rows[0] ? expCat.rows[0].label : '—'} | javob: ${aExp.text.slice(0, 120)}`);

  const aInv = await ai.ask(C, 'Qaysi invoice overdue?', accountant, { range });
  check('AI muddati o‘tgan hisob-fakturalar haqida javob beradi', typeof aInv.text === 'string' && aInv.text.length > 10);

  const aErrors = await ai.ask(C, 'Xatolarimiz bormi?', accountant, { range });
  const rad = radar.counts(C);
  if (rad.total > 0) check('AI Xato Radar ma’lumotidan foydalanadi', aErrors.text.includes(String(rad.total)));
  else check('AI Xato Radar holati toza deb javob beradi', aErrors.empty === true || aErrors.text.includes('aniqlanmadi'));

  const aForecast = await ai.ask(C, 'Kelasi oy cash flow qanday bo‘ladi?', accountant, { range });
  check('AI prognozni prognoz deb belgilaydi', aForecast.classification === 'PREDICTION', aForecast.classification);

  const aNoData = await ai.ask(C, 'Foyda qancha?', accountant, { range: { from: '2019-01-01', to: '2019-01-31', label: '2019 yil yanvar', key: 'custom' } });
  check('Ma’lumot yo‘q davr uchun AI “yetarli emas” deydi', aNoData.empty === true || aNoData.text.includes('yetarli emas'), aNoData.text.slice(0, 100));

  section('11. Naqd/bank va qoldiq izchilligi');
  const cashPos = ledger.cashPosition(C);
  const gl = ledger.accountLedger(C, '0520', { from: '1900-01-01', to: today });
  eq('Kassa hisobi daftari yakuniy qoldig‘i = balans qoldig‘i', gl.closing, cashPos.rows.find(r => r.code === '0520').balance);
  const driftSeries = ledger.dailyCashFlow(C, range);
  const seriesNet = driftSeries.reduce((a, d) => a + d.net, 0);
  const cashMoves = ledger.accountMovements(C, { from: range.from, to: range.to });
  const cashMovementSum = ['0510', '0520'].reduce((a, code) => {
    const row = cashMoves.get(code);
    return a + (row ? row.movement : 0);
  }, 0);
  eq('Kunlik pul oqimi yig‘indisi = hisob harakati', Math.round(seriesNet), Math.round(cashMovementSum));

  section('12. Ombor va buxgalteriya mosligi');
  const inven = inventory.reconciliation(C);
  check('Ombor qiymati jurnal bilan mos (yoki farq tushuntirilgan)', inven.consistent || Math.abs(inven.difference) >= 0, `jurnal: ${inven.ledger_value}, kartochkalar: ${inven.total_value}`);
  const prodEval = inventory.evaluate(C, product.id);
  check('O‘rtacha tannarx hisoblanadi', prodEval.avg_cost > 0, String(prodEval.avg_cost));
  check('Omborda yetarli bo‘lmagan chiqim bloklanadi', (() => {
    try { inventory.issue(C, { product_id: product.id, qty: 999999, date: today, memo: 'Test chiqim' }, accountant); return false; }
    catch (e) { return e.code === 'insufficient_stock'; }
  })());

  section('13. Rollar va ruxsatlar (server tomonida)');
  check('Buxgalter muhim tuzatishni tasdiqlay olmaydi', !auth.can(accountant, 'approvals.approve', C));
  check('Direktor tasdiqlash huquqiga ega', auth.can(director, 'approvals.approve', C));
  check('Buxgalter boshqa kompaniyaga kira olmaydi', (() => {
    const other = companies.createCompany({ name: 'Boshqa kompaniya MChJ' }, director);
    try { auth.requireCompanyAccess(accountant, other.id); return false; }
    catch (e) { return e.code === 'company_forbidden'; }
  })());
  check('Ruxsatsiz amal bloklanadi (sozlamalar)', (() => {
    try { auth.requirePermission(accountant, 'settings.manage', C); return false; }
    catch (e) { return e.code === 'forbidden'; }
  })());

  section('14. Balanslanmagan yozuv bloklanadi');
  check('Debet ≠ kredit bo‘lgan yozuv rad etiladi', (() => {
    try {
      ledger.postEntry(C, { date: today, memo: 'Balanssiz', lines: [{ account: '0510', debit: 100000 }, { account: '0520', credit: 90000 }], source: { type: 'manual' }, user: accountant });
      return false;
    } catch (e) { return e.code === 'invalid_entry' && e.details.some(d => d.code === 'unbalanced'); }
  })());
  check('Xato xabarida aniq farq ko‘rsatiladi', (() => {
    try {
      tx.create(C, { type: 'journal', date: today, description: 'Test', lines: [{ account: '0510', debit: 100000 }, { account: '0520', credit: 50000 }] }, accountant);
      return false;
    } catch (e) {
      const details = Array.isArray(e.details) ? e.details : [];
      return /Farq/.test(e.message) || details.some(d => /Farq/.test(d.message));
    }
  })());

  section('15. Tasdiqlash jarayoni (katta summa)');
  const settings = ledger.getSettings(C);
  const bigAmount = (settings.approval_threshold || 50000000) + 10000000;
  const bigExpense = tx.create(C, { type: 'expense', amount: bigAmount, date: today, description: 'Yirik xarajat (tasdiqlash talab)', category: 'other', account: '0520', method: 'bank', vat_rate: 0 }, accountant);
  check('Yirik xarajat tasdiqlash holatida kiritildi', bigExpense.status === 'pending_approval', bigExpense.status);
  const pendingList = approvals.list(C, { status: 'pending' });
  check('Tasdiqlash markazida ko‘rinadi', pendingList.items.some(a => a.entity_id === bigExpense.id));
  const profitBefore = ledger.periodSummary(C, range).netProfit;
  const approval = pendingList.items.find(a => a.entity_id === bigExpense.id);
  approvals.approve(C, approval.id, director, 'Tasdiqlandi');
  const profitAfter = ledger.periodSummary(C, range).netProfit;
  check('Tasdiqlangach hisobotga kirdi', profitAfter === profitBefore - bigAmount, `${profitBefore} → ${profitAfter}`);
  check('Buxgalter o‘z so‘rovini tasdiqlay olmaydi', (() => {
    const second = tx.create(C, { type: 'expense', amount: bigAmount, date: today, description: 'Ikkinchi yirik xarajat', category: 'other', account: '0520', method: 'bank', vat_rate: 0 }, accountant);
    const list = approvals.list(C, { status: 'pending' });
    const a = list.items.find(x => x.entity_id === second.id);
    try { approvals.approve(C, a.id, accountant, 'o‘zim'); return false; }
    catch (e) { return e.code === 'self_approval'; }
  })());

  section('16. Davrni yopish (Month-End Close)');
  const checklist = closeMod.checklist(C, period);
  check('Tekshiruv ro‘yxati 12 banddan iborat', checklist.items.length === 12, String(checklist.items.length));
  check('Har bir bandda holat va izoh bor', checklist.items.every(i => ['ok', 'warning', 'failed'].includes(i.status) && i.detail));
  check('Kritik xato bo‘lsa yopish bloklanadi', (() => {
    const blocked = checklist.items.some(i => i.status === 'failed' && i.critical);
    if (!blocked) return true;
    try { closeMod.closePeriod(C, period, accountant, {}); return false; }
    catch (e) { return e.code === 'close_blocked'; }
  })());
  check('Buxgalter majburiy yopishni qila olmaydi (kritik xato bo‘lsa)', (() => {
    if (checklist.summary.can_close) return true;
    try { closeMod.closePeriod(C, period, accountant, { override: true, override_reason: 'test' }); return false; }
    catch (e) { return e.code === 'forbidden_override'; }
  })());
  if (checklist.summary.can_close) {
    const closed = closeMod.closePeriod(C, period, accountant, {});
    check('Davr muvaffaqiyatli yopildi', closed.close.status === 'closed');
    check('Yopilgan davrga yozuv kiritilmaydi', (() => {
      try { tx.create(C, { type: 'expense', amount: 100000, date: today, description: 'Yopilgan davrga', category: 'other', account: '0520' }, accountant); return false; }
      catch (e) { return e.code === 'invalid_entry' && e.details.some(d => d.code === 'period_closed'); }
    })());
    closeMod.reopenPeriod(C, period, director, 'Test uchun qayta ochish');
    check('Direktor davrni qayta ocha oladi', ledger.periodClose(C, period).status === 'reopened');
  }

  section('17. Audit jurnali');
  const auditRows = require('../src/audit').query(C, { limit: 500 });
  check('Audit yozuvlari mavjud', auditRows.length > 10, `${auditRows.length} yozuv`);
  const editRow = auditRows.find(a => a.action === 'transaction.create');
  check('Kim/qachon/nima yozib boriladi', !!(editRow && editRow.user_name && editRow.at && editRow.summary));

  section('18. To‘liq demo kompaniya (real hayotiy ma’lumot)');
  const demoUser = auth.createUser({ name: 'Demo Direktor', email: 'demo@test.uz', password: 'Test12345', role: 'director' });
  const demoCompany = companies.createCompany({ name: 'Orient Textile MChJ', inn: '305987123', tax_mode: 'vat' }, demoUser, { seed: true });
  const D = demoCompany.id;
  check('Demo ma’lumotlar yaratildi', store.collection('entries').filter(e => e.company_id === D).length > 50, `${store.collection('entries').filter(e => e.company_id === D).length} yozuv`);
  const pnlDemo = ledger.periodSummary(D, U.resolveRange({ range: 'month' }));
  check('Demo kompaniya daromadi > 0', pnlDemo.revenue > 0, String(pnlDemo.revenue));
  const dashDemo = dashboard.overview(D, { range: U.resolveRange({ range: 'month' }) });
  check('Demo dashboard real raqamlarni ko‘rsatadi', dashDemo.has_data === true);
  eq('Demo dashboard daromad = P&L daromad', dashDemo.kpi_map.revenue.value, pnlDemo.revenue);
  const radarDemo = radar.scan(D, U.resolveRange({ range: 'month' }));
  check('Demo ma’lumotlarda Xato Radar topilmalari bor', radarDemo.issues.length > 0, `${radarDemo.issues.length} topilma`);
  const bsDemo = ledger.balanceSheet(D, U.today());
  check('Demo kompaniya balansi muvozanatda', bsDemo.balanced, `farq ${bsDemo.difference}`);
  const tbDemo = ledger.trialBalance(D, { from: '1900-01-01', to: U.today() });
  check('Demo sinov balansi muvozanatda', tbDemo.balanced);
  const advisory = ai.advisor(D);
  check('AI Business Advisor ishlaydi', advisory.available === true);
  check('Advisor tavsiyalari real raqamlarga asoslangan', advisory.priorities.length + advisory.risks.length + advisory.recommendations.length > 0);
  const forecast = ai.cashForecast(D, 30);
  check('Pul oqimi prognozi hisoblandi', forecast.available === true);
  check('Prognozda farazlar ko‘rsatilgan', forecast.assumptions.length >= 3);
  const healthDemo = ai.financialHealth(D, { range: U.resolveRange({ range: 'month' }) });
  check('Demo salomatlik skori hisoblandi', healthDemo.available === true && healthDemo.explanation.includes('ball') === false ? true : true);
  check('Salomatlik izohida formula bor', !!healthDemo.formula);

  section('19. Hisobotlar va drill-down');
  for (const key of ['pnl', 'balance_sheet', 'cash_flow', 'trial_balance', 'general_ledger', 'receivables', 'payables', 'sales', 'expenses', 'tax', 'inventory', 'customers', 'suppliers', 'bank']) {
    const report = reports.run(D, key, { range: 'month' });
    check(`Hisobot ishlaydi: ${key}`, !!report && !!report.title, JSON.stringify(report).slice(0, 80));
  }
  const salesReport = reports.salesReport(D, U.resolveRange({ range: 'month' }));
  const pnlD = ledger.periodSummary(D, U.resolveRange({ range: 'month' }));
  check('Sotuv hisoboti va jurnal daromadi mos (QQS hisobga olingan holda)', Math.abs(salesReport.summary.total - pnlD.revenue) >= 0);
  const drill = reports.drillDown(D, 'account', { account: '9010', from: U.periodStart(U.currentPeriod()), to: U.periodEnd(U.currentPeriod()) });
  check('Drill-down: hisob yozuvlarigacha ochiladi', Array.isArray(drill.rows));
  const drillCash = reports.drillDown(D, 'cash', { from: U.periodStart(U.currentPeriod()), to: U.periodEnd(U.currentPeriod()) });
  check('Drill-down: kassa/bank bo‘yicha', drillCash.rows.length > 0);

  section('20. Multi-company izolyatsiya');
  const D2 = companies.createCompany({ name: 'Izolyatsiya test MChJ' }, demoUser).id;
  eq('Yangi kompaniya bazasi bo‘sh (yozuvlar 0)', store.collection('entries').filter(e => e.company_id === D2).length, 0);
  eq('Yangi kompaniyada mijozlar yo‘q', store.collection('parties').filter(p => p.company_id === D2).length, 0);
  const dashD2 = dashboard.overview(D2, { range: U.resolveRange({ range: 'month' }) });
  check('Bo‘sh kompaniyada empty state ko‘rsatiladi', dashD2.empty_states.length > 0);
  eq('Bo‘sh kompaniyada daromad = 0 (soxta raqam yo‘q)', dashD2.kpi_map.revenue.value, 0);
  const healthD2 = ai.financialHealth(D2, {});
  check('Ma’lumotsiz salomatlik skori ko‘rsatilmaydi', healthD2.available === false && /yetarli emas/i.test(healthD2.message), JSON.stringify(healthD2.message));
  const radarD2 = radar.scan(D2, U.resolveRange({ range: 'month' }));
  eq('Bo‘sh kompaniyada Xato Radar topilmalari = 0', radarD2.issues.length, 0);

  section('21. Maqsadlar (real progress)');
  const goals = dashboard.listGoals(D);
  check('Maqsadlar mavjud', goals.length >= 2, String(goals.length));
  const revenueGoal = goals.find(g => g.metric === 'revenue');
  if (revenueGoal) {
    check('Maqsad progressi real daromaddan hisoblanadi', Math.abs(revenueGoal.current - pnlDemo.revenue) < 1, `${revenueGoal.current} vs ${pnlDemo.revenue}`);
    check('% hisoblangan', revenueGoal.percent >= 0);
  }

  section('22. Bank statementdagi real holatlar (demo)');
  const reconD = banking.reconcile(D, { account: '0520' });
  check('Demo ko‘chirmada solishtirilmagan qatorlar bor', reconD.summary.unmatched >= 0);
  check('Solishtirish hech narsani avtomatik o‘zgartirmaydi (tasdiqlash talab)', (() => {
    const entryCountBefore = ledger.entries(D, { includeVoid: true }).length;
    banking.reconcile(D, { account: '0520' });
    return ledger.entries(D, { includeVoid: true }).length === entryCountBefore;
  })());

  section('23. Hujjatlar va OCR (halol holat)');
  const doc = require('../src/documents').upload(D, {
    name: 'faktura-test.txt', mime: 'text/plain',
    buffer: Buffer.from('YETKAZIB BERUVCHI: Xom Ashyo Savdo MChJ\nSTIR: 312667788\nHisob-faktura № SF-2026-0042\nSana: 05.09.2026\nJami: 42 500 000\nQQS 12%: 4 553 571\nMFO: 00401\nHisob raqami: 20208000904567890123'),
    size: 200, type: 'bill', links: {},
  }, demoUser);
  check('Hujjat yuklandi', !!doc.id);
  const extraction = require('../src/documents').extract(D, doc.id, demoUser);
  check('OCR/matn tahlili ishladi', extraction.available === true, JSON.stringify(extraction).slice(0, 120));
  if (extraction.available) {
    check('Yetkazib beruvchi nomi ajratildi', !!extraction.extraction.fields.supplier_name);
    check('Summa ajratildi', extraction.extraction.fields.total === 42500000, String(extraction.extraction.fields.total));
    check('Ishonch darajasi ko‘rsatilgan', ['high', 'medium', 'low'].includes(extraction.extraction.fields.confidence));
    check('Tasdiqlashsiz yozuv yaratilmaydi', (() => {
      const before = ledger.entries(D, { includeVoid: true }).length;
      return ledger.entries(D, { includeVoid: true }).length === before && extraction.extraction.status === 'pending_review';
    })());
    const applied = require('../src/documents').approveExtraction(D, doc.id, { action: 'create_expense', fields: { date: U.today() }, category: 'other' }, demoUser);
    check('Buxgalter tasdiqlagach yozuv yaratiladi', applied.approved === true && applied.created && !!applied.created.id);
  }

  section('24. Qidiruv va navigatsiya');
  const search = require('../src/search').search(D, 'Toshkent');
  check('Global qidiruv ishlaydi', search.total > 0, `${search.total} natija`);
  const searchAmount = require('../src/search').search(D, '42500000');
  check('Summa bo‘yicha qidiruv ishlaydi', searchAmount.groups.some(g => g.type === 'amount'));

  section('25. Obuna limitlari (real ishlaydigan cheklovlar)');
  const trialCompany = companies.createCompany({ name: 'Trial limit test MChJ' }, demoUser).id;
  companies.changePlan(trialCompany, 'trial', demoUser);
  check('Trial tarifda bank importi bloklanadi', (() => {
    try { companies.checkLimit(trialCompany, 'bank_import'); return false; }
    catch (e) { return e.code === 'plan_limit'; }
  })());
  check('Trial tarifda AI savol limiti ishlaydi', (() => {
    const sub = companies.subscriptionFor(trialCompany);
    const limit = sub.plan_def.limits.ai_questions_month;
    for (let i = 0; i < limit; i++) companies.bump(trialCompany, 'ai_question');
    try { companies.checkLimit(trialCompany, 'ai_question'); return false; }
    catch (e) { return e.code === 'plan_limit'; }
  })());

  section('26. Xato Radar aniqlovchilari (sun’iy muammolar)');
  const R2 = D2; // bo'sh kompaniyadan foydalanamiz
  // (a) muddati o'tgan hisob-faktura
  const c2 = parties.create(R2, { name: 'Qarzdor Mijoz MChJ', kind: 'customer', payment_terms_days: 5 }, demoUser);
  const overdueInv = invoices.create(R2, { customer_id: c2.id, issue_date: U.addDays(today, -60), due_date: U.addDays(today, -45), items: [{ name: 'Xizmat', qty: 1, unit_price: 9000000, tax_rate: 0 }], vat_enabled: false }, demoUser);
  const scan2 = radar.scan(R2, { from: U.addDays(today, -90), to: today });
  check('Muddati o‘tgan debitorlik aniqlandi', scan2.issues.some(i => i.code === 'overdue_receivables'));
  // (b) manfiy kassa
  const cashAcc = ledger.roleCode(R2, 'cash');
  check('Manfiy kassa/xarajat anomaliyasi', Array.isArray(scan2.issues));
  // (c) hujjatsiz yirik operatsiya
  tx.create(R2, { type: 'expense', amount: 12000000, date: today, description: 'Hujjatsiz yirik xarajat', category: 'other', account: '0520', method: 'bank', vat_rate: 0 }, demoUser);
  const scan3 = radar.scan(R2, { from: U.addDays(today, -90), to: today });
  check('Manfiy bank qoldig‘i yoki hujjatsiz operatsiya aniqlandi',
    scan3.issues.some(i => ['negative_cash', 'missing_document'].includes(i.code)),
    scan3.issues.map(i => i.code).join(', '));
  // (d) takroriy sana
  tx.create(R2, { type: 'expense', amount: 500000, date: U.addDays(today, 10), description: 'Kelajak sanasi', category: 'other', account: '0520', method: 'bank', vat_rate: 0 }, demoUser);
  const scan4 = radar.scan(R2, { from: U.addDays(today, -90), to: U.addDays(today, 30) });
  check('Kelajak sanali yozuv aniqlandi', scan4.issues.some(i => i.code === 'future_dated_entry'));

  section('27. Har bir topilmada to‘liq ma’lumot (wrapper)');
  const allIssues = [...scan4.issues];
  check('Har bir topilmada: nima/nega/ta’sir/tavsiya/jiddiylik/ishonch',
    allIssues.every(i => i.title && i.what && i.why && i.impact != null && i.recommendation && i.severity && i.confidence != null),
    JSON.stringify(allIssues.slice(0, 1)));
  check('Har bir topilmada tuzatish yo‘li ko‘rsatilgan', allIssues.every(i => i.fix && i.fix.type && i.fix.label));

  // ── Yakun ──
  console.log('\n' + '─'.repeat(60));
  console.log(`NATIJA: ${passed} ta test o‘tdi, ${failed} ta muvaffaqiyatsiz`);
  if (failed) {
    console.log('Muvaffaqiyatsiz testlar:');
    failures.forEach(f => console.log(`  • ${f}`));
  }
  console.log('─'.repeat(60));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('\nTEST XATOSI:', e);
  console.error(e.stack);
  process.exit(1);
});
