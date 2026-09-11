'use strict';
/**
 * BUXAI — Hujjat parserlari: CSV, Excel (XLSX), PDF (matn qatlami), OCR matni.
 * Tashqi kutubxonalarsiz ishlaydi. Har bir parser o'qiy olmagan format uchun
 * ANIQ xabar qaytaradi (yolg'on "muvaffaqiyat" yo'q).
 */
const zlib = require('zlib');
const U = require('./util');
const { ApiError } = U;

// ───────────────────────────────── CSV ─────────────────────────────────────

function detectDelimiter(line) {
  const candidates = [';', ',', '\t', '|'];
  let best = ',', bestCount = 0;
  for (const c of candidates) {
    const count = (line.match(new RegExp(`\\${c}`, 'g')) || []).length;
    if (count > bestCount) { best = c; bestCount = count; }
  }
  return best;
}

/** CSV matnini qatorlarga ajratish (qo'shtirnoq ichidagi ajratuvchilarni hisobga oladi) */
function parseCSV(text) {
  const clean = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n').filter(l => l.trim() !== '');
  if (!lines.length) return { rows: [], headers: [] };
  const delimiter = detectDelimiter(lines[0]);
  const rows = lines.map(line => splitLine(line, delimiter));
  return { rows, headers: rows[0] || [], delimiter };
}

function splitLine(line, delimiter) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// ──────────────────────────────── Excel (XLSX) ──────────────────────────────

/** ZIP ichidan faylni o'qish (deflate yoki stored) */
function unzipEntry(buffer, wantedName) {
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let offset = 0;
  while (offset < buffer.length - 4) {
    const idx = buffer.indexOf(sig, offset);
    if (idx < 0) break;
    const method = buffer.readUInt16LE(idx + 8);
    const compSize = buffer.readUInt32LE(idx + 18);
    const nameLen = buffer.readUInt16LE(idx + 26);
    const extraLen = buffer.readUInt16LE(idx + 28);
    const name = buffer.slice(idx + 30, idx + 30 + nameLen).toString('utf8');
    let dataStart = idx + 30 + nameLen + extraLen;
    let size = compSize;
    if (compSize === 0) { // data descriptor ishlatilgan (streaming) — keyingi signature'gacha olamiz
      const next = buffer.indexOf(sig, dataStart);
      size = (next > 0 ? next : buffer.length) - dataStart - 16;
      if (size < 0) size = 0;
    }
    if (name === wantedName) {
      const data = buffer.slice(dataStart, dataStart + size);
      if (method === 0) return data;
      if (method === 8) {
        try { return zlib.inflateRawSync(data); } catch (e) { throw new ApiError('Excel faylni ochishda xatolik (deflate).', 400, 'xlsx_error'); }
      }
      throw new ApiError('Excel fayl siqish usuli qo‘llab-quvvatlanmaydi.', 400, 'xlsx_error');
    }
    if (compSize === 0) break;
    offset = dataStart + size;
  }
  return null;
}

function colToIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || ''));
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Minimal XLSX o'quvchi: birinchi varaqni qatorlarga aylantiradi */
function parseXLSX(buffer) {
  const sheet = unzipEntry(buffer, 'xl/worksheets/sheet1.xml');
  if (!sheet) throw new ApiError('Excel faylda varaq topilmadi.', 400, 'xlsx_error');
  const sharedXml = unzipEntry(buffer, 'xl/sharedStrings.xml');
  const shared = [];
  if (sharedXml) {
    const xml = sharedXml.toString('utf8');
    for (const m of xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) {
      const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXml(t[1]));
      shared.push(texts.join(''));
    }
  }
  const xml = sheet.toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowIdx = Number(rm[1]) - 1;
    const cells = [];
    for (const cm of rm[2].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1];
      const refMatch = /r="([A-Z]+\d+)"/.exec(attrs);
      const colIdx = refMatch ? colToIndex(refMatch[1]) : cells.length;
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1];
      const vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cm[2]);
      const ism = /<is[^>]*>([\s\S]*?)<\/is>/.exec(cm[2]);
      let value = '';
      if (type === 's' && vm) value = shared[Number(vm[1])] ?? '';
      else if (type === 'inlineStr' && ism) value = [...ism[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXml(t[1])).join('');
      else if (vm) value = decodeXml(vm[1]);
      cells[colIdx] = String(value).trim();
    }
    if (rowIdx < 50000) rows[rowIdx] = cells.map(c => c === undefined ? '' : c);
  }
  const filled = rows.filter(Boolean);
  return { rows: filled, headers: filled[0] || [] };
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

// ───────────────────────────────── PDF ─────────────────────────────────────

/** PDF matn qatlamini olish (FlateDecode + Tj/TJ operatorlari). Skanerlangan PDF uchun ishlamaydi. */
function parsePDFText(buffer) {
  const chunks = [];
  const raw = buffer.toString('latin1');
  const streamRe = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    let content = Buffer.from(m[1], 'latin1');
    try {
      content = zlib.inflateSync(content);
    } catch (_) {
      try { content = zlib.inflateRawSync(Buffer.from(m[1], 'latin1')); }
      catch (__) { /* siqilmagan stream */ }
    }
    const text = content.toString('latin1');
    if (!/(Tj|TJ)/.test(text)) continue;
    chunks.push(text);
  }
  if (!chunks.length) return { lines: [], text: '' };
  const out = [];
  for (const chunk of chunks) {
    let current = '';
    const tokens = chunk.match(/\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]+>|\bTJ\b|\bTj\b|\bTd\b|\bTD\b|\bT\*\b|-?\d+(\.\d+)?/g) || [];
    for (const t of tokens) {
      if (t.startsWith('(')) {
        const lit = t.slice(1, -1).replace(/\\([()\\])/g, '$1').replace(/\\n/g, ' ');
        current += lit;
      } else if (/^<[0-9A-Fa-f\s]+>$/.test(t)) {
        const hex = t.slice(1, -1).replace(/\s/g, '');
        let s = '';
        for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        current += s;
      } else if (t === 'Td' || t === 'TD' || t === 'T*' || t === 'TJ') {
        if (current.trim()) out.push(current.trim());
        current = '';
      }
    }
    if (current.trim()) out.push(current.trim());
  }
  return { lines: out.filter(l => l.length), text: out.join('\n') };
}

// ─────────────────────── Jadvalli ma'lumotni tanish ─────────────────────────

const DATE_PATTERNS = [
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/,
  /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2})$/,
];

function parseAnyDate(s) {
  const str = String(s || '').trim();
  for (let i = 0; i < DATE_PATTERNS.length; i++) {
    const m = DATE_PATTERNS[i].exec(str);
    if (!m) continue;
    let [, a, b, c] = m;
    if (i === 0) return `${a}-${U.pad(b)}-${U.pad(c)}`;
    const year = c.length === 2 ? `20${c}` : c;
    // O'zbekiston formati: kun.oy.yil
    return `${year}-${U.pad(b)}-${U.pad(a)}`;
  }
  const parsed = Date.parse(str);
  if (!isNaN(parsed)) return U.isoDate(new Date(parsed));
  return null;
}

/** Summani tanish: "1 250 000,50", "1,250,000.50", "−1250", "(1250)" */
function parseAnyAmount(s) {
  if (typeof s === 'number') return s;
  let str = String(s == null ? '' : s).trim();
  if (!str) return null;
  let negative = false;
  if (/^\(.*\)$/.test(str)) { negative = true; str = str.slice(1, -1); }
  if (/^[-−–]/.test(str)) { negative = true; str = str.replace(/^[-−–]/, ''); }
  str = str.replace(/\s|\u00a0/g, '').replace(/(so'?m|soʻm|uzs|sum|₽|\$|usd|eur)/gi, '');
  // Vergul kasr ajratuvchimi yoki mingliklar?
  const lastComma = str.lastIndexOf(','), lastDot = str.lastIndexOf('.');
  if (lastComma > lastDot) str = str.replace(/\./g, '').replace(',', '.');
  else str = str.replace(/,/g, '');
  const n = Number(str.replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

const HEADER_HINTS = {
  date: ['sana', 'date', 'дата', 'kun', 'period', 'amal sanasi'],
  in: ['kirim', 'credit', 'inflow', 'prixod', 'приход', 'debet', 'qabul'],
  out: ['chiqim', 'debit', 'outflow', 'rasxod', 'расход', 'kredit', 'to‘lov', 'tolov'],
  amount: ['summa', 'amount', 'miqdor', 'sum', 'оборот', 'total'],
  balance: ['qoldiq', 'balance', 'saldo', 'ostatok'],
  description: ['izoh', 'tavsif', 'description', 'purpose', 'naznachenie', 'назначение', 'hisob', 'comment', 'commentaire'],
  counterparty: ['kontragent', 'tayin', 'mijoz', 'plati', 'payer', 'получатель', 'correspondent', 'name'],
  reference: ['hujjat', 'document', 'ref', 'doc', 'номер', 'shartnoma', 'invoice'],
};

function matchColumn(headers, key) {
  const hints = HEADER_HINTS[key] || [];
  for (let i = 0; i < headers.length; i++) {
    const h = U.norm(headers[i]);
    if (!h) continue;
    for (const hint of hints) if (h.includes(hint)) return i;
  }
  return -1;
}

/**
 * Bank ko'chirmasi qatorlarini tanish (CSV/Excel/PDF).
 * @returns {{rows:Array, warnings:string[], columns:Object}}
 */
function parseBankStatement({ content, buffer, filename = '', format }) {
  const name = String(filename).toLowerCase();
  let table = null;
  const warnings = [];
  const fmt = format || (name.endsWith('.csv') ? 'csv' : name.endsWith('.xlsx') || name.endsWith('.xls') ? 'excel' : name.endsWith('.pdf') ? 'pdf' : 'csv');

  if (fmt === 'csv') {
    const parsed = parseCSV(content != null ? content : buffer.toString('utf8'));
    table = parsed.rows;
  } else if (fmt === 'excel') {
    if (!buffer) throw new ApiError('Excel fayl bo‘sh.', 400, 'empty_file');
    const parsed = parseXLSX(buffer);
    table = parsed.rows;
  } else if (fmt === 'pdf') {
    if (!buffer) throw new ApiError('PDF fayl bo‘sh.', 400, 'empty_file');
    const { lines } = parsePDFText(buffer);
    if (!lines.length) {
      throw new ApiError('PDF ichidagi matnni o‘qib bo‘lmadi (skanerlangan PDF). Iltimos, CSV yoki Excel ko‘chirmasini yuklang — yoki PDFni OCR qilingan holda qayta yuklang.', 422, 'pdf_no_text');
    }
    table = lines.map(l => l.split(/\s{2,}|\s*\|\s*/).map(s => s.trim()).filter(Boolean));
    warnings.push('PDF matni satrlar bo‘yicha ajratildi — yuklashdan oldin qatorlarni tekshiring.');
  } else {
    throw new ApiError('Fayl formati qo‘llab-quvvatlanmaydi. CSV, XLSX yoki matnli PDF yuklang.', 400, 'unsupported_format');
  }

  if (!table || table.length < 2) throw new ApiError('Faylda o‘qish uchun ma’lumot qatorlari topilmadi.', 422, 'empty_statement');
  const headers = table[0];
  const cols = {
    date: matchColumn(headers, 'date'),
    in: matchColumn(headers, 'in'),
    out: matchColumn(headers, 'out'),
    amount: matchColumn(headers, 'amount'),
    balance: matchColumn(headers, 'balance'),
    description: matchColumn(headers, 'description'),
    counterparty: matchColumn(headers, 'counterparty'),
    reference: matchColumn(headers, 'reference'),
  };
  if (cols.date < 0) {
    // sana ustuni topilmadi: birinchi ustunni sana deb hisoblaymiz va ogohlantiramiz
    cols.date = 0;
    warnings.push('Sana ustuni avtomatik aniqlanmadi — birinchi ustun sana sifatida o‘qildi.');
  }
  const rows = [];
  let skipped = 0;
  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    if (!r || !r.length) continue;
    const date = parseAnyDate(r[cols.date]);
    let amountIn = cols.in >= 0 ? parseAnyAmount(r[cols.in]) : null;
    let amountOut = cols.out >= 0 ? parseAnyAmount(r[cols.out]) : null;
    let amount = amountIn != null || amountOut != null ? (amountIn || 0) - (amountOut || 0) : (cols.amount >= 0 ? parseAnyAmount(r[cols.amount]) : null);
    if (cols.amount >= 0 && amountIn == null && amountOut == null) amount = parseAnyAmount(r[cols.amount]);
    if (!date || amount == null || amount === 0) { skipped++; continue; }
    rows.push({
      date,
      amount: Math.abs(Math.round(amount)),
      direction: amount >= 0 ? 'in' : 'out',
      description: cols.description >= 0 ? String(r[cols.description] || '').slice(0, 300) : '',
      counterparty: cols.counterparty >= 0 ? String(r[cols.counterparty] || '').slice(0, 160) : '',
      reference: cols.reference >= 0 ? String(r[cols.reference] || '').slice(0, 100) : '',
      balance: cols.balance >= 0 ? parseAnyAmount(r[cols.balance]) : null,
      raw: r.join(' | ').slice(0, 500),
      line: i + 1,
    });
  }
  if (skipped) warnings.push(`${skipped} qator o‘qilmadi (sana yoki summa aniqlanmadi) — ular import qilinmadi.`);
  if (!rows.length) throw new ApiError('Ko‘chirmada o‘qiladigan qatorlar topilmadi. Ustunlarni tekshirib qayta yuklang.', 422, 'no_rows');
  return { rows, warnings, columns: cols };
}

// ─────────────────────── Hujjat (invoys/kvitansiya) tahlili ─────────────────

const DOC_KEYWORDS = {
  supplier: ['yetkazib beruvchi', 'sotuvchi', 'provider', 'supplier', 'tovar', 'xizmat ko‘rsatuvchi', 'hisob-faktura', 'инн', 'stir'],
  invoice_no: ['hisob-faktura', 'faktura', 'invoice', 'invoy', '№', 'no.', 'raqam', 'счет'],
  date: ['sana', 'date', 'дата', 'issued', 'berilgan'],
  total: ['jami', 'total', 'итого', 'to‘lov summasi', 'summa', 'amount', 'qqs bilan', 'qqs'],
  tax: ['qqs', 'vat', 'ндс', 'soliq'],
  tax_id: ['stir', 'inn', 'инн', 'mfo'],
};

/**
 * Matn (OCR yoki PDF) dan hujjat maydonlarini ajratib olish.
 * "AI extracted information" ekranida ko'rsatiladi va foydalanuvchi TASDIQLAYDI.
 */
function extractDocumentFields(text) {
  const lines = String(text || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
  const lower = lines.map(l => U.norm(l));
  const result = {
    supplier_name: null, invoice_no: null, date: null, total: null, tax_amount: null, net_amount: null,
    tax_id: null, mfo: null, bank_account: null, currency: 'UZS', line_items: [], confidence: 'low', evidence: [],
  };

  // Sana: eng ko'p uchraydigan formatlardan birinchisi
  for (const line of lines) {
    const m = /(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})|(\d{4}-\d{2}-\d{2})/.exec(line);
    if (m) { const d = parseAnyDate(m[0]); if (d) { result.date = d; result.evidence.push({ field: 'date', source: line.slice(0, 120) }); break; } }
  }
  // STIR/INN
  for (const line of lines) {
    const m = /(?:STIR|INN|ИНН|stir|inn)[^\d]{0,6}(\d{9,14})/i.exec(line);
    if (m) { result.tax_id = m[1]; result.evidence.push({ field: 'tax_id', source: line.slice(0, 120) }); break; }
  }
  // MFO va hisob raqami
  for (const line of lines) {
    const m = /(?:MFO|МФО)[^\d]{0,6}(\d{5})/i.exec(line);
    if (m) { result.mfo = m[1]; break; }
  }
  for (const line of lines) {
    const m = /\b(\d{20})\b/.exec(line);
    if (m) { result.bank_account = m[1]; break; }
  }
  // Hisob-faktura raqami
  for (let i = 0; i < lines.length; i++) {
    const l = lower[i];
    if (DOC_KEYWORDS.invoice_no.some(k => l.includes(k))) {
      const m = /([A-ZА-Я]{0,4}[-\s]?\d{2,}[-\d\/]*)/i.exec(lines[i]);
      if (m) { result.invoice_no = m[1].trim(); result.evidence.push({ field: 'invoice_no', source: lines[i].slice(0, 120) }); break; }
    }
  }
  // Summalar: "Jami", "QQS", "Total" bilan belgilangan qatorlar
  const amountRegex = /-?\d[\d\s.,']{2,}/g;
  const collected = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lower[i];
    const amounts = (lines[i].match(amountRegex) || []).map(parseAnyAmount).filter(a => a != null && Math.abs(a) >= 100);
    if (!amounts.length) continue;
    const value = Math.max(...amounts.map(Math.abs));
    if (DOC_KEYWORDS.tax.some(k => k === 'qqs' && l.includes('qqs')) || /\b(vat|ндс)\b/.test(l)) {
      result.tax_amount = result.tax_amount == null ? value : Math.max(result.tax_amount, value);
      collected.push({ line: i, kind: 'tax', value });
    } else if (DOC_KEYWORDS.total.some(k => l.includes(k))) {
      result.total = result.total == null ? value : Math.max(result.total, value);
      collected.push({ line: i, kind: 'total', value });
    } else if (amounts.length && /sana|date|дата/.test(l) === false) {
      collected.push({ line: i, kind: 'item', value });
    }
  }
  if (result.total == null && collected.length) {
    const items = collected.filter(c => c.kind === 'item');
    if (items.length) result.total = Math.max(...items.map(c => c.value));
  }
  if (result.total != null && result.tax_amount != null && result.tax_amount < result.total) {
    result.net_amount = result.total - result.tax_amount;
  } else if (result.total != null && result.tax_amount == null) {
    result.net_amount = result.total;
  }
  // Yetkazib beruvchi nomi: birinchi mazmunli satr (uzun, raqamsiz, kalit so'zli)
  const nameCandidates = lines.filter(l => {
    if (l.length < 5 || l.length > 120) return false;
    if (/^[\d\s.,:;№-]+$/.test(l)) return false;
    if (/(hisob-faktura|invoice|sana|date|jami|total|qqs|vat)/i.test(U.norm(l))) return false;
    return /[A-Za-zА-Яа-я‘’'ʻ]/.test(l);
  });
  if (nameCandidates.length) {
    const withLegal = nameCandidates.find(l => /(MChJ|OOO|ООО|LLC|AJ|ИП|YaTT|XK|QK)/i.test(l));
    result.supplier_name = (withLegal || nameCandidates[0]).slice(0, 160);
    result.evidence.push({ field: 'supplier_name', source: result.supplier_name });
  }
  // Qator elementlari (nomi + miqdor + narx)
  for (const line of lines) {
    const m = /^(.{3,60}?)\s+(\d+(?:[.,]\d+)?)\s+([\d\s.,']{3,})$/.exec(line);
    if (!m) continue;
    const qty = parseAnyAmount(m[2]);
    const price = parseAnyAmount(m[3]);
    if (qty && price && qty > 0 && qty < 100000) {
      result.line_items.push({ name: m[1].trim(), qty, unit_price: Math.round(price), amount: Math.round(qty * price) });
    }
    if (result.line_items.length >= 20) break;
  }
  const strong = [result.total != null, result.date != null, !!result.supplier_name, !!result.invoice_no].filter(Boolean).length;
  result.confidence = strong >= 4 ? 'high' : strong >= 2 ? 'medium' : 'low';
  return result;
}

/** OCR matni: tashqi OCR xizmati sozlanmagan bo'lsa, PDF matn qatlami ishlatiladi */
function ocrText({ buffer, text }) {
  if (text) return { text, engine: 'kiritilgan matn' };
  if (!buffer) return { text: '', engine: null };
  const isPdf = buffer.slice(0, 5).toString('latin1').startsWith('%PDF');
  if (isPdf) {
    const { text: pdfText } = parsePDFText(buffer);
    if (pdfText && pdfText.length > 20) return { text: pdfText, engine: 'PDF matn qatlami' };
  }
  const maybeText = buffer.toString('utf8');
  const printable = maybeText.replace(/[^\x20-\x7E\u00A0-\u04FF\n]/g, '');
  if (printable.length > 40 && printable.length / Math.max(1, maybeText.length) > 0.85) {
    return { text: printable, engine: 'matn faylidan o‘qildi' };
  }
  return {
    text: '',
    engine: null,
    reason: 'Hujjat skanerlangan rasm ko‘rinishida. OCR xizmati sozlanmagan (Ollama/provider kaliti yo‘q) — ma’lumotlarni qo‘lda kiriting.',
  };
}

module.exports = {
  parseCSV, parseXLSX, parsePDFText, parseAnyDate, parseAnyAmount, parseBankStatement, extractDocumentFields, ocrText,
  detectDelimiter, matchColumn,
};
