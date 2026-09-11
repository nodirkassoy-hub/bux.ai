'use strict';
/**
 * BUXAI — XATO RADAR.
 * Buxgalteriya ma'lumotlarini doimiy tekshiruvchi aniqlovchi tizim.
 * Har bir topilma uchun: NIMA XATO / NEGA XATO / MOLIYAVIY TA'SIR / QANDAY TUZATISH /
 * JIDDIYLIK / ISHONCH darajasi va dalillar (evidence) ko'rsatiladi.
 *
 * Barcha aniqlovchilar REAL ma'lumot ustida ishlaydi — hech qanday hardcode qilingan
 * topilma yo'q. Agar muammo bo'lmasa, ro'yxat bo'sh bo'ladi.
 */
const crypto = require('crypto');
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_LABELS = { critical: 'Kritik', high: 'Yuqori', medium: 'O‘rta', low: 'Past' };
const CONFIDENCE_LABEL = (c) => c >= 85 ? 'Yuqori ishonch' : c >= 60 ? 'O‘rtacha ishonch' : 'Past ishonch';

function key(...parts) {
  return crypto.createHash('sha1').update(parts.map(p => String(p == null ? '' : p)).join('|')).digest('hex').slice(0, 16);
}

// ────────────────────────────── Aniqlovchilar ───────────────────────────────

/** 1. Dublikat operatsiyalar */
/** Jurnal yozuvlari — teskari (reversal) yozuvlar chiqarib tashlanadi:
 *  ular asl yozuvni bekor qilish uchun yaratiladi va yangi xarajat/daromad hisoblanmaydi. */
function journal(companyId, { from, to }) {
  return ledger.entries(companyId, { from, to })
    .filter(e => !(e.source && (e.source.type === 'reversal' || e.reversal_of)));
}

function detectDuplicateTransactions(companyId, ctx) {
  const out = [];
  const entries = journal(companyId, ctx);
  const bySignature = new Map();
  for (const e of entries) {
    const money = e.lines.find(l => { const a = ledger.tryAccount(companyId, l.account); return a && (a.is_cash || a.is_bank); });
    const opp = e.lines.find(l => l !== money);
    if (!money || !opp) continue;
    const amount = U.round(U.sumBy(e.lines, l => l.debit), 0);
    const partyId = (e.txn && e.txn.party_id) || money.party_id || 'none';
    const sig = `${Math.round(amount)}|${(ledger.tryAccount(companyId, opp.account) || {}).code || opp.account}|${partyId}`;
    if (!bySignature.has(sig)) bySignature.set(sig, []);
    bySignature.get(sig).push({ entry: e, amount, account: opp.account, party_id: partyId });
  }
  for (const [sig, items] of bySignature) {
    if (items.length < 2) continue;
    const sorted = U.sortBy(items, i => i.entry.date);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1], b = sorted[i];
      const days = Math.abs(U.daysBetween(a.entry.date, b.entry.date));
      if (days > 3) continue;
      if (a.entry.txn?.type === 'transfer') continue;
      const descSim = Math.max(
        U.similarity(a.entry.memo, b.entry.memo),
        U.similarity((a.entry.lines[0] || {}).description || '', (b.entry.lines[0] || {}).description || '')
      );
      const partyName = a.party_id !== 'none' ? (store.collection('parties').find(p => p.id === a.party_id) || {}).name : null;
      // Ishonch: summa bir xil (60) + sana yaqinligi + izoh o'xshashligi
      let confidence = 60;
      if (days === 0) confidence += 20; else if (days <= 1) confidence += 14; else confidence += 6;
      confidence += Math.round(descSim * 18);
      if (a.entry.ref && a.entry.ref === b.entry.ref) confidence += 10;
      if (a.entry.source.type !== b.entry.source.type) confidence -= 15;
      if (a.entry.source.id && a.entry.source.id === b.entry.source.id) confidence += 25; // bir xil hujjatdan ikki marta
      confidence = U.clamp(confidence, 20, 99);
      if (confidence < 50) continue;
      const later = b.entry;
      out.push({
        code: 'duplicate_transaction',
        category: 'duplicates',
        severity: confidence >= 85 ? 'high' : 'medium',
        confidence,
        title: 'Ehtimoliy dublikat operatsiya',
        what: `«${later.memo}» — ${U.fmtMoney(a.amount)} summasi ${days === 0 ? 'bir kunda' : `${days} kun ichida`} ikki marta kiritilgan.`,
        why: `Ikki yozuvda bir xil summa (${U.fmtMoney(a.amount)}), ${partyName ? `bir xil kontragent (${partyName}) va ` : ''}bir xil hisob (${(ledger.tryAccount(companyId, a.account) || {}).code}) ishlatilgan. ${descSim > 0.5 ? 'Izohlar ham o‘xshash.' : ''}`.trim(),
        impact: a.amount,
        impact_note: 'Xarajat/daromad ikki marta hisoblangan bo‘lishi mumkin.',
        recommendation: 'Ikkala yozuvni ham tekshiring: asl hujjat qaysi biri ekanini aniqlang va ortiqchasini bekor qiling (teskari yozuv bilan).',
        fix: { type: 'reverse_entry', label: 'Ortiqchasini bekor qilish', entry_id: later.id, params: { entry_id: later.id } },
        evidence: [
          { label: '1-yozuv', value: `${a.entry.no} • ${a.entry.date}`, hint: U.fmtMoney(a.amount), link: { page: 'transactions', params: { id: a.entry.id } } },
          { label: '2-yozuv', value: `${b.entry.no} • ${b.entry.date}`, hint: U.fmtMoney(b.amount), link: { page: 'transactions', params: { id: b.entry.id } } },
          { label: 'Summa', value: U.fmtMoney(a.amount) },
          { label: 'Kontragent', value: partyName || '—' },
        ],
        entity: { type: 'entry', id: later.id, no: later.no, ids: [a.entry.id, b.entry.id] },
      });
    }
  }
  return out;
}

/** 2. Dublikat to'lovlar va bir xil hujjatga ikki marta to'lov */
function detectDuplicatePayments(companyId, ctx) {
  const out = [];
  const payments = store.collection('payments').filter(p => p.company_id === companyId && p.status !== 'cancelled' && p.date >= ctx.from && p.date <= ctx.to);
  const map = new Map();
  for (const p of payments) {
    const sig = `${p.party_id}|${Math.round(p.amount)}|${p.type}|${p.date}`;
    if (!map.has(sig)) map.set(sig, []);
    map.get(sig).push(p);
  }
  for (const [, items] of map) {
    if (items.length < 2) continue;
    const party = store.collection('parties').find(p => p.id === items[0].party_id);
    out.push({
      code: 'duplicate_payment', category: 'duplicates',
      severity: 'high', confidence: 94,
      title: 'Ehtimoliy dublikat to‘lov',
      what: `${party ? party.name : 'Kontragent'} uchun ${items[0].date} sanasida ${items.length} ta bir xil to‘lov (${U.fmtMoney(items[0].amount)}) qayd etilgan.`,
      why: 'Bir kunda, bir kontragentga, bir xil summa va yo‘nalishda bir nechta to‘lov kiritilgan.',
      impact: U.round(items[0].amount * (items.length - 1), 0),
      impact_note: 'Ortiqcha to‘lov kassa/bank qoldig‘ini kamaytirgan bo‘lishi mumkin.',
      recommendation: 'To‘lovlar bank ko‘chirmasi bilan solishtiring. Dublikat bo‘lsa — noto‘g‘ri to‘lovni bekor qiling (teskari yozuv bilan).',
      fix: { type: 'reverse_entry', label: 'Dublikat to‘lovni bekor qilish', entry_id: items[items.length - 1].entry_id, params: { entry_id: items[items.length - 1].entry_id } },
      evidence: items.map((p, i) => ({ label: `${i + 1}-to‘lov`, value: `${p.no} • ${p.date}`, hint: U.fmtMoney(p.amount), link: { page: 'payments', params: { id: p.id } } })),
      entity: { type: 'payment', id: items[0].id, no: items[0].no, ids: items.map(i => i.id) },
    });
  }
  return out;
}

/** 3. Hujjatsiz yirik operatsiyalar */
function detectMissingDocuments(companyId, ctx) {
  const out = [];
  const settings = ledger.getSettings(companyId);
  const threshold = settings.document_required_above || 5000000;
  for (const e of journal(companyId, ctx)) {
    if (!['manual', 'payment'].includes(e.source.type)) continue;
    const attachments = e.attachments || [];
    const total = U.round(U.sumBy(e.lines, l => l.debit), 0);
    if (total < threshold || attachments.length) continue;
    const isCashMove = e.lines.some(l => { const a = ledger.tryAccount(companyId, l.account); return a && (a.is_cash || a.is_bank); });
    if (!isCashMove) continue;
    out.push({
      code: 'missing_document', category: 'documents',
      severity: total >= threshold * 5 ? 'medium' : 'low', confidence: 92,
      title: 'Hujjat biriktirilmagan operatsiya',
      what: `${e.no} (${e.date}) — ${U.fmtMoney(total)} summasi uchun asos hujjat yo‘q.`,
      why: `Kompaniya sozlamalarida ${U.fmtMoney(threshold)} dan yuqori operatsiyalarga hujjat biriktirish talab qilinadi. Bu yozuvda biriktirma yo‘q.`,
      impact: total,
      impact_note: 'Soliq tekshiruvida xarajat asossiz deb topilishi mumkin.',
      recommendation: 'Shartnoma, faktura yoki kvitansiya faylini yuklab, operatsiyaga biriktiring.',
      fix: { type: 'attach_document', label: 'Hujjat biriktirish', entry_id: e.id, params: { entry_id: e.id } },
      evidence: [
        { label: 'Operatsiya', value: `${e.no} • ${e.date}`, hint: e.memo, link: { page: 'transactions', params: { id: e.id } } },
        { label: 'Summa', value: U.fmtMoney(total) },
        { label: 'Talab qilinadigan minimal', value: U.fmtMoney(threshold) },
      ],
      entity: { type: 'entry', id: e.id, no: e.no },
    });
  }
  return out;
}

/** 4. Odatiy bo'lmagan (anomaliya) summalar */
function detectUnusualAmounts(companyId, ctx) {
  const out = [];
  const entries = journal(companyId, ctx);
  const history = journal(companyId, { from: U.addMonths(U.periodOf(ctx.from), -12) + '-01', to: ctx.to });
  const settings = ledger.getSettings(companyId);
  const byAccount = new Map();
  for (const e of history) {
    if (e.date >= ctx.from) continue; // tarixiy baza
    for (const l of e.lines) {
      const a = ledger.tryAccount(companyId, l.account);
      if (!a || (a.type !== 'expense' && a.type !== 'income')) continue;
      if (!byAccount.has(l.account)) byAccount.set(l.account, []);
      byAccount.get(l.account).push(l.debit - l.credit);
    }
  }
  for (const e of entries) {
    const total = U.round(U.sumBy(e.lines, l => l.debit), 0);
    for (const l of e.lines) {
      const a = ledger.tryAccount(companyId, l.account);
      if (!a || a.type !== 'expense') continue;
      const hist = byAccount.get(l.account) || [];
      if (hist.length < 8) continue;
      const amounts = hist.map(Math.abs);
      const mean = U.mean(amounts), sd = U.stddev(amounts);
      if (sd <= 0) continue;
      const z = (Math.abs(l.debit - l.credit) - mean) / sd;
      if (z < 2.8) continue;
      const conf = U.clamp(Math.round(70 + Math.min(20, (z - 2.8) * 6)), 60, 95);
      out.push({
        code: 'unusual_amount', category: 'anomalies',
        severity: Math.abs(l.debit - l.credit) > mean * 5 ? 'high' : 'medium', confidence: conf,
        title: 'Odatiy bo‘lmagan summa',
        what: `«${a.name}» hisobi bo‘yicha ${U.fmtMoney(Math.abs(l.debit - l.credit))} — odatdagi ${U.fmtMoney(mean)} dan ancha yuqori (${U.round(z, 1)}σ).`,
        why: `Oxirgi ${hist.length} ta shu turdagi yozuvning o‘rtachasi ${U.fmtMoney(mean)}, standart chetlanish ${U.fmtMoney(sd)}. Bu yozuv statistik jihatdan keskin ajralib turadi.`,
        impact: Math.abs(l.debit - l.credit),
        impact_note: 'Xato tasniflash, takroriy yozuv yoki summani ortiqcha kiritish bo‘lishi mumkin.',
        recommendation: 'Yozuvni asos hujjat bilan solishtiring: summa, sana va hisob to‘g‘ri tanlanganini tekshiring.',
        fix: { type: 'review', label: 'Yozuvni tekshirish', entry_id: e.id, params: { entry_id: e.id } },
        evidence: [
          { label: 'Operatsiya', value: `${e.no} • ${e.date}`, hint: e.memo, link: { page: 'transactions', params: { id: e.id } } },
          { label: 'Bu yozuv summasi', value: U.fmtMoney(Math.abs(l.debit - l.credit)) },
          { label: 'Tarixiy o‘rtacha', value: U.fmtMoney(mean) },
          { label: 'Chetlanish', value: `${U.round(z, 1)} σ` },
        ],
        entity: { type: 'entry', id: e.id, no: e.no },
      });
      break;
    }
  }
  // Tasdiqlash chegarasidan past "bo'lib tashlash" belgilari
  const threshold = settings.approval_threshold;
  if (threshold && threshold > 0) {
    const near = entries.filter(e => {
      const total = U.sumBy(e.lines, l => l.debit);
      return total >= threshold * 0.9 && total < threshold;
    });
    if (near.length >= 3) {
      const total = U.sumBy(near, e => U.sumBy(e.lines, l => l.debit));
      out.push({
        code: 'approval_threshold_splitting', category: 'anomalies',
        severity: 'medium', confidence: 68,
        title: 'Tasdiqlash chegarasidan past bo‘lib kiritilgan operatsiyalar',
        what: `${near.length} ta operatsiya tasdiqlash chegarasi (${U.fmtMoney(threshold)}) dan atigi bir necha foiz past — jami ${U.fmtMoney(total)}.`,
        why: 'Yirik xarajatlar ataylab bo‘lib kiritilishi mumkin, bu ichki nazoratni chetlab o‘tadi.',
        impact: total,
        impact_note: 'Ichki nazorat zaiflashishi va tasdiqlanmagan xarajatlar xavfi.',
        recommendation: 'Bu operatsiyalar bir loyiha/shartnoma bilan bog‘liqligini tekshiring. Kerak bo‘lsa chegarani qayta ko‘rib chiqing.',
        fix: { type: 'review', label: 'Operatsiyalarni ko‘rish' },
        evidence: near.slice(0, 6).map(e => ({ label: e.no, value: U.fmtMoney(U.sumBy(e.lines, l => l.debit)), hint: `${e.date} • ${e.memo}`, link: { page: 'transactions', params: { id: e.id } } })),
        entity: { type: 'entries_group', id: 'threshold_splitting', ids: near.map(e => e.id) },
      });
    }
  }
  return out;
}

/** 5. Noto'g'ri tasniflash (kategoriya) */
function detectMiscategorization(companyId, ctx) {
  const out = [];
  const settings = ledger.getSettings(companyId);
  const misc = ledger.accountsOf(companyId).filter(a => ['9590', '9480'].includes(a.code)); // boshqa/ofis xarajatlari
  const moves = ledger.accountMovements(companyId, { from: ctx.from, to: ctx.to });
  const totalExpense = U.sumBy([...moves.values()].filter(r => r.account.type === 'expense'), r => r.debit - r.credit);
  for (const a of misc) {
    const row = moves.get(a.code);
    if (!row) continue;
    const amount = row.debit - row.credit;
    if (amount <= 0 || totalExpense <= 0) continue;
    const share = (amount / totalExpense) * 100;
    if (share < 25) continue;
    out.push({
      code: 'miscategorized_share', category: 'categorization',
      severity: share > 40 ? 'high' : 'medium', confidence: 80,
      title: '«Boshqa xarajatlar» ulushi haddan ziyod yuqori',
      what: `«${a.name}» hisobida ${U.fmtMoney(amount)} yig‘ilgan — bu jami xarajatning ${U.round(share, 1)}%.`,
      why: 'Buxgalteriya amaliyotida noaniq tasniflangan xarajatlar 25% dan oshsa, xarajatlar tahlili va soliq hisoboti buziladi.',
      impact: amount,
      impact_note: 'Xarajat strukturasi noto‘g‘ri ko‘rsatiladi, soliq bazasi xato hisoblanishi mumkin.',
      recommendation: 'Bu hisobdagi yozuvlarni ko‘rib chiqib, to‘g‘ri kategoriyalarga (ijara, marketing, logistika va h.k.) taqsimlang.',
      fix: { type: 'review_account', label: 'Hisob yozuvlarini ko‘rish', params: { account: a.code } },
      evidence: [
        { label: a.name, value: U.fmtMoney(amount), hint: `${U.round(share, 1)}% ulush` },
        { label: 'Jami xarajat', value: U.fmtMoney(totalExpense) },
        { label: 'Tavsiya etilgan maksimal ulush', value: '25%' },
      ],
      entity: { type: 'account', id: a.code, no: a.code },
    });
  }
  // Bir kontragent tarixan boshqa kategoriyaga yozilsa
  const entries = journal(companyId, { from: U.addMonths(U.periodOf(ctx.from), -6) + '-01', to: ctx.to });
  const partyCats = new Map();
  for (const e of entries) {
    const party = e.lines.find(l => l.party_id);
    const exp = e.lines.find(l => { const a = ledger.tryAccount(companyId, l.account); return a && a.type === 'expense'; });
    if (!party || !exp) continue;
    const k = party.party_id;
    if (!partyCats.has(k)) partyCats.set(k, new Map());
    const m = partyCats.get(k);
    const cur = m.get(exp.account) || { count: 0, last: null, amounts: [] };
    cur.count++; cur.last = e.date; cur.amounts.push(exp.debit - exp.credit);
    m.set(exp.account, cur);
  }
  for (const [partyId, cats] of partyCats) {
    if (cats.size < 2) continue;
    const ranked = [...cats.entries()].sort((a, b) => b[1].count - a[1].count);
    const main = ranked[0], other = ranked[1];
    if (main[1].count < 3 || other[1].count > main[1].count) continue;
    const lastEntry = U.sortBy(journal(companyId, ctx).filter(e => e.lines.some(l => l.party_id === partyId && l.account === other[0])), e => e.date, 'desc')[0];
    if (!lastEntry) continue;
    const party = store.collection('parties').find(p => p.id === partyId);
    const mainAcc = ledger.tryAccount(companyId, main[0]), otherAcc = ledger.tryAccount(companyId, other[0]);
    out.push({
      code: 'category_deviation', category: 'categorization',
      severity: 'low', confidence: 62,
      title: 'Kontragent bo‘yicha kategoriya o‘zgargan',
      what: `«${party ? party.name : '—'}» xarajatlari odatda «${mainAcc ? mainAcc.name : main[0]}» hisobida yuritilgan, lekin ${lastEntry.date} sanasida «${otherAcc ? otherAcc.name : other[0]}» hisobiga yozilgan.`,
      why: 'Bir kontragentning xarajatlari turli hisoblarga tushsa, xarajatlar tahlili va taqqoslash xato bo‘ladi.',
      impact: U.round(U.sumBy(lastEntry.lines.filter(l => l.account === other[0]), l => l.debit), 0),
      impact_note: 'Kategoriya bo‘yicha hisobot buzilishi.',
      recommendation: 'Yozuvni tekshiring: agar xato bo‘lsa, teskari yozuv + to‘g‘ri hisob bilan qayta kiriting.',
      fix: { type: 'review_entry', label: 'Yozuvni ko‘rish', entry_id: lastEntry.id, params: { entry_id: lastEntry.id } },
      evidence: [
        { label: 'Odatdagi hisob', value: `${main[0]} ${mainAcc ? mainAcc.name : ''}`, hint: `${main[1].count} ta yozuv` },
        { label: 'Bu yozuv hisobi', value: `${other[0]} ${otherAcc ? otherAcc.name : ''}` },
        { label: 'Yozuv', value: `${lastEntry.no} • ${lastEntry.date}`, link: { page: 'transactions', params: { id: lastEntry.id } } },
      ],
      entity: { type: 'entry', id: lastEntry.id, no: lastEntry.no },
    });
  }
  return out;
}

/** 6. Sana bilan bog'liq xatolar */
function detectDateIssues(companyId, ctx) {
  const out = [];
  const today = U.today();
  const entries = ledger.entries(companyId, { includeVoid: true });
  const future = entries.filter(e => e.date > today);
  for (const e of future.slice(0, 5)) {
    out.push({
      code: 'future_dated_entry', category: 'dates',
      severity: e.date > U.addDays(today, 30) ? 'medium' : 'low', confidence: 97,
      title: 'Kelajak sanasi bilan kiritilgan yozuv',
      what: `${e.no} yozuvi ${e.date} sanasi bilan kiritilgan (bugun ${today}).`,
      why: 'Kelajakdagi operatsiyalar joriy davr hisobotini buzadi va to‘lovlar tasdiqlanmagan bo‘lishi mumkin.',
      impact: U.round(U.sumBy(e.lines, l => l.debit), 0),
      impact_note: 'Davr natijasi noto‘g‘ri ko‘rsatiladi.',
      recommendation: 'Sana to‘g‘riligini tekshiring. Agar bu rejalashtirilgan operatsiya bo‘lsa — hujjat sifatida saqlang, jurnalga kiritmang.',
      fix: { type: 'review_entry', label: 'Yozuvni ko‘rish', entry_id: e.id, params: { entry_id: e.id } },
      evidence: [{ label: 'Yozuv', value: `${e.no} • ${e.date}`, hint: e.memo, link: { page: 'transactions', params: { id: e.id } } }, { label: 'Bugun', value: today }],
      entity: { type: 'entry', id: e.id, no: e.no },
    });
  }
  const old = entries.filter(e => e.date < U.addDays(today, -400) && e.created_at && e.created_at.slice(0, 10) > U.addDays(e.date, 60));
  if (old.length) {
    const totals = U.sumBy(old, e => U.sumBy(e.lines, l => l.debit));
    out.push({
      code: 'late_recorded_entries', category: 'dates',
      severity: 'low', confidence: 88,
      title: 'Kechiktirib kiritilgan yozuvlar',
      what: `${old.length} ta yozuv o‘z sanasidan 60 kundan ko‘proq keyin tizimga kiritilgan (jami ${U.fmtMoney(totals)}).`,
      why: 'Kechiktirilgan yozuvlar yopilgan davrlar hisobotini o‘zgartiradi.',
      impact: totals,
      impact_note: 'Davr hisobotlari qayta hisoblanishi kerak bo‘ladi.',
      recommendation: 'Bu yozuvlar qaysi davrga tegishli ekanini aniqlang va kerak bo‘lsa davrni qayta ochib tuzatish kiriting.',
      fix: { type: 'review', label: 'Yozuvlarni ko‘rish', params: { filter: 'late' } },
      evidence: old.slice(0, 5).map(e => ({ label: e.no, value: e.date, hint: `kiritilgan: ${(e.created_at || '').slice(0, 10)}`, link: { page: 'transactions', params: { id: e.id } } })),
      entity: { type: 'entries_group', id: 'late_recorded', ids: old.map(e => e.id) },
    });
  }
  // Hisob-faktura sanalari
  for (const inv of store.collection('invoices').filter(i => i.company_id === companyId && i.status !== 'cancelled')) {
    if (inv.due_date < inv.issue_date) {
      out.push({
        code: 'invoice_due_before_issue', category: 'dates', severity: 'medium', confidence: 99,
        title: 'To‘lov muddati sana xatosi',
        what: `${inv.no}: to‘lov muddati (${inv.due_date}) hisob-faktura sanasidan (${inv.issue_date}) oldin.`,
        why: 'To‘lov muddati noto‘g‘ri bo‘lsa, qarzdorlik yoshi (aging) hisoboti xato chiqadi.',
        impact: inv.total,
        impact_note: 'Debitorlik yoshi hisoboti buziladi.',
        recommendation: 'Hisob-faktura sanasini yoki to‘lov muddatini to‘g‘rilang.',
        fix: { type: 'review_invoice', label: 'Hisob-fakturani ochish', params: { invoice_id: inv.id } },
        evidence: [{ label: 'Hisob-faktura', value: inv.no, link: { page: 'invoices', params: { id: inv.id } } }, { label: 'Berilgan', value: inv.issue_date }, { label: 'Muddat', value: inv.due_date }],
        entity: { type: 'invoice', id: inv.id, no: inv.no },
      });
    }
  }
  return out;
}

/** 7. Buхgalteriya yaxlitligi: balans, manfiy kassa, davr yopilishi */
function detectIntegrityIssues(companyId, ctx) {
  const out = [];
  const tb = ledger.trialBalance(companyId, { from: '1900-01-01', to: ctx.to });
  if (!tb.balanced) {
    const diff = tb.totals.debit - tb.totals.credit;
    out.push({
      code: 'trial_balance_mismatch', category: 'integrity', severity: 'critical', confidence: 100,
      title: 'Jurnal balansi buzilgan (debet ≠ kredit)',
      what: `Barcha yozuvlar bo‘yicha debet ${U.fmtMoney(tb.totals.debit)}, kredit ${U.fmtMoney(tb.totals.credit)} — farq ${U.fmtMoney(diff)}.`,
      why: 'Double-entry qoidasi bo‘yicha har bir yozuvda debet = kredit bo‘lishi shart. Bu farq hisobotlarning ishonchsizligini bildiradi.',
      impact: Math.abs(diff),
      impact_note: 'Barcha moliyaviy hisobotlar xato bo‘lishi mumkin.',
      recommendation: 'Texnik yordamga murojaat qiling — ma’lumotlar bazasida buzuq yozuv mavjud.',
      fix: { type: 'review', label: 'Sinov balansini ko‘rish' },
      evidence: [{ label: 'Debet', value: U.fmtMoney(tb.totals.debit) }, { label: 'Kredit', value: U.fmtMoney(tb.totals.credit) }, { label: 'Farq', value: U.fmtMoney(diff) }],
      entity: { type: 'ledger', id: 'trial_balance' },
    });
  }
  const bs = ledger.balanceSheet(companyId, ctx.to);
  if (Math.abs(bs.difference) > 1) {
    out.push({
      code: 'balance_sheet_mismatch', category: 'integrity', severity: 'critical', confidence: 100,
      title: 'Balans tenglamasi buzilgan',
      what: `Aktivlar ${U.fmtMoney(bs.totalAssets)} ≠ Majburiyatlar + Kapital ${U.fmtMoney(bs.totalLiabilities + bs.totalEquity)} (farq ${U.fmtMoney(bs.difference)}).`,
      why: 'Buxgalteriya balansi tenglamasi (Aktiv = Majburiyat + Kapital) har doim bajarilishi kerak.',
      impact: Math.abs(bs.difference),
      impact_note: 'Balans hisoboti ishonchsiz.',
      recommendation: 'Balans hisobotini ochib, nolga teng bo‘lmagan hisoblarni tekshiring yoki texnik yordamga murojaat qiling.',
      fix: { type: 'review_report', label: 'Balans hisobotini ochish', params: { report: 'balance_sheet' } },
      evidence: [{ label: 'Aktivlar', value: U.fmtMoney(bs.totalAssets) }, { label: 'Majburiyat + Kapital', value: U.fmtMoney(bs.totalLiabilities + bs.totalEquity) }],
      entity: { type: 'ledger', id: 'balance_sheet' },
    });
  }
  for (const a of ledger.accountsOf(companyId)) {
    const bal = ledger.balanceOf(companyId, a.code, { asOf: ctx.to });
    if ((a.is_cash || a.is_bank) && bal < 0) {
      out.push({
        code: 'negative_cash', category: 'integrity', severity: 'high', confidence: 100,
        title: 'Manfiy kassa/bank qoldig‘i',
        what: `«${a.code} ${a.name}» hisobida manfiy qoldiq: ${U.fmtMoney(bal)}.`,
        why: 'Kassada yoki bank hisobida mavjud bo‘lmagan pulni sarflash mumkin emas — bu kiritilmagan kirim yoki ortiqcha chiqimni bildiradi.',
        impact: Math.abs(bal),
        impact_note: 'Pul qoldig‘i va hisobotlar xato.',
        recommendation: 'Shu hisob bo‘yicha yozuvlarni bank ko‘chirmasi bilan solishtiring va yetishmayotgan kirimlarni kiriting.',
        fix: { type: 'open_reconciliation', label: 'Solishtirishni ochish', params: { account: a.code } },
        evidence: [{ label: 'Hisob', value: `${a.code} ${a.name}` }, { label: 'Qoldiq', value: U.fmtMoney(bal) }],
        entity: { type: 'account', id: a.code, no: a.code },
      });
    }
    if (a.role === 'ar' && bal < -1) {
      out.push({
        code: 'negative_receivable', category: 'integrity', severity: 'medium', confidence: 95,
        title: 'Debitorlik qarzida manfiy qoldiq',
        what: `«${a.name}» hisobida ${U.fmtMoney(bal)} manfiy qoldiq.`,
        why: 'Bu mijozlar bizdan ko‘ra ko‘proq to‘laganini yoki kredit-nota noto‘g‘ri kiritilganini bildiradi.',
        impact: Math.abs(bal),
        impact_note: 'Debitorlik hisoboti xato.',
        recommendation: 'Avanс to‘lovlarni (6020) to‘g‘ri hisobga o‘tkazing va kredit-notalarni tekshiring.',
        fix: { type: 'review', label: 'Debitorlik hisobotini ko‘rish' },
        evidence: [{ label: 'Hisob', value: `${a.code} ${a.name}` }, { label: 'Qoldiq', value: U.fmtMoney(bal) }],
        entity: { type: 'account', id: a.code, no: a.code },
      });
    }
  }
  const pending = ledger.pendingEntries(companyId);
  const old = pending.filter(e => U.daysBetween((e.created_at || '').slice(0, 10), U.today()) > 3);
  if (old.length) {
    out.push({
      code: 'stale_approvals', category: 'process', severity: 'medium', confidence: 100,
      title: 'Tasdiqlashni kutayotgan eski yozuvlar',
      what: `${old.length} ta jurnal yozuvi 3 kundan ortiq tasdiqlashni kutmoqda (jami ${U.fmtMoney(U.sumBy(old, e => U.sumBy(e.lines, l => l.debit)))}).`,
      why: 'Tasdiqlanmagan yozuvlar hisobotlarga kirmaydi — natijada haqiqiy holat buziladi.',
      impact: U.sumBy(old, e => U.sumBy(e.lines, l => l.debit)),
      impact_note: 'Hisobotlar to‘liq emas.',
      recommendation: 'Approval Center bo‘limiga o‘tib yozuvlarni ko‘rib chiqing: tasdiqlang yoki rad eting.',
      fix: { type: 'open_approvals', label: 'Tasdiqlash markazini ochish' },
      evidence: old.slice(0, 5).map(e => ({ label: e.no, value: `${(e.created_at || '').slice(0, 10)}`, hint: e.memo, link: { page: 'approvals', params: {} } })),
      entity: { type: 'approvals', id: 'stale', ids: old.map(e => e.id) },
    });
  }
  return out;
}

/** 8. Muddati o'tgan hisob-fakturalar va debitorlik */
function detectReceivables(companyId, ctx) {
  const out = [];
  const summary = require('./invoices').receivablesSummary(companyId, { asOf: ctx.to });
  if (summary.overdue > 0) {
    const aging = summary.aging;
    const over90 = (aging.find(b => b.key === '90+') || {}).amount || 0;
    out.push({
      code: 'overdue_receivables', category: 'receivables',
      severity: over90 > 0 ? 'high' : summary.overdue > 50000000 ? 'high' : 'medium',
      confidence: 99,
      title: 'Muddati o‘tgan debitorlik qarzi',
      what: `${summary.overdue_count} ta hisob-faktura bo‘yicha ${U.fmtMoney(summary.overdue)} muddati o‘tgan.`,
      why: `To‘lov muddati o‘tgan qarzlar aylanma mablag‘ni kamaytiradi va undirish ehtimoli vaqt bilan pasayadi.${over90 > 0 ? ` 90 kundan ortiq: ${U.fmtMoney(over90)}.` : ''}`,
      impact: summary.overdue,
      impact_note: 'Pul oqimi va likvidlikka bevosita ta’sir.',
      recommendation: 'Muddati o‘tgan hisob-fakturalar bo‘yicha mijozlarga eslatma yuboring; 90+ kunlar uchun yuridik choralar ko‘rib chiqing.',
      fix: { type: 'open_receivables', label: 'Debitorlikni ko‘rish' },
      evidence: [
        { label: 'Muddati o‘tgan', value: U.fmtMoney(summary.overdue) },
        { label: '90+ kun', value: U.fmtMoney(over90) },
        { label: 'Jami debitorlik', value: U.fmtMoney(summary.total) },
        ...summary.invoices.filter(i => i.is_overdue).slice(0, 5).map(i => ({ label: i.no, value: U.fmtMoney(i.open_amount), hint: `${i.customer_name} • ${i.overdue_days} kun`, link: { page: 'invoices', params: { id: i.id } } })),
      ],
      entity: { type: 'receivables', id: 'overdue' },
    });
  }
  const late = require('./invoices').latePayers(companyId, 3);
  for (const lp of late.filter(l => l.avg_payment_days && l.avg_payment_days > l.terms_days + 15)) {
    out.push({
      code: 'slow_payer', category: 'receivables', severity: 'medium', confidence: 88,
      title: 'To‘lovni kechiktiruvchi mijoz',
      what: `«${lp.name}» o‘rtacha ${lp.avg_payment_days} kunda to‘laydi (shartnoma: ${lp.terms_days} kun). Ochiq qoldiq: ${U.fmtMoney(lp.open_amount)}.`,
      why: 'Shartnomadagi muddatdan sezilarli kechikish — kredit siyosatini qayta ko‘rib chiqish kerak.',
      impact: lp.open_amount,
      impact_note: 'Pul aylanishi sekinlashadi.',
      recommendation: 'Oldindan to‘lov (prepayment) sharti qo‘yish yoki kredit limitini kamaytirishni ko‘rib chiqing.',
      fix: { type: 'open_party', label: 'Mijoz kartochkasini ochish', params: { party_id: lp.party_id } },
      evidence: [
        { label: 'O‘rtacha to‘lov muddati', value: `${lp.avg_payment_days} kun` },
        { label: 'Shartnoma muddati', value: `${lp.terms_days} kun` },
        { label: 'Ochiq qoldiq', value: U.fmtMoney(lp.open_amount) },
        { label: 'Muddati o‘tgan', value: U.fmtMoney(lp.overdue_amount) },
      ],
      entity: { type: 'party', id: lp.party_id, no: lp.name },
    });
  }
  return out;
}

/** 9. Kreditorlik: yaqin to'lovlar va kechikishlar */
function detectPayables(companyId, ctx) {
  const out = [];
  const summary = require('./bills').payablesSummary(companyId, { asOf: ctx.to });
  if (summary.overdue > 0) {
    out.push({
      code: 'overdue_payables', category: 'payables', severity: 'high', confidence: 99,
      title: 'Muddati o‘tgan kreditorlik qarzi',
      what: `${summary.overdue_count} ta yetkazib beruvchi hisobi bo‘yicha ${U.fmtMoney(summary.overdue)} muddati o‘tgan.`,
      why: 'Kechiktirilgan to‘lovlar penya, ishonch yo‘qolishi va yetkazib berish to‘xtashiga olib keladi.',
      impact: summary.overdue,
      impact_note: 'Qo‘shimcha jarima xavfi.',
      recommendation: 'Muddati o‘tgan hisoblarni to‘lang yoki yetkazib beruvchi bilan yangi muddat kelishing.',
      fix: { type: 'open_payables', label: 'Kreditorlikni ko‘rish' },
      evidence: [
        { label: 'Muddati o‘tgan', value: U.fmtMoney(summary.overdue) },
        { label: 'Jami kreditorlik', value: U.fmtMoney(summary.total) },
        ...summary.bills.filter(b => b.is_overdue).slice(0, 5).map(b => ({ label: b.no, value: U.fmtMoney(b.open_amount), hint: `${b.supplier_name} • ${b.overdue_days} kun`, link: { page: 'bills', params: { id: b.id } } })),
      ],
      entity: { type: 'payables', id: 'overdue' },
    });
  }
  const upcoming = require('./bills').upcoming(companyId, 7);
  if (upcoming.length) {
    const total = U.sumBy(upcoming, b => b.open_amount);
    const cash = ledger.cashPosition(companyId).total;
    out.push({
      code: 'upcoming_payments', category: 'payables',
      severity: cash < total ? 'high' : 'medium', confidence: 100,
      title: 'Yaqin 7 kunda to‘lanishi kerak bo‘lgan hisoblar',
      what: `${upcoming.length} ta yetkazib beruvchi hisobi 7 kun ichida to‘lanishi kerak — jami ${U.fmtMoney(total)}.`,
      why: `Joriy kassa/bank qoldig‘i ${U.fmtMoney(cash)}. ${cash < total ? 'To‘lovlar uchun mablag‘ yetarli emas — pul oqimi rejasini tuzish kerak.' : 'To‘lovlarni rejalashtirish tavsiya etiladi.'}`,
      impact: total,
      impact_note: cash < total ? 'To‘lov kechikishi va jarima xavfi.' : 'Rejalashtirilgan chiqim.',
      recommendation: cash < total ? 'Kutilayotgan tushumlarni hisobga olib to‘lov jadvalini tuzing yoki to‘lov shartlarini kechiktirishni so‘rang.' : 'To‘lovlarni jadval bo‘yicha amalga oshiring.',
      fix: { type: 'open_payables', label: 'To‘lovlarni rejalashtirish' },
      evidence: [
        { label: 'To‘lanadigan summa', value: U.fmtMoney(total) },
        { label: 'Mavjud pul', value: U.fmtMoney(cash) },
        ...upcoming.slice(0, 5).map(b => ({ label: b.no, value: U.fmtMoney(b.open_amount), hint: `${b.supplier_name} • muddat ${b.due_date}`, link: { page: 'bills', params: { id: b.id } } })),
      ],
      entity: { type: 'payables', id: 'upcoming' },
    });
  }
  return out;
}

/** 10. Ombor anomaliyalari */
function detectInventory(companyId) {
  const issues = require('./inventory').anomalies(companyId);
  return issues.map(i => ({
    code: i.type, category: 'inventory',
    severity: i.severity, confidence: i.type === 'negative_stock' ? 100 : i.type === 'low_stock' ? 95 : 70,
    title: i.title, what: i.detail,
    why: i.type === 'negative_stock'
      ? 'Omborda mavjud bo‘lmagan tovarni sotish/qayd etish — kirim yoki inventarizatsiya xatosi.'
      : i.type === 'low_stock' ? 'Zaxira minimum darajadan past — sotuv to‘xtashi mumkin.' : 'Bu harakat tarixiy ko‘rsatkichlardan keskin farq qiladi.',
    impact: i.impact || 0,
    impact_note: i.type === 'low_stock' ? 'Sotuvdan mahrum bo‘lish xavfi.' : 'Ombor qiymati va tannarx xato hisoblanishi mumkin.',
    recommendation: i.type === 'negative_stock'
      ? 'Inventarizatsiya o‘tkazib, haqiqiy qoldiqni kiriting; yetishmayotgan kirim hujjatlarini toping.'
      : i.type === 'low_stock' ? 'Yetkazib beruvchiga buyurtma bering yoki xarid rejasiga kiriting.' : 'Harakatning asosini tekshiring (nakladnoy, akt).',
    fix: { type: i.type === 'negative_stock' ? 'adjust_stock' : 'open_inventory', label: i.type === 'negative_stock' ? 'Inventarizatsiya o‘tkazish' : 'Omborni ko‘rish', params: { product_id: i.product_id } },
    evidence: i.evidence,
    entity: { type: 'product', id: i.product_id },
  }));
}

/** 11. Yetkazib beruvchi xarajatlarining keskin o'sishi / kontsentratsiya */
function detectSupplierActivity(companyId, ctx) {
  const out = [];
  const period = U.periodOf(ctx.to);
  const current = ledger.periodSummary(companyId, { from: ctx.from, to: ctx.to });
  const prevPeriod = U.addMonths(period, -1);
  const prevRange = { from: U.periodStart(prevPeriod), to: U.periodEnd(prevPeriod) };
  const partySpend = (from, to) => {
    const map = new Map();
    for (const e of journal(companyId, { from, to })) {
      for (const l of e.lines) {
        const a = ledger.tryAccount(companyId, l.account);
        if (!l.party_id || !a || a.type !== 'expense') continue;
        map.set(l.party_id, (map.get(l.party_id) || 0) + (l.debit - l.credit));
      }
    }
    return map;
  };
  const cur = partySpend(ctx.from, ctx.to);
  const prev = partySpend(prevRange.from, prevRange.to);
  const totalSpend = U.sumBy([...cur.values()], v => v);
  for (const [partyId, amount] of cur) {
    const before = prev.get(partyId) || 0;
    if (before > 0 && amount > before * 1.6 && amount - before > 5000000) {
      const party = store.collection('parties').find(p => p.id === partyId);
      out.push({
        code: 'supplier_spend_jump', category: 'suppliers', severity: 'medium', confidence: 85,
        title: 'Yetkazib beruvchi xarajati keskin oshdi',
        what: `«${party ? party.name : '—'}» bo‘yicha xarajat ${U.fmtMoney(before)} dan ${U.fmtMoney(amount)} gacha oshdi (+${U.round(((amount - before) / before) * 100, 0)}%).`,
        why: 'Bir yetkazib beruvchi bo‘yicha xarajatning keskin o‘sishi narx o‘zgarishi, takroriy hisob yoki shartnoma o‘zgarishi sababli bo‘lishi mumkin.',
        impact: amount - before,
        impact_note: 'Xarajat nazorati va byudjetga ta’sir.',
        recommendation: 'Xarid shartnomalari va hisob-fakturalarni taqqoslang: narx oshdimi yoki hajm oshdimi?',
        fix: { type: 'open_party', label: 'Kontragent kartochkasini ochish', params: { party_id: partyId } },
        evidence: [
          { label: 'O‘tgan oy', value: U.fmtMoney(before) },
          { label: 'Joriy oy', value: U.fmtMoney(amount) },
          { label: 'O‘sish', value: U.fmtMoney(amount - before) },
        ],
        entity: { type: 'party', id: partyId },
      });
    }
    if (totalSpend > 0 && amount / totalSpend > 0.45 && totalSpend > 20000000) {
      const party = store.collection('parties').find(p => p.id === partyId);
      out.push({
        code: 'supplier_concentration', category: 'suppliers', severity: 'medium', confidence: 90,
        title: 'Yetkazib beruvchiga qaramlik yuqori',
        what: `«${party ? party.name : '—'}» joriy davr xarajatlarining ${U.round((amount / totalSpend) * 100, 1)}% ini tashkil qiladi (${U.fmtMoney(amount)}).`,
        why: 'Bitta yetkazib beruvchiga 45% dan ortiq qaramlik — narx va uzilish riski.',
        impact: amount,
        impact_note: 'Yetkazib berish uzilishi operatsiyalarni to‘xtatishi mumkin.',
        recommendation: 'Alternativ yetkazib beruvchilarni topib, xaridlarni diversifikatsiya qiling.',
        fix: { type: 'open_party', label: 'Kontragent kartochkasini ochish', params: { party_id: partyId } },
        evidence: [{ label: 'Bu yetkazib beruvchi', value: U.fmtMoney(amount) }, { label: 'Jami xarajat', value: U.fmtMoney(totalSpend) }, { label: 'Ulush', value: `${U.round((amount / totalSpend) * 100, 1)}%` }],
        entity: { type: 'party', id: partyId },
      });
    }
  }
  return out;
}

/** 12. Xarajat o'sishi anomaliyasi (kategoriya bo'yicha) */
function detectExpenseGrowth(companyId, ctx) {
  const out = [];
  const current = require('./transactions').byCategory(companyId, { from: ctx.from, to: ctx.to }, 'expense');
  const prevPeriod = U.addMonths(U.periodOf(ctx.to), -1);
  const prev = require('./transactions').byCategory(companyId, { from: U.periodStart(prevPeriod), to: U.periodEnd(prevPeriod) }, 'expense');
  const prevMap = new Map(prev.rows.map(r => [r.code, r.amount]));
  for (const row of current.rows) {
    const before = prevMap.get(row.code) || 0;
    if (before < 1000000 || row.amount <= before) continue;
    const growth = ((row.amount - before) / before) * 100;
    if (growth < 35 || row.amount - before < 2000000) continue;
    out.push({
      code: 'expense_growth', category: 'expenses', severity: growth > 80 ? 'high' : 'medium', confidence: 90,
      title: 'Xarajat keskin o‘sdi',
      what: `«${row.label}» xarajati ${U.fmtMoney(before)} dan ${U.fmtMoney(row.amount)} gacha oshdi (+${U.round(growth, 1)}%).`,
      why: `O‘tgan oyga nisbatan ${U.fmtMoney(row.amount - before)} qo‘shimcha xarajat. ${row.share >= 20 ? `Bu kategoriya joriy xarajatlarning ${row.share}% ini tashkil qiladi.` : ''}`,
      impact: row.amount - before,
      impact_note: 'Foyda marjasiga bevosita ta’sir.',
      recommendation: 'O‘sish sababini aniqlang: hajm oshdimi, narx oshdimi yoki bir martalik xarajatmi? Byudjet limitini qayta ko‘rib chiqing.',
      fix: { type: 'review_account', label: 'Xarajat yozuvlarini ko‘rish', params: { account: row.code } },
      evidence: [
        { label: 'O‘tgan oy', value: U.fmtMoney(before) },
        { label: 'Joriy davr', value: U.fmtMoney(row.amount) },
        { label: 'O‘sish', value: U.fmtMoney(row.amount - before) },
        { label: 'Ulush', value: `${row.share}%` },
      ],
      entity: { type: 'account', id: row.code, no: row.code },
    });
  }
  return out;
}

/** 13. Marja anomaliyasi */
function detectMarginAnomalies(companyId, ctx) {
  const out = [];
  const trend = ledger.monthlyTrend(companyId, 6);
  const current = trend[trend.length - 1];
  const prior = trend.slice(0, -1).filter(t => t.revenue > 0);
  if (current.revenue > 0 && prior.length >= 2) {
    const currentMargin = ((current.revenue - current.expense) / current.revenue) * 100;
    const priorMargins = prior.map(t => ((t.revenue - t.expense) / t.revenue) * 100);
    const avg = U.mean(priorMargins);
    const delta = currentMargin - avg;
    if (delta < -8) {
      out.push({
        code: 'margin_drop', category: 'margin', severity: delta < -15 ? 'high' : 'medium', confidence: 85,
        title: 'Marja keskin pasaydi',
        what: `Joriy davr marjasi ${U.round(currentMargin, 1)}% — oldingi ${prior.length} oy o‘rtachasi ${U.round(avg, 1)}% (${U.round(delta, 1)} p.p.).`,
        why: `Daromad ${U.fmtMoney(current.revenue)}, xarajat ${U.fmtMoney(current.expense)}. Xarajat daromaddan tezroq o‘sgan.`,
        impact: U.round((delta / 100) * current.revenue, 0),
        impact_note: 'Foyda pasayishi (taxminiy hisob).',
        recommendation: 'Xarajatlar tarkibini va narx siyosatini ko‘rib chiqing: tannarx, ish haqi yoki operatsion xarajatlar oshganini aniqlang.',
        fix: { type: 'open_advisor', label: 'AI tahlilini ochish' },
        evidence: [
          { label: 'Joriy marja', value: `${U.round(currentMargin, 1)}%` },
          { label: 'Oldingi o‘rtacha', value: `${U.round(avg, 1)}%` },
          ...trend.map(t => ({ label: t.full_label, value: `${t.revenue ? U.round(((t.revenue - t.expense) / t.revenue) * 100, 1) : 0}%`, hint: `Daromad ${U.fmtMoney(t.revenue)}` })),
        ],
        entity: { type: 'reports', id: 'margin' },
      });
    }
  }
  // Tannarxdan past narxda sotilayotgan mahsulotlar
  for (const p of require('./inventory').list(companyId, { active: true })) {
    if (p.is_service || !p.sale_price || p.avg_cost <= 0) continue;
    if (p.sale_price < p.avg_cost && p.stock > 0) {
      out.push({
        code: 'negative_margin_product', category: 'margin', severity: 'medium', confidence: 92,
        title: 'Zarar bilan sotilayotgan mahsulot',
        what: `«${p.name}» sotuv narxi ${U.fmtMoney(p.sale_price)}, o‘rtacha tannarx ${U.fmtMoney(p.avg_cost)} — har bir dona ${U.fmtMoney(p.avg_cost - p.sale_price)} zarar.`,
        why: 'Sotuv narxi tannarxdan past: har bir sotuv zarar keltiradi.',
        impact: U.round((p.avg_cost - p.sale_price) * Math.max(0, p.stock), 0),
        impact_note: 'Mavjud zaxira sotilsa ko‘riladigan zarar.',
        recommendation: 'Narxni tannarxdan yuqoriga ko‘taring yoki tannarxni kamaytirish yo‘lini izlang.',
        fix: { type: 'open_inventory', label: 'Mahsulotni ko‘rish', params: { product_id: p.id } },
        evidence: [{ label: 'Sotuv narxi', value: U.fmtMoney(p.sale_price) }, { label: 'Tannarx', value: U.fmtMoney(p.avg_cost) }, { label: 'Qoldiq', value: `${p.stock} ${p.unit}` }],
        entity: { type: 'product', id: p.id },
      });
    }
  }
  return out;
}

/** 14. Reconciliation (bank solishtirish) muammolari */
function detectReconciliation(companyId, ctx) {
  const out = [];
  const rows = store.collection('bankRows').filter(r => r.company_id === companyId && r.status === 'unmatched');
  if (!rows.length) return out;
  const accounts = U.uniq(rows.map(r => r.account));
  for (const account of accounts) {
    const accRows = rows.filter(r => r.account === account);
    const dupes = accRows.filter(r => r.duplicate_hint);
    const noMatch = accRows.filter(r => !r.duplicate_hint && !require('./banking').candidateEntries(companyId, r).length);
    const acc = ledger.tryAccount(companyId, account);
    if (dupes.length) {
      out.push({
        code: 'reconciliation_duplicates', category: 'reconciliation', severity: 'high', confidence: 90,
        title: 'Bank ko‘chirmasida dublikat qatorlar',
        what: `«${acc ? acc.name : account}» bo‘yicha ${dupes.length} ta qator bir xil sana, summa va yo‘nalishda takrorlanadi.`,
        why: 'Bank ko‘chirmasi ikki marta import qilingan yoki bankda haqiqatan ikki marta o‘tkazilgan bo‘lishi mumkin.',
        impact: U.sumBy(dupes, r => r.amount),
        impact_note: 'Pul qoldig‘i ikki marta hisoblanishi mumkin.',
        recommendation: 'Solishtirish bo‘limida qatorlarni bank bilan taqqoslang va kerak bo‘lsa e’tiborsiz qoldiring.',
        fix: { type: 'open_reconciliation', label: 'Solishtirishni ochish', params: { account } },
        evidence: dupes.slice(0, 6).map(r => ({ label: r.date, value: U.fmtMoney(r.amount), hint: r.description || r.counterparty, link: { page: 'reconciliation', params: { account, row: r.id } } })),
        entity: { type: 'bank_account', id: account },
      });
    }
    if (noMatch.length) {
      const total = U.sumBy(noMatch, r => r.amount);
      out.push({
        code: 'reconciliation_missing_entry', category: 'reconciliation', severity: 'medium', confidence: 88,
        title: 'Buxgalteriyada yo‘q bank harakatlari',
        what: `«${acc ? acc.name : account}» bo‘yicha ${noMatch.length} ta bank harakati uchun buxgalteriya yozuvi topilmadi — jami ${U.fmtMoney(total)}.`,
        why: 'Bank ko‘chirmasidagi harakatlar buxgalteriyada aks etmasa, pul qoldig‘i va xarajatlar xato bo‘ladi.',
        impact: total,
        impact_note: 'Kassa/bank qoldig‘i va hisobotlar xato.',
        recommendation: 'Solishtirish bo‘limida bu qatorlar uchun operatsiya yarating yoki mavjud yozuvga bog‘lang.',
        fix: { type: 'open_reconciliation', label: 'Solishtirishni ochish', params: { account } },
        evidence: noMatch.slice(0, 6).map(r => ({ label: r.date, value: U.fmtMoney(r.amount), hint: r.description || r.counterparty, link: { page: 'reconciliation', params: { account, row: r.id } } })),
        entity: { type: 'bank_account', id: account },
      });
    }
    // Summasi boshqacha mosliklar
    const amountMismatch = accRows.filter(r => {
      const cands = require('./banking').candidateEntries(companyId, r);
      return cands.length && cands.every(c => c.amount !== r.amount);
    });
    if (amountMismatch.length) {
      out.push({
        code: 'reconciliation_amount_mismatch', category: 'reconciliation', severity: 'medium', confidence: 72,
        title: 'Summasi farq qiluvchi bank harakatlari',
        what: `${amountMismatch.length} ta bank qatori uchun summasi aniq mos keladigan buxgalteriya yozuvi yo‘q (jami ${U.fmtMoney(U.sumBy(amountMismatch, r => r.amount))}).`,
        why: 'Komissiya, kurs farqi yoki summani noto‘g‘ri kiritish natijasida farq bo‘lishi mumkin.',
        impact: U.sumBy(amountMismatch, r => r.amount),
        impact_note: 'Qoldiq farqi to‘planib boradi.',
        recommendation: 'Farqlarni tekshirib, bank komissiyasi yoki kurs farqi bo‘lsa alohida yozuv kiriting.',
        fix: { type: 'open_reconciliation', label: 'Solishtirishni ochish', params: { account } },
        evidence: amountMismatch.slice(0, 6).map(r => ({ label: r.date, value: U.fmtMoney(r.amount), hint: r.description || r.counterparty, link: { page: 'reconciliation', params: { account, row: r.id } } })),
        entity: { type: 'bank_account', id: account },
      });
    }
  }
  return out;
}

/** 15. Soliq bilan bog'liq nomuvofiqliklar */
function detectTaxIssues(companyId, ctx) {
  const out = [];
  const settings = ledger.getSettings(companyId);
  const tax = require('./tax');
  const summary = tax.summary(companyId, { from: ctx.from, to: ctx.to });
  if (settings.tax_mode === 'vat') {
    const vatOut = ledger.roleBalance(companyId, 'vat_out');
    if (vatOut > 0) {
      const deadline = tax.vatDeadline(U.periodOf(ctx.to));
      if (deadline && deadline < U.today()) {
        out.push({
          code: 'vat_payment_overdue', category: 'tax', severity: 'high', confidence: 92,
          title: 'QQS to‘lovi muddati o‘tgan',
          what: `${U.periodLabel(U.periodOf(ctx.to))} uchun QQS qarzi ${U.fmtMoney(vatOut)} — deklaratsiya muddati ${deadline}.`,
          why: 'QQS qarzi to‘lanmagan bo‘lsa, penya hisoblanadi va soliq organi bloklashi mumkin.',
          impact: vatOut,
          impact_note: 'Penya va jarima xavfi (hisoblangan summaning bir qismi).',
          recommendation: 'QQS hisobotini tayyorlab, to‘lovni amalga oshiring. Soliq markazidagi kalendarni tekshiring.',
          fix: { type: 'open_tax', label: 'Soliq markazini ochish' },
          evidence: [{ label: 'QQS qarzi', value: U.fmtMoney(vatOut) }, { label: 'Muddat', value: deadline }, { label: 'Davr', value: U.periodLabel(U.periodOf(ctx.to)) }],
          entity: { type: 'tax', id: 'vat' },
        });
      }
    }
  }
  // Kirmayotgan QQS: QQS rejimida bo'lib, hisob-fakturalarda QQS 0
  if (settings.tax_mode === 'vat') {
    const noVat = store.collection('invoices').filter(i => i.company_id === companyId && i.tax_total === 0 && i.total > 0 && i.status !== 'cancelled' && i.status !== 'draft' && i.issue_date >= ctx.from);
    if (noVat.length) {
      out.push({
        code: 'missing_vat_on_invoice', category: 'tax', severity: 'medium', confidence: 80,
        title: 'QQS hisoblanmagan hisob-fakturalar',
        what: `${noVat.length} ta hisob-faktura QQSsiz rasmiylashtirilgan (jami ${U.fmtMoney(U.sumBy(noVat, i => i.total))}).`,
        why: 'Kompaniya QQS to‘lovchisi bo‘lsa, sotuv bo‘yicha QQS hisoblanishi shart.',
        impact: U.round(U.sumBy(noVat, i => i.total) * (settings.vat_rate / 100), 0),
        impact_note: 'Hisoblanmagan QQS summasi (taxminiy).',
        recommendation: 'Bu hisob-fakturalar QQSsiz bo‘lishi sababini tekshiring (eksport, imtiyoz yoki xato).',
        fix: { type: 'open_tax', label: 'QQS bo‘limini ko‘rish' },
        evidence: noVat.slice(0, 5).map(i => ({ label: i.no, value: U.fmtMoney(i.total), hint: `${i.issue_date}`, link: { page: 'invoices', params: { id: i.id } } })),
        entity: { type: 'tax', id: 'vat_missing' },
      });
    }
  }
  const pendingTaxDocs = tax.calendar(companyId).filter(e => e.status === 'overdue' && e.critical);
  if (pendingTaxDocs.length) {
    out.push({
      code: 'tax_deadlines_missed', category: 'tax', severity: 'high', confidence: 95,
      title: 'Soliq muddatlari o‘tgan',
      what: `${pendingTaxDocs.length} ta soliq majburiyati muddati o‘tgan: ${pendingTaxDocs.map(e => e.title).join(', ')}.`,
      why: 'Muddati o‘tgan deklaratsiya va to‘lovlar jarima hamda penya keltiradi.',
      impact: 0,
      impact_note: 'Jarima xavfi (summa hisoblanmagan).',
      recommendation: 'Soliq markazida har bir muddatni belgilang va bajarilganini qayd eting.',
      fix: { type: 'open_tax', label: 'Soliq kalendarini ochish' },
      evidence: pendingTaxDocs.map(e => ({ label: e.title, value: e.due_date, hint: e.period })),
      entity: { type: 'tax', id: 'deadlines' },
    });
  }
  return out;
}

/** 16. Pul oqimi riski (real prognoz asosida) */
function detectCashflowRisk(companyId, ctx) {
  const out = [];
  const forecast = require('./ai').cashForecast(companyId, 30);
  if (!forecast.available) return out;
  const cash = ledger.cashPosition(companyId).total;
  const min = Math.min(...forecast.points.map(p => p.balance));
  if (min < 0) {
    const when = forecast.points.find(p => p.balance < 0);
    out.push({
      code: 'cashflow_negative', category: 'cashflow', severity: 'critical', confidence: 78,
      title: 'Pul oqimi manfiyga tushish prognozi',
      what: `30 kunlik prognozga ko‘ra ${when ? when.date : 'yaqin kunlarda'} kassa qoldig‘i ${U.fmtMoney(min)} ga tushadi.`,
      why: `Joriy qoldiq ${U.fmtMoney(cash)}; kutilayotgan chiqimlar kutilayotgan tushumlardan ko‘p (${U.fmtMoney(forecast.totals.expected_out)} vs ${U.fmtMoney(forecast.totals.expected_in)}).`,
      impact: Math.abs(min),
      impact_note: 'To‘lovlarni amalga oshirish imkoni yo‘qoladi.',
      recommendation: 'Debitorlikni tez undirish, kreditorlik muddatlarini cho‘zish yoki qo‘shimcha aylanma mablag‘ jalb qilish choralarini ko‘ring.',
      fix: { type: 'open_forecast', label: 'Prognozni ko‘rish' },
      evidence: [
        { label: 'Joriy qoldiq', value: U.fmtMoney(cash) },
        { label: 'Prognoz minimal', value: U.fmtMoney(min), hint: when ? when.date : '' },
        { label: 'Kutilayotgan tushum', value: U.fmtMoney(forecast.totals.expected_in) },
        { label: 'Kutilayotgan chiqim', value: U.fmtMoney(forecast.totals.expected_out) },
      ],
      entity: { type: 'cashflow', id: 'forecast30' },
    });
  } else if (forecast.data_quality === 'good') {
    const days = min < cash * 0.2 ? 30 : null;
    if (days) {
      out.push({
        code: 'cashflow_buffer_low', category: 'cashflow', severity: 'medium', confidence: 70,
        title: 'Pul zapasi kamaymoqda',
        what: `30 kunlik prognozda minimal qoldiq ${U.fmtMoney(min)} — joriy qoldiqning ${U.round((min / Math.max(1, cash)) * 100, 0)}%.`,
        why: 'Rejalashtirilmagan xarajatlar uchun zaxira yetarli bo‘lmasligi mumkin.',
        impact: cash - min,
        impact_note: 'Likvidlik xavfi.',
        recommendation: 'Kechiktirilgan tushumlarni undirish va xarajatlarni kechiktirish imkoniyatini ko‘rib chiqing.',
        fix: { type: 'open_forecast', label: 'Prognozni ko‘rish' },
        evidence: [{ label: 'Joriy qoldiq', value: U.fmtMoney(cash) }, { label: 'Minimal proqnoz', value: U.fmtMoney(min) }],
        entity: { type: 'cashflow', id: 'buffer' },
      });
    }
  }
  return out;
}

/** 17. Taqsimlanmagan avanslar va hujjatsiz bog'lanmagan hujjatlar */
function detectProcessIssues(companyId, ctx) {
  const out = [];
  const advances = require('./payments').unallocatedAdvances(companyId).filter(p => U.daysBetween(p.date, U.today()) > 30);
  if (advances.length) {
    const total = U.sumBy(advances, a => a.unallocated);
    out.push({
      code: 'stale_advances', category: 'process', severity: 'low', confidence: 90,
      title: 'Taqsimlanmagan avans to‘lovlar',
      what: `${advances.length} ta to‘lov 30 kundan ortiq taqsimlanmagan — jami ${U.fmtMoney(total)}.`,
      why: 'Avanslar hujjatlarga bog‘lanmasa, debitorlik/kreditorlik qoldiqlari xato ko‘rsatiladi.',
      impact: total,
      impact_note: 'Hisob-kitob qoldig‘i xato.',
      recommendation: 'To‘lovlarni tegishli hisob-fakturalarga taqsimlang yoki qaytarib bering.',
      fix: { type: 'open_payments', label: 'To‘lovlarni ko‘rish' },
      evidence: advances.slice(0, 5).map(a => ({ label: a.no, value: U.fmtMoney(a.unallocated), hint: `${a.party_name} • ${a.date}`, link: { page: 'payments', params: { id: a.id } } })),
      entity: { type: 'payments', id: 'advances' },
    });
  }
  const unlinked = require('./documents').unlinked(companyId, 3);
  if (unlinked.length) {
    out.push({
      code: 'unlinked_documents', category: 'documents', severity: 'low', confidence: 95,
      title: 'Hech narsaga bog‘lanmagan hujjatlar',
      what: `${unlinked.length} ta hujjat 3 kundan ortiq hech qanday operatsiya, hisob-faktura yoki kontragentga bog‘lanmagan.`,
      why: 'Bog‘lanmagan hujjatlar hisobotda ishlatilmaydi va keyinchalik topish qiyin bo‘ladi.',
      impact: 0,
      impact_note: 'Hujjat boshqaruvi xatosi.',
      recommendation: 'Hujjatlar markazida har bir hujjatni tegishli operatsiya yoki kontragentga bog‘lang.',
      fix: { type: 'open_documents', label: 'Hujjatlar markazini ochish' },
      evidence: unlinked.slice(0, 5).map(d => ({ label: d.name, value: `${Math.round((d.size || 0) / 1024)} KB`, hint: (d.created_at || '').slice(0, 10), link: { page: 'documents', params: { id: d.id } } })),
      entity: { type: 'documents', id: 'unlinked' },
    });
  }
  // To'lanmagan hisob-fakturalar (muddati kelmagan, lekin eslatma kerak)
  const dueSoon = require('./invoices').receivablesSummary(companyId).invoices.filter(i => i.days_to_due >= 0 && i.days_to_due <= 3);
  if (dueSoon.length) {
    out.push({
      code: 'invoices_due_soon', category: 'receivables', severity: 'low', confidence: 100,
      title: 'To‘lov muddati yaqin hisob-fakturalar',
      what: `${dueSoon.length} ta hisob-faktura 3 kun ichida to‘lanishi kerak — jami ${U.fmtMoney(U.sumBy(dueSoon, i => i.open_amount))}.`,
      why: 'Muddatni o‘tkazib yubormaslik uchun mijozga oldindan eslatma yuborish tavsiya etiladi.',
      impact: U.sumBy(dueSoon, i => i.open_amount),
      impact_note: 'Kechiktirilgan to‘lov xavfi.',
      recommendation: 'Mijozlarga to‘lov eslatmasini yuboring.',
      fix: { type: 'open_receivables', label: 'Debitorlikni ko‘rish' },
      evidence: dueSoon.slice(0, 5).map(i => ({ label: i.no, value: U.fmtMoney(i.open_amount), hint: `${i.customer_name} • muddat ${i.due_date}`, link: { page: 'invoices', params: { id: i.id } } })),
      entity: { type: 'invoices', id: 'due_soon' },
    });
  }
  return out;
}

/** 18. Kontragent kredit limiti va avans balanslari */
function detectPartyLimits(companyId) {
  const out = [];
  for (const p of store.collection('parties').filter(x => x.company_id === companyId && x.status !== 'archived' && x.credit_limit > 0)) {
    const bal = require('./parties').ledgerBalance(companyId, p.id, 'ar');
    if (bal > p.credit_limit) {
      out.push({
        code: 'credit_limit_exceeded', category: 'receivables', severity: 'high', confidence: 100,
        title: 'Kredit limiti oshib ketgan',
        what: `«${p.name}» qarzi ${U.fmtMoney(bal)} — belgilangan limit ${U.fmtMoney(p.credit_limit)}.`,
        why: 'Mijozga berilgan kredit limitidan ortiq qarz — undirish riski oshadi.',
        impact: bal - p.credit_limit,
        impact_note: 'Limitdan oshgan summa.',
        recommendation: 'Yangi hisob-faktura berishdan oldin to‘lovni talab qiling yoki limitni qayta ko‘rib chiqing.',
        fix: { type: 'open_party', label: 'Mijoz kartochkasini ochish', params: { party_id: p.id } },
        evidence: [{ label: 'Qarz', value: U.fmtMoney(bal) }, { label: 'Limit', value: U.fmtMoney(p.credit_limit) }, { label: 'Oshgan summa', value: U.fmtMoney(bal - p.credit_limit) }],
        entity: { type: 'party', id: p.id, no: p.name },
      });
    }
  }
  return out;
}

// ───────────────────────────── Skaner (runner) ──────────────────────────────

const DETECTORS = [
  detectDuplicateTransactions, detectDuplicatePayments, detectMissingDocuments, detectUnusualAmounts,
  detectMiscategorization, detectDateIssues, detectIntegrityIssues, detectReceivables, detectPayables,
  detectInventory, detectSupplierActivity, detectExpenseGrowth, detectMarginAnomalies, detectReconciliation,
  detectTaxIssues, detectCashflowRisk, detectProcessIssues, detectPartyLimits,
];

function stateKey(companyId, issue) {
  const entityId = issue.entity.ids && issue.entity.ids.length ? issue.entity.ids.slice().sort().join(',') : issue.entity.id;
  return `${companyId}:${issue.code}:${entityId}`;
}

function scan(companyId, { from, to, force = false } = {}, user = null) {
  const range = { from: from || U.periodStart(U.currentPeriod()), to: to || U.periodEnd(U.currentPeriod()) };
  const ctx = { ...range, companyId };
  // Ma'lumot yo'q kompaniya uchun soxta topilmalar ko'rsatilmaydi (halol bo'sh holat)
  const hasAnyData = store.collection('entries').some(e => e.company_id === companyId)
    || store.collection('invoices').some(i => i.company_id === companyId)
    || store.collection('bills').some(b => b.company_id === companyId)
    || store.collection('products').some(p => p.company_id === companyId)
    || store.collection('documents').some(d => d.company_id === companyId)
    || store.collection('bankRows').some(r => r.company_id === companyId);
  if (!hasAnyData) {
    return {
      summary: {
        total: 0, critical: 0, high: 0, medium: 0, low: 0, financial_impact: 0, by_category: [],
        resolved_last_30_days: 0, detector_errors: [], scanned_at: store.nowISO(), range, no_data: true,
      },
      issues: [],
    };
  }
  const detected = [];
  const errors = [];
  for (const detector of DETECTORS) {
    try {
      const issues = detector(companyId, ctx) || [];
      for (const i of issues) detected.push(i);
    } catch (e) {
      errors.push({ detector: detector.name, message: e.message });
      console.error(`[radar] ${detector.name}:`, e.message);
    }
  }
  const states = store.collection('radarStates').filter(s => s.company_id === companyId);
  const now = store.nowISO();
  const out = [];
  const seen = new Set();
  for (const issue of detected) {
    const k = stateKey(companyId, issue);
    seen.add(k);
    let state = states.find(s => s.key === k);
    if (!state) {
      state = {
        id: store.uid('rad'), key: k, company_id: companyId, code: issue.code,
        entity_id: issue.entity.id, status: 'open', first_seen: now, last_seen: now,
        seen_count: 1, impact: issue.impact, title: issue.title,
      };
      store.collection('radarStates').push(state);
    } else {
      state.last_seen = now;
      state.seen_count = (state.seen_count || 1) + 1;
      state.impact = issue.impact;
      state.title = issue.title;
      if (state.status === 'resolved') state.status = 'open'; // muammo qaytdi
    }
    if (state.status === 'ignored') {
      const until = state.ignored_until ? new Date(state.ignored_until).getTime() : null;
      if (until && until < Date.now()) state.status = 'open';
      else continue; // e'tiborsiz qoldirilganlar ro'yxatga chiqmaydi
    }
    out.push({
      ...issue,
      id: k,
      severity_label: SEVERITY_LABELS[issue.severity],
      confidence_label: CONFIDENCE_LABEL(issue.confidence),
      detected_at: state.first_seen,
      last_seen: state.last_seen,
      seen_count: state.seen_count,
      status: 'open',
      ignored_until: state.ignored_until || null,
    });
  }
  // Hal bo'lganlar: avval ochiq bo'lgan, endi topilmagan
  for (const state of states) {
    if (state.status === 'open' && !seen.has(state.key)) {
      state.status = 'resolved';
      state.resolved_at = now;
      state.resolved_note = 'Avtomatik: muammo aniqlanmayapti';
    }
  }
  store.save();
  const sorted = out.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (b.confidence - a.confidence) || (b.impact - a.impact));
  const summary = {
    total: sorted.length,
    critical: sorted.filter(i => i.severity === 'critical').length,
    high: sorted.filter(i => i.severity === 'high').length,
    medium: sorted.filter(i => i.severity === 'medium').length,
    low: sorted.filter(i => i.severity === 'low').length,
    financial_impact: U.sumBy(sorted, i => i.impact || 0),
    by_category: [...U.groupBy(sorted, i => i.category).entries()].map(([category, items]) => ({
      category, label: CATEGORY_LABELS[category] || category, count: items.length,
      high: items.filter(i => i.severity === 'high' || i.severity === 'critical').length,
      impact: U.sumBy(items, i => i.impact || 0),
    })).sort((a, b) => b.count - a.count),
    resolved_last_30_days: states.filter(s => s.status === 'resolved' && s.resolved_at && s.resolved_at > U.addDays(U.today(), -30)).length,
    detector_errors: errors,
    scanned_at: now,
    range,
  };
  if (user) require('./audit').log({ company_id: companyId, user, action: 'radar.scan', entity: 'radar', entity_id: null, summary: `Xato Radar skanerlandi: ${summary.total} ta topilma (${summary.critical + summary.high} ta muhim)`, after: { total: summary.total, impact: summary.financial_impact } });
  return { summary, issues: sorted };
}

const CATEGORY_LABELS = {
  duplicates: 'Dublikatlar',
  documents: 'Hujjatlar',
  anomalies: 'Anomaliyalar',
  categorization: 'Tasniflash',
  dates: 'Sanalar',
  integrity: 'Hisob yaxlitligi',
  receivables: 'Debitorlik',
  payables: 'Kreditorlik',
  inventory: 'Ombor',
  suppliers: 'Yetkazib beruvchilar',
  expenses: 'Xarajatlar',
  margin: 'Marja',
  reconciliation: 'Solishtirish',
  tax: 'Soliqlar',
  cashflow: 'Pul oqimi',
  process: 'Jarayonlar',
};

/** Keshlangan skaner (bir necha soniya ichida qayta hisoblamaslik uchun) */
const cache = new Map();
function scanCached(companyId, range, ttlMs = 10000) {
  const key = `${companyId}:${range.from}:${range.to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = scan(companyId, range);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return value;
}
function invalidate(companyId) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${companyId}:`)) cache.delete(k);
}

function list(companyId, { severity, category, search, from, to, status = 'open' } = {}) {
  const { summary, issues } = scanCached(companyId, { from, to });
  let rows = issues;
  if (severity && severity !== 'all') rows = rows.filter(i => i.severity === severity);
  if (category && category !== 'all') rows = rows.filter(i => i.category === category);
  if (search) { const q = U.norm(search); rows = rows.filter(i => U.norm(`${i.title} ${i.what} ${i.why} ${i.recommendation}`).includes(q)); }
  const ignored = store.collection('radarStates').filter(s => s.company_id === companyId && s.status === 'ignored');
  return {
    summary,
    issues: rows,
    ignored: status === 'ignored' || status === 'all'
      ? ignored.map(s => ({ id: s.key, code: s.code, title: s.title, ignored_until: s.ignored_until, ignored_reason: s.ignored_reason, impact: s.impact }))
      : undefined,
  };
}

function get(companyId, id) {
  const wide = { from: U.periodStart(U.addMonths(U.currentPeriod(), -12)), to: U.periodEnd(U.addMonths(U.currentPeriod(), 3)) };
  let all = scanCached(companyId, wide);
  let issue = all.issues.find(i => i.id === id);
  if (!issue) {
    // Kesh eskirgan bo'lishi mumkin — to'g'ridan-to'g'ri qayta skanerlaymiz
    invalidate(companyId);
    all = scan(companyId, wide);
    issue = all.issues.find(i => i.id === id);
  }
  if (!issue) {
    const state = store.collection('radarStates').find(s => s.company_id === companyId && s.key === id);
    if (state && state.status === 'resolved') return { ...state, resolved: true };
    throw new ApiError('Topilma yangilangan — u allaqachon hal qilingan yoki mavjud emas.', 404, 'issue_not_found');
  }
  return issue;
}

function ignore(companyId, id, { reason = '', days = 30 } = {}, user) {
  const state = store.collection('radarStates').find(s => s.company_id === companyId && s.key === id);
  if (!state) throw new ApiError('Topilma topilmadi.', 404, 'not_found');
  state.status = 'ignored';
  state.ignored_reason = U.str(reason, { max: 300 });
  state.ignored_by = user ? user.id : null;
  state.ignored_at = store.nowISO();
  state.ignored_until = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
  store.save();
  invalidate(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'radar.ignore', entity: 'radar', entity_id: id, summary: `Xato Radar topilmasi e’tiborsiz qoldirildi: ${state.title}${reason ? ` — ${reason}` : ''}`, after: { until: state.ignored_until } });
  return state;
}

function resolve(companyId, id, { note = '' } = {}, user) {
  const state = store.collection('radarStates').find(s => s.company_id === companyId && s.key === id);
  if (!state) throw new ApiError('Topilma topilmadi.', 404, 'not_found');
  state.status = 'resolved';
  state.resolved_at = store.nowISO();
  state.resolved_by = user ? user.id : null;
  state.resolved_note = U.str(note, { max: 300 }) || 'Buxgalter tomonidan hal qilindi';
  store.save();
  invalidate(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'radar.resolve', entity: 'radar', entity_id: id, summary: `Xato Radar topilmasi hal qilindi: ${state.title}`, after: { note: state.resolved_note } });
  return state;
}

/**
 * Tuzatishni qo'llash. Xavfli amallar (masalan yozuvni bekor qilish) darhol bajarilmaydi:
 * direktor tasdig'i so'raladi (Approval Center).
 */
function applyFix(companyId, id, { confirm = false, reason = '' } = {}, user, { meta = {} } = {}) {
  const issue = get(companyId, id);
  if (!confirm) {
    return {
      requires_confirmation: true,
      message: `«${issue.fix.label}» amalini bajarish uchun tasdiqlash kerak.`,
      what_will_change: describeFix(companyId, issue),
      fix: issue.fix,
    };
  }
  if (issue.fix.type === 'review' || issue.fix.type.startsWith('open_')) {
    return { executed: false, navigation: true, message: 'Bu amal faqat tegishli bo‘limni ochadi — hech narsa o‘zgartirilmadi.', link: navigationFor(issue) };
  }
  if (issue.fix.type === 'reverse_entry') {
    const entryId = issue.fix.entry_id || issue.fix.params.entry_id;
    const entry = ledger.findEntry(companyId, entryId);
    if (!entry) throw new ApiError('Yozuv topilmadi (u allaqachon bekor qilingan bo‘lishi mumkin).', 404, 'not_found');
    const role = require('./auth').roleInCompany(user, companyId) || user.role;
    const canDirect = user.is_platform_admin || ['director', 'superadmin'].includes(role);
    if (!canDirect) {
      const approval = require('./approvals').create(companyId, {
        type: 'radar_fix', entity_id: issue.id,
        title: `Yozuvni bekor qilish: ${entry.no}`,
        summary: `${issue.title}. ${issue.what}`,
        amount: issue.impact,
        requested_by: user,
        payload: { issue_id: issue.id, fix: issue.fix },
        impact: `Jurnalga teskari yozuv kiritiladi va ${entry.no} bekor qilinadi (${U.fmtMoney(U.sumBy(entry.lines, l => l.debit))}).`,
      });
      return { executed: false, approval_required: true, approval_id: approval.id, message: 'So‘rov tasdiqlashga yuborildi (Approval Center). Direktor tasdiqlagach amal bajariladi.' };
    }
    const result = require('./transactions').reverse(companyId, entryId, user, reason || 'Xato Radar tavsiyasi', meta);
    return { executed: true, message: `Yozuv bekor qilindi: ${result.reversal.no} teskari yozuvi yaratildi.`, reversal: result.reversal };
  }
  throw new ApiError('Bu turdagi tuzatish avtomatik bajarilmaydi — tegishli bo‘limda qo‘lda bajaring.', 400, 'manual_fix_required');
}

function describeFix(companyId, issue) {
  switch (issue.fix.type) {
    case 'reverse_entry': {
      const entry = issue.fix.entry_id ? ledger.findEntry(companyId, issue.fix.entry_id) : null;
      return entry
        ? [`${entry.no} (${entry.date}) yozuvi bekor qilinadi`, `Teskari yozuv kiritiladi: ${U.fmtMoney(U.sumBy(entry.lines, l => l.debit))}`, 'Yozuv tarixdan o‘chirilmaydi (audit saqlanadi)']
        : ['Yozuv bekor qilinadi'];
    }
    case 'adjust_stock':
      return ['Ombordagi qoldiq inventarizatsiya natijasiga moslashtiriladi', 'Farq bo‘yicha tuzatish yozuvi kiritiladi'];
    default:
      return ['Hech narsa o‘zgartirilmaydi — faqat ko‘rish uchun bo‘lim ochiladi'];
  }
}
function navigationFor(issue) {
  const p = issue.fix.params || {};
  switch (issue.fix.type) {
    case 'review_account': return { page: 'transactions', params: { account: p.account } };
    case 'open_reconciliation': return { page: 'reconciliation', params: { account: p.account } };
    case 'open_payables': return { page: 'payables', params: {} };
    case 'open_receivables': return { page: 'receivables', params: {} };
    case 'open_inventory': return { page: 'inventory', params: p };
    case 'open_documents': return { page: 'documents', params: {} };
    case 'open_payments': return { page: 'payments', params: {} };
    case 'open_tax': return { page: 'tax', params: {} };
    case 'open_forecast': return { page: 'cashflow', params: {} };
    case 'open_approvals': return { page: 'approvals', params: {} };
    case 'open_party': return { page: 'parties', params: { party_id: p.party_id } };
    case 'open_advisor': return { page: 'advisor', params: {} };
    case 'review_invoice': return { page: 'invoices', params: { id: p.invoice_id } };
    case 'review_entry': return { page: 'transactions', params: { id: p.entry_id } };
    case 'review_report': return { page: 'reports', params: { report: p.report } };
    default: return { page: 'radar', params: {} };
  }
}

function counts(companyId) {
  const { summary, issues } = scanCached(companyId, { from: U.periodStart(U.addMonths(U.currentPeriod(), -3)), to: U.periodEnd(U.currentPeriod()) });
  return {
    total: summary.total,
    critical: summary.critical,
    high: summary.high,
    impact: summary.financial_impact,
    top: issues.slice(0, 5).map(i => ({ id: i.id, title: i.title, severity: i.severity, what: i.what, impact: i.impact, fix: i.fix })),
  };
}

module.exports = {
  SEVERITY_LABELS, CATEGORY_LABELS, DETECTORS, scan, scanCached, invalidate, list, get, ignore, resolve, applyFix, counts, navigationFor,
};
