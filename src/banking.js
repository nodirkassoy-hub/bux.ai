'use strict';
/**
 * BUXAI — Bank va kassa boshqaruvi + aqlli reconciliation (solishtirish).
 * Solishtirish hech qachon avtomatik o'zgartirmaydi: har bir moslikni buxgalter tasdiqlaydi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const parsers = require('./parsers');
const { ApiError } = U;

function accountsOf(companyId) {
  return ledger.accountsOf(companyId).filter(a => a.is_cash || a.is_bank).map(a => ({
    ...a,
    balance: ledger.balanceOf(companyId, a.code),
    kind_label: a.is_cash ? 'Kassa' : 'Bank hisobi',
  }));
}

function accountDetail(companyId, code, { from, to } = {}) {
  const acc = ledger.getAccount(companyId, code);
  if (!acc.is_cash && !acc.is_bank) throw new ApiError('Bu hisob kassa yoki bank hisobi emas.', 400, 'invalid_account');
  const range = { from: from || U.periodStart(U.currentPeriod()), to: to || U.periodEnd(U.currentPeriod()) };
  const mv = ledger.accountMovements(companyId, { from: range.from, to: range.to, codes: [code] });
  const row = mv.get(code);
  const rows = [];
  for (const e of ledger.entries(companyId, { from: range.from, to: range.to })) {
    for (const l of e.lines) {
      if (l.account !== code) continue;
      const contra = e.lines.filter(x => x !== l);
      rows.push({
        entry_id: e.id, no: e.no, date: e.date, memo: l.description || e.memo, ref: e.ref,
        debit: l.debit, credit: l.credit, amount: l.debit - l.credit,
        contra: contra.map(c => `${c.account} ${(ledger.tryAccount(companyId, c.account) || {}).name || ''}`).join(' • '),
        party_id: l.party_id || contra[0]?.party_id || null, source: e.source,
      });
    }
  }
  const imports = store.collection('bankImports').filter(i => i.company_id === companyId && i.account === code && i.period_start === range.from);
  return {
    account: { ...acc, balance: ledger.balanceOf(companyId, code) },
    range, opening: row ? row.opening : 0, incoming: row ? row.debit : 0, outgoing: row ? row.credit : 0,
    closing: row ? row.closing : 0,
    rows: U.sortBy(rows, r => r.date, 'desc'),
    imports,
  };
}

/** Yangi kassa/bank hisobini yaratish */
function createAccount(companyId, input, user) {
  const isCash = input.type === 'cash';
  const name = U.str(input.name, { max: 120, required: true, field: 'Hisob nomi' });
  const code = U.str(input.code || '', { max: 10 }) || nextAccountCode(companyId, isCash);
  if (ledger.tryAccount(companyId, code)) throw new ApiError(`«${code}» kodi bilan hisob allaqachon mavjud.`, 409, 'duplicate_code');
  const acc = {
    id: store.uid('acc'), company_id: companyId, code, name,
    type: 'asset', subtype: isCash ? 'cash' : 'bank', role: isCash ? 'cash' : 'bank',
    normal: 'debit', is_cash: isCash, is_bank: !isCash,
    is_system: false, active: true, currency: 'UZS',
    bank_name: U.str(input.bank_name || '', { max: 120 }),
    mfo: U.str(input.mfo || '', { max: 10 }),
    account_number: U.str(input.account_number || '', { max: 30 }),
    created_at: store.nowISO(), created_by: user ? user.id : null,
  };
  if (acc.mfo && !U.isMFO(acc.mfo)) throw new ApiError('MFO 5 raqamdan iborat bo‘lishi kerak.', 400, 'invalid_mfo');
  if (acc.account_number && !U.isBankAccount(acc.account_number)) throw new ApiError('Hisob raqami 20 raqamdan iborat bo‘lishi kerak.', 400, 'invalid_account');
  store.collection('accounts').push(acc);
  const opening = U.amount(input.opening_balance || 0);
  if (opening > 0) {
    ledger.postEntry(companyId, {
      date: U.isValidDate(input.opening_date) ? input.opening_date : U.today(),
      memo: `${name} — boshlang‘ich qoldiq`, ref: 'OPENING',
      lines: [
        { account: code, debit: opening, description: 'Boshlang‘ich qoldiq' },
        { account: ledger.roleCode(companyId, 'equity'), credit: opening, description: 'Boshlang‘ich qoldiq (kapital)' },
      ],
      source: { type: 'opening_balance', id: null }, user,
    });
  }
  store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'bank_account.create', entity: 'account', entity_id: acc.id, summary: `Yangi ${isCash ? 'kassa' : 'bank'} hisobi: ${code} ${name}`, after: acc });
  return { ...acc, balance: ledger.balanceOf(companyId, code) };
}
function nextAccountCode(companyId, isCash) {
  const base = isCash ? 510 : 520;
  const codes = ledger.accountsOf(companyId).map(a => Number(a.code)).filter(n => Number.isFinite(n));
  let code = base;
  while (codes.includes(code)) code += 10;
  return String(code).padStart(4, '0');
}

function updateAccount(companyId, id, patch, user) {
  const acc = ledger.accountsOf(companyId).find(a => a.id === id);
  if (!acc) throw new ApiError('Hisob topilmadi.', 404, 'not_found');
  const before = { ...acc };
  if (patch.name !== undefined) acc.name = U.str(patch.name, { max: 120, required: true, field: 'Hisob nomi' });
  for (const f of ['bank_name', 'mfo', 'account_number']) if (patch[f] !== undefined) acc[f] = U.str(patch[f], { max: 120 });
  if (patch.active !== undefined) {
    if (patch.active === false) {
      const bal = ledger.balanceOf(companyId, acc.code);
      if (Math.abs(bal) > 0.5) throw new ApiError(`Hisobda qoldiq bor (${U.fmtMoney(bal)}) — qoldiqni boshqa hisobga o‘tkazing yoki hisobni arxivlang.`, 409, 'has_balance', { balance: bal });
    }
    acc.active = !!patch.active;
  }
  store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'bank_account.update', entity: 'account', entity_id: id, summary: `Hisob tahrirlandi: ${acc.code} ${acc.name}`, before, after: { ...acc } });
  return { ...acc, balance: ledger.balanceOf(companyId, acc.code) };
}

// ─────────────────────────── Bank ko'chirmasi importi ───────────────────────

function importStatement(companyId, { account, filename, format, content, buffer, period_start, period_end }, user, { meta = {} } = {}) {
  require('./companies').checkLimit(companyId, 'bank_import');
  const acc = ledger.getAccount(companyId, account);
  if (!acc.is_bank && !acc.is_cash) throw new ApiError('Import faqat kassa/bank hisoblari uchun.', 400, 'invalid_account');
  const parsed = parsers.parseBankStatement({ content, buffer, filename, format });
  const rows = parsed.rows;
  const dates = rows.map(r => r.date).sort();
  const start = period_start || dates[0];
  const end = period_end || dates[dates.length - 1];
  const imp = {
    id: store.uid('bim'), company_id: companyId, account, filename: U.str(filename || 'ko‘chirma', { max: 200 }),
    format: format || 'csv', rows_count: rows.length,
    period_start: start, period_end: end,
    total_in: U.sumBy(rows.filter(r => r.direction === 'in'), r => r.amount),
    total_out: U.sumBy(rows.filter(r => r.direction === 'out'), r => r.amount),
    warnings: parsed.warnings, columns: parsed.columns,
    imported_by: user ? user.id : null, created_at: store.nowISO(),
    status: 'imported',
  };
  store.collection('bankImports').push(imp);

  const created = [];
  for (const r of rows) {
    // Ichki dublikat: shu ko'chirmada bir xil sana/summa/yo'nalish
    const dup = store.collection('bankRows').find(x =>
      x.company_id === companyId && x.account === account && x.date === r.date &&
      x.amount === r.amount && x.direction === r.direction && x.status !== 'ignored') ||
      created.find(x => x.date === r.date && x.amount === r.amount && x.direction === r.direction);
    const row = {
      id: store.uid('brw'), company_id: companyId, import_id: imp.id, account,
      date: r.date, amount: r.amount, direction: r.direction,
      description: r.description, counterparty: r.counterparty, reference: r.reference, balance: r.balance,
      raw: r.raw, line: r.line,
      status: 'unmatched', match: null, note: null, duplicate_hint: !!dup,
      created_at: store.nowISO(),
    };
    store.collection('bankRows').push(row);
    created.push(row);
  }
  store.save();
  store.touch(companyId);
  require('./companies').bump(companyId, 'transaction', created.length);
  require('./audit').log({
    company_id: companyId, user, action: 'bank.import', entity: 'bank_import', entity_id: imp.id,
    summary: `Bank ko‘chirmasi yuklandi: ${imp.filename} — ${created.length} qator (${U.periodLabel(U.periodOf(start))})`,
    after: { rows: created.length, total_in: imp.total_in, total_out: imp.total_out }, meta,
  });
  return { import: imp, rows: created.length, warnings: parsed.warnings, preview: created.slice(0, 20) };
}

function importsList(companyId, { account, limit = 30 } = {}) {
  let rows = store.collection('bankImports').filter(i => i.company_id === companyId);
  if (account) rows = rows.filter(i => i.account === account);
  return U.sortBy(rows, i => i.created_at, 'desc').slice(0, limit).map(i => ({
    ...i,
    matched: store.collection('bankRows').filter(r => r.import_id === i.id && r.status === 'matched').length,
    unmatched: store.collection('bankRows').filter(r => r.import_id === i.id && r.status === 'unmatched').length,
    ignored: store.collection('bankRows').filter(r => r.import_id === i.id && r.status === 'ignored').length,
    created_entries: store.collection('bankRows').filter(r => r.import_id === i.id && r.status === 'created').length,
  }));
}

function deleteImport(companyId, importId, user) {
  const imp = store.collection('bankImports').find(i => i.id === importId && i.company_id === companyId);
  if (!imp) throw new ApiError('Import topilmadi.', 404, 'not_found');
  const linked = store.collection('bankRows').filter(r => r.import_id === importId && ['created'].includes(r.status));
  const col = store.collection('bankRows');
  for (let i = col.length - 1; i >= 0; i--) if (col[i].import_id === importId) col.splice(i, 1);
  store.collection('bankImports').splice(store.collection('bankImports').indexOf(imp), 1);
  store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'bank.import_delete', entity: 'bank_import', entity_id: importId, summary: `Bank ko‘chirmasi importi o‘chirildi: ${imp.filename}`, before: imp, after: { linked_entries: linked.length } });
  return { deleted: true, linked_entries_kept: linked.length };
}

// ───────────────────────── Solishtirish (reconciliation) ────────────────────

/** Moslik ishonchliligini hisoblash 0..99 */
function scoreCandidate(row, entryLine, entry) {
  const amountDiff = Math.abs(row.amount - entryLine.amount);
  const rel = amountDiff / Math.max(1, row.amount);
  let score = 0;
  if (amountDiff === 0) score += 55;
  else if (rel <= 0.005) score += 45;
  else if (rel <= 0.02) score += 30;
  else if (rel <= 0.05) score += 12;
  else score -= 20;
  const dateDiff = Math.abs(U.daysBetween(row.date, entry.date));
  if (dateDiff === 0) score += 25; else if (dateDiff === 1) score += 20; else if (dateDiff <= 3) score += 14; else if (dateDiff <= 7) score += 8; else if (dateDiff <= 14) score += 3;
  const text = `${row.description} ${row.counterparty} ${row.reference}`;
  const sim = Math.max(U.similarity(text, entry.memo), U.similarity(text, entryLine.description || ''), U.similarity(text, entry.ref || ''));
  score += Math.round(sim * 18);
  if (row.reference && entry.ref && U.norm(row.reference) === U.norm(entry.ref)) score += 6;
  const party = row.counterparty ? store.collection('parties').find(p => p.id === entryLine.party_id) : null;
  if (party && row.counterparty && U.similarity(row.counterparty, party.name) > 0.5) score += 8;
  return U.clamp(Math.round(score), 1, 99);
}

function candidateEntries(companyId, row) {
  const from = U.addDays(row.date, -14), to = U.addDays(row.date, 14);
  const lines = [];
  for (const e of ledger.entries(companyId, { from, to })) {
    for (const l of e.lines) {
      if (l.account !== row.account) continue;
      const amount = l.debit - l.credit; // kassa/bank uchun: + kirim, − chiqim
      const direction = amount >= 0 ? 'in' : 'out';
      if (direction !== row.direction && Math.abs(amount) !== row.amount) continue;
      const abs = Math.abs(amount);
      if (abs > 0 && row.amount / abs > 1.2 && row.amount / abs < 0.8) continue;
      const confidence = scoreCandidate(row, { ...l, amount: abs }, e);
      const contra = e.lines.filter(x => x !== l);
      lines.push({
        entry_id: e.id, entry_no: e.no, line_account: l.account, entry_date: e.date, memo: e.memo, ref: e.ref,
        amount: abs, direction, confidence,
        match_type: direction === row.direction ? 'same_direction' : 'opposite_direction',
        counterparty: contra.map(c => {
          const p = c.party_id ? store.collection('parties').find(x => x.id === c.party_id) : null;
          return p ? p.name : `${c.account} ${(ledger.tryAccount(companyId, c.account) || {}).name || ''}`;
        }).join(' • '),
        source: e.source, created_by: e.created_by,
      });
    }
  }
  // allaqachon bog'langan yozuvlarni belgilash
  const used = new Set(store.collection('bankRows').filter(r => r.company_id === companyId && r.status === 'matched' && r.match && r.match.entry_id !== null).map(r => r.match.entry_id));
  for (const c of lines) c.already_matched = used.has(c.entry_id);
  return lines.sort((a, b) => b.confidence - a.confidence).slice(0, 8);
}

function rowCandidates(companyId, rowId) {
  const row = store.collection('bankRows').find(r => r.id === rowId && r.company_id === companyId);
  if (!row) throw new ApiError('Ko‘chirma qatori topilmadi.', 404, 'not_found');
  return { row, candidates: candidateEntries(companyId, row) };
}

/**
 * Solishtirish holati: mos kelgan, ehtimoliy, past ishonch, yo'q, dublikat.
 * Bu funksiya hech narsani o'zgartirmaydi — faqat tahlil.
 */
function reconcile(companyId, { account, import_id, from, to } = {}) {
  const acc = account ? ledger.getAccount(companyId, account) : null;
  let rows = store.collection('bankRows').filter(r => r.company_id === companyId);
  if (account) rows = rows.filter(r => r.account === account);
  if (import_id) rows = rows.filter(r => r.import_id === import_id);
  if (from) rows = rows.filter(r => r.date >= from);
  if (to) rows = rows.filter(r => r.date <= to);

  const out = rows.map(row => {
    if (row.status === 'matched' || row.status === 'ignored' || row.status === 'created') return { ...row, candidates: [] };
    const candidates = candidateEntries(companyId, row);
    const dupeRows = rows.filter(x => x.id !== row.id && x.date === row.date && x.amount === row.amount && x.direction === row.direction && x.status !== 'ignored');
    return {
      ...row,
      candidates,
      best: candidates.find(c => !c.already_matched) || candidates[0] || null,
      duplicate_hint: row.duplicate_hint || dupeRows.length > 0,
      duplicate_of: dupeRows.map(d => ({ id: d.id, date: d.date, description: d.description, status: d.status })),
    };
  });

  const matched = out.filter(r => r.status === 'matched');
  const ignored = out.filter(r => r.status === 'ignored' || r.status === 'created');
  const unmatched = out.filter(r => r.status === 'unmatched');
  const exact = unmatched.filter(r => r.best && r.best.confidence >= 85 && !r.best.already_matched);
  const possible = unmatched.filter(r => r.best && r.best.confidence >= 60 && r.best.confidence < 85 && !r.best.already_matched);
  const low = unmatched.filter(r => r.best && r.best.confidence < 60);
  const none = unmatched.filter(r => !r.best);
  const duplicates = unmatched.filter(r => r.duplicate_hint);

  // Ko'chirmada yo'q, lekin buxgalteriyada bor yozuvlar (davr bo'yicha)
  const period = from && to ? { from, to } : null;
  const missing = [];
  if (acc && period) {
    for (const e of ledger.entries(companyId, period)) {
      for (const l of e.lines) {
        if (l.account !== acc.code) continue;
        const linked = store.collection('bankRows').some(r => r.company_id === companyId && r.status !== 'ignored' && r.match && r.match.entry_id === e.id);
        if (!linked) {
          missing.push({
            entry_id: e.id, entry_no: e.no, date: e.date, amount: Math.abs(l.debit - l.credit),
            direction: l.debit > l.credit ? 'in' : 'out', memo: e.memo, source: e.source,
          });
        }
      }
    }
  }

  const bookBalance = acc ? ledger.balanceOf(companyId, acc.code) : null;
  const stmtLastBalance = U.sortBy(rows.filter(r => r.balance != null), r => r.date, 'desc')[0];
  return {
    account: acc ? { ...acc, balance: bookBalance } : null,
    summary: {
      total_rows: out.length,
      matched: matched.length,
      created: out.filter(r => r.status === 'created').length,
      ignored: ignored.length,
      unmatched: unmatched.length,
      exact: exact.length, possible: possible.length, low: low.length, none: none.length,
      duplicates: duplicates.length,
      missing_in_statement: missing.length,
    },
    rows: U.sortBy(out, r => r.date, 'desc'),
    buckets: {
      exact: exact.slice(0, 50),
      possible: possible.slice(0, 50),
      low: low.slice(0, 50),
      none: none.slice(0, 50),
      duplicates: duplicates.slice(0, 50),
      missing: missing.slice(0, 50),
    },
    statement_last_balance: stmtLastBalance ? stmtLastBalance.balance : null,
    book_balance: bookBalance,
    difference: stmtLastBalance && bookBalance != null ? U.round(stmtLastBalance.balance - bookBalance, 0) : null,
    imports: importsList(companyId, { account }),
  };
}

function acceptMatch(companyId, rowId, entryId, user, { meta = {} } = {}) {
  const row = store.collection('bankRows').find(r => r.id === rowId && r.company_id === companyId);
  if (!row) throw new ApiError('Ko‘chirma qatori topilmadi.', 404, 'not_found');
  const entry = ledger.findEntry(companyId, entryId);
  if (!entry) throw new ApiError('Jurnal yozuvi topilmadi.', 404, 'entry_not_found');
  const line = entry.lines.find(l => l.account === row.account);
  if (!line) throw new ApiError('Tanlangan yozuv bu hisobga tegishli emas.', 422, 'account_mismatch');
  const already = store.collection('bankRows').find(r => r.company_id === companyId && r.id !== rowId && r.status === 'matched' && r.match && r.match.entry_id === entryId);
  if (already) throw new ApiError(`Bu yozuv allaqachon boshqa ko‘chirma qatoriga bog‘langan (${already.date}, ${U.fmtMoney(already.amount)}).`, 409, 'already_matched');
  row.status = 'matched';
  row.match = { entry_id: entryId, entry_no: entry.no, confidence: null, matched_by: user ? user.id : null, matched_at: store.nowISO(), manual: true };
  row.note = null;
  store.save();
  store.touch(companyId);
  require('./audit').log({
    company_id: companyId, user, action: 'reconciliation.accept', entity: 'bank_row', entity_id: rowId,
    summary: `Solishtirish qabul qilindi: ${row.date} ${U.fmtMoney(row.amount)} ↔ ${entry.no}`, after: { row: { date: row.date, amount: row.amount }, entry: entry.no }, meta,
  });
  return { row, entry: { id: entry.id, no: entry.no, date: entry.date, memo: entry.memo } };
}

function rejectMatch(companyId, rowId, user, reason = '') {
  const row = store.collection('bankRows').find(r => r.id === rowId && r.company_id === companyId);
  if (!row) throw new ApiError('Qator topilmadi.', 404, 'not_found');
  const before = { status: row.status, match: row.match };
  row.status = 'unmatched';
  row.match = null;
  row.note = U.str(reason || 'Moslik rad etildi', { max: 300 });
  store.save();
  store.touch(companyId);
  require('./audit').log({ company_id: companyId, user, action: 'reconciliation.reject', entity: 'bank_row', entity_id: rowId, summary: `Moslik rad etildi: ${row.date} ${U.fmtMoney(row.amount)}${reason ? ` — ${reason}` : ''}`, before, after: { status: 'unmatched' } });
  return row;
}

function ignoreRow(companyId, rowId, user, reason = '') {
  const row = store.collection('bankRows').find(r => r.id === rowId && r.company_id === companyId);
  if (!row) throw new ApiError('Qator topilmadi.', 404, 'not_found');
  row.status = 'ignored';
  row.note = U.str(reason || '', { max: 300 });
  row.ignored_at = store.nowISO();
  store.save();
  require('./audit').log({ company_id: companyId, user, action: 'reconciliation.ignore', entity: 'bank_row', entity_id: rowId, summary: `Ko‘chirma qatori e’tiborsiz qoldirildi: ${row.date} ${U.fmtMoney(row.amount)}` });
  return row;
}

/** Ko'chirma qatoridan operatsiya yaratish (faqat buxgalter tasdiqlagach) */
function createFromRow(companyId, rowId, payload, user, { meta = {} } = {}) {
  const row = store.collection('bankRows').find(r => r.id === rowId && r.company_id === companyId);
  if (!row) throw new ApiError('Qator topilmadi.', 404, 'not_found');
  if (row.status === 'matched' || row.status === 'created') throw new ApiError('Bu qator allaqachon bog‘langan.', 409, 'already_used');
  const txn = require('./transactions');
  const base = {
    type: payload.type || (row.direction === 'in' ? 'income' : 'expense'),
    amount: payload.amount != null ? payload.amount : row.amount,
    date: payload.date || row.date,
    description: U.str(payload.description || row.description || row.counterparty || 'Bank ko‘chirmasi', { max: 400, required: true, field: 'Izoh' }),
    account: row.account,
    category: payload.category,
    party_id: payload.party_id || null,
    method: 'bank',
    reference: payload.reference || row.reference || '',
    vat_rate: payload.vat_rate,
    tags: payload.tags || ['bank_import'],
  };
  if (base.type === 'journal' || base.type === 'adjustment') {
    base.lines = payload.lines;
    if (!Array.isArray(base.lines) || !base.lines.length) {
      throw new ApiError('Jurnal yozuvi uchun debet/kredit qatorlarini kiriting.', 400, 'missing_lines');
    }
  }
  const created = txn.create(companyId, { ...base, source: { type: 'bank_row', id: row.id } }, user, { meta });
  // Yaratilgan yozuvni qatorga bog'lash
  row.status = 'created';
  row.match = { entry_id: created.id, entry_no: created.no, confidence: 100, created: true, matched_by: user ? user.id : null, matched_at: store.nowISO() };
  store.save();
  store.touch(companyId);
  require('./audit').log({
    company_id: companyId, user, action: 'reconciliation.create_entry', entity: 'bank_row', entity_id: rowId,
    summary: `Ko‘chirma qatoridan operatsiya yaratildi: ${created.no} — ${U.fmtMoney(base.amount)}`, after: { entry: created.no }, meta,
  });
  return { row, transaction: created };
}

/** Kassa sanoqi: haqiqiy qoldiqni kiritish (farq tuzatish yozuvi bilan) */
function cashCount(companyId, { account, actual_amount, date, memo }, user, { meta = {} } = {}) {
  const acc = ledger.getAccount(companyId, account);
  if (!acc.is_cash) throw new ApiError('Kassa sanoqi faqat kassa hisobiga tegishli.', 400, 'invalid_account');
  const book = ledger.balanceOf(companyId, account);
  const actual = U.amount(actual_amount, 'Haqiqiy qoldiq');
  const diff = actual - book;
  if (diff === 0) return { account, book, actual, diff: 0, message: 'Kassa qoldig‘i to‘g‘ri — farq yo‘q.' };
  const entry = ledger.postEntry(companyId, {
    date: U.isValidDate(date) ? date : U.today(),
    memo: U.str(memo || `Kassa sanoqi: ${U.fmtMoney(book)} → ${U.fmtMoney(actual)}`, { max: 400 }),
    ref: 'CASH-COUNT',
    lines: diff > 0
      ? [{ account, debit: diff, description: 'Kassa sanoqi (kamomad topildi)' }, { account: ledger.roleCode(companyId, 'other_income'), credit: diff, description: 'Ortiqcha summa' }]
      : [{ account: ledger.roleCode(companyId, 'other_expense'), debit: -diff, description: 'Kamomad' }, { account, credit: -diff, description: 'Kassa sanoqi (kamomad)' }],
    source: { type: 'cash_count', id: null }, user,
  });
  require('./audit').log({
    company_id: companyId, user, action: 'cash.count', entity: 'account', entity_id: acc.id,
    summary: `Kassa sanoqi: kitob ${U.fmtMoney(book)} → haqiqiy ${U.fmtMoney(actual)} (farq ${U.fmtMoney(diff)})`,
    before: { balance: book }, after: { balance: actual, entry: entry.no }, meta,
  });
  return { account, book, actual, diff, entry: { id: entry.id, no: entry.no } };
}

module.exports = {
  accountsOf, accountDetail, createAccount, updateAccount,
  importStatement, importsList, deleteImport, reconcile, rowCandidates, candidateEntries,
  acceptMatch, rejectMatch, ignoreRow, createFromRow, cashCount, scoreCandidate,
};
