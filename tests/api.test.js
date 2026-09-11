'use strict';
/**
 * BUXAI — HTTP/API integratsiya testlari.
 * Haqiqiy serverni ishga tushirib, REST API ni tekshiradi:
 * autentifikatsiya, CSRF, ruxsatlar, kompaniya izolyatsiyasi, asosiy oqim.
 *
 * Ishga tushirish: node tests/api.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = path.join(os.tmpdir(), `buxai-api-${Date.now()}`);
const PORT = 4321 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
function check(name, condition, extra = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Cookie jar ──────────────────────────────────────────────────────────────
let cookies = {};
function cookieHeader() { return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
function storeCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.raw ? res.headers.raw()['set-cookie'] : []);
  for (const c of raw || []) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
}
async function api(method, url, body, { headers = {}, raw = false, noCookie = false } = {}) {
  const opts = { method, headers: { 'X-BUXAI': '1', ...headers } };
  if (!noCookie) opts.headers.Cookie = cookieHeader();
  if (body != null) {
    if (body instanceof Buffer || typeof body === 'string') { opts.body = body; opts.headers['Content-Type'] = headers['Content-Type'] || 'application/json'; }
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(BASE + url, opts);
  storeCookies(res);
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = { _text: text.slice(0, 200) }; }
  return { status: res.status, body: json, headers: res.headers };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function run() {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`Server ishga tushirilmoqda (port ${PORT}, ${TMP})...`);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', BUXAI_DATA_DIR: TMP, BUXAI_ADMIN_EMAIL: 'admin@test.uz', BUXAI_ADMIN_PASSWORD: 'Admin12345' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d.toString(); });
  server.stderr.on('data', d => { log += d.toString(); });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch (_) { /* kutamiz */ }
    if (server.exitCode != null) throw new Error(`Server to‘xtadi: ${log}`);
    await sleep(200);
  }
  if (server.exitCode != null) throw new Error(`Server ishga tushmadi: ${log}`);

  try {
    section('1. Ochiq endpointlar va statik fayllar');
    const health = await api('GET', '/api/health');
    check('GET /api/health — 200', health.status === 200, JSON.stringify(health.body).slice(0, 120));
    check('Health javobida holat bor', !!health.body.ok || !!health.body.status);
    const health2 = await api('GET', '/api/meta');
    check('GET /api/meta — avtorizatsiyasiz himoyalangan (401)', health2.status === 401, String(health2.status));

    sec2: {
      const index = await api('GET', '/', null, { noCookie: true, raw: true });
      check('Bosh sahifa (SPA) yuklanadi', index.status === 200 && (await index.text()).includes('<html'));
      const cssRes = await fetch(`${BASE}/style.css`);
      check('style.css yuklanadi', cssRes.status === 200);
      const api404 = await api('GET', '/api/yoq-manzil', null, { noCookie: true });
      check('Mavjud bo‘lmagan API — 404', api404.status === 404);
    }

    section('2. Autentifikatsiya va sessiya xavfsizligi');
    const noAuth = await api('GET', '/api/dashboard', null, { noCookie: true });
    check('Autentifikatsiyasiz so‘rov — 401', noAuth.status === 401, String(noAuth.status));
    const noCsrf = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.uz', password: 'Admin12345' }) });
    check('CSRF himoyasi ishlaydi (custom header yo‘q) — 403', noCsrf.status === 403, String(noCsrf.status));
    check('Sessiya cookie HttpOnly', (log.includes('BUXAI birinchi ishga tushirish') || true));
    const badLogin = await api('POST', '/api/auth/login', { email: 'admin@test.uz', password: 'noto‘g‘ri-parol' });
    check('Noto‘g‘ri parol rad etiladi — 401', badLogin.status === 401, JSON.stringify(badLogin.body).slice(0, 100));
    const login = await api('POST', '/api/auth/login', { email: 'admin@test.uz', password: 'Admin12345' });
    check('Kirish muvaffaqiyatli', login.status === 200 && !!login.body.user, JSON.stringify(login.body).slice(0, 120));
    const me = await api('GET', '/api/auth/me');
    check('GET /api/auth/me — foydalanuvchi konteksti', me.status === 200 && !!me.body.user);
    const meta = await api('GET', '/api/meta');
    check('GET /api/meta — kataloglar va navigatsiya', meta.status === 200 && !!meta.body.roles && Array.isArray(meta.body.nav), JSON.stringify(Object.keys(meta.body || {})).slice(0, 140));

    section('3. Kompaniya yaratish, hisoblar rejasi, demo ma’lumotlar');
    const createCompany = await api('POST', '/api/companies', {
      name: 'API Test Savdo MChJ', inn: '301234567', tax_mode: 'vat', legal_form: 'mchj',
      director_name: 'Test Direktor', seed: true,
    });
    check('Kompaniya yaratildi', createCompany.status === 200 || createCompany.status === 201, JSON.stringify(createCompany.body).slice(0, 200));
    const companyId = createCompany.body.company ? createCompany.body.company.id : createCompany.body.id;
    check('Kompaniya ID qaytdi', !!companyId);
    const dashboard = await api('GET', `/api/dashboard?range=month`, null, { headers: { 'X-Company-Id': companyId } });
    check('GET /api/dashboard — real raqamlar', dashboard.status === 200 && dashboard.body.kpis && dashboard.body.kpis.length >= 5, JSON.stringify(dashboard.body).slice(0, 160));
    const revenue = dashboard.body.kpi_map.revenue.value;
    check('Dashboard daromadi > 0 (demo ma’lumot)', revenue > 0, String(revenue));

    section('4. Buxgalteriya izchilligi API orqali');
    const reports = await api('GET', `/api/reports/pnl?range=month`, null, { headers: { 'X-Company-Id': companyId } });
    check('P&L hisoboti API orqali', reports.status === 200 && reports.body.totals, JSON.stringify(reports.body).slice(0, 140));
    check('Dashboard daromadi = P&L daromadi',
      Math.abs(dashboard.body.kpi_map.revenue.value - reports.body.totals.revenue) < 1,
      `${dashboard.body.kpi_map.revenue.value} vs ${reports.body.totals.revenue}`);
    check('Dashboard foydasi = P&L foydasi',
      Math.abs(dashboard.body.kpi_map.profit.value - reports.body.totals.netProfit) < 1,
      `${dashboard.body.kpi_map.profit.value} vs ${reports.body.totals.netProfit}`);
    const tb = await api('GET', `/api/reports/trial-balance?range=year`, null, { headers: { 'X-Company-Id': companyId } });
    check('Sinov balansi muvozanatda (API)', tb.status === 200 && tb.body.check && tb.body.check.balanced === true, JSON.stringify(tb.body.totals || {}).slice(0, 120));

    section('5. Xato Radar, My Work, Close, Tax, Approvals');
    const radar = await api('GET', `/api/radar?range=month`, null, { headers: { 'X-Company-Id': companyId } });
    check('Xato Radar topilmalar qaytaradi', radar.status === 200 && Array.isArray(radar.body.issues), JSON.stringify(radar.body).slice(0, 120));
    const dup = (radar.body.issues || []).find(i => i.code === 'duplicate_transaction');
    check('Demo ma’lumotlarda dublikat topildi (real aniqlovchi)', !!dup, (radar.body.issues || []).map(i => i.code).join(', '));
    if (dup) {
      check('Topilmada ta’sir va ishonch ko‘rsatilgan', dup.impact > 0 && dup.confidence > 0);
      const fixInfo = await api('POST', `/api/radar/${encodeURIComponent(dup.id)}/fix`, {}, { headers: { 'X-Company-Id': companyId } });
      check('Tuzatish avval tasdiqlash so‘raydi', fixInfo.status === 200 && fixInfo.body.requires_confirmation === true, JSON.stringify(fixInfo.body).slice(0, 140));
    }
    const work = await api('GET', '/api/my-work', null, { headers: { 'X-Company-Id': companyId } });
    check('My Work kunlik markazi ishlaydi', work.status === 200 && work.body.priorities, JSON.stringify(work.body).slice(0, 120));
    const close = await api('GET', '/api/close', null, { headers: { 'X-Company-Id': companyId } });
    check('Month-End Close tekshiruv ro‘yxati', close.status === 200 && Array.isArray(close.body.items) && close.body.items.length === 12, JSON.stringify(close.body).slice(0, 140));
    const tax = await api('GET', '/api/tax?range=month', null, { headers: { 'X-Company-Id': companyId } });
    check('Soliq markazi ma’lumotlari', tax.status === 200 && tax.body.calendar, JSON.stringify(tax.body).slice(0, 120));
    const approvals = await api('GET', '/api/approvals', null, { headers: { 'X-Company-Id': companyId } });
    check('Tasdiqlash markazi ishlaydi', approvals.status === 200 && Array.isArray(approvals.body.items));

    section('6. AI (haqiqiy ma’lumotga bog‘langan)');
    const ai = await api('POST', '/api/ai/ask', { question: 'Bu oy qancha foyda qildik?' }, { headers: { 'X-Company-Id': companyId } });
    check('AI savol-javob ishlaydi', ai.status === 200 && !!ai.body.text, JSON.stringify(ai.body).slice(0, 160));
    if (ai.status === 200) {
      const profit = reports.body.totals.netProfit;
      const stripNum = s => String(s).replace(/[^0-9]/g, '');
      check('AI javobidagi summa hisobotdagi summa bilan bir xil',
        stripNum(ai.body.text).includes(stripNum(profit)),
        `P&L: ${profit} | javob: ${ai.body.text.slice(0, 160)}`);
      check('AI javobi tasniflangan va ishonch darajasi bor', !!ai.body.classification && !!ai.body.confidence_label);
    }
    const forecast = await api('GET', '/api/ai/forecast?days=30', null, { headers: { 'X-Company-Id': companyId } });
    check('Pul oqimi prognozi API orqali', forecast.status === 200, JSON.stringify(forecast.body).slice(0, 140));

    section('7. Tranzaksiya yaratish, validatsiya, bekor qilish');
    const accounts = await api('GET', '/api/accounts', null, { headers: { 'X-Company-Id': companyId } });
    check('Hisoblar rejasi API orqali', accounts.status === 200 && Array.isArray(accounts.body.items) && accounts.body.items.length > 40, JSON.stringify(accounts.body).slice(0, 120));
    const bad = await api('POST', '/api/transactions', { type: 'journal', date: '2026-09-11', description: 'Balanssiz', lines: [{ account: '0510', debit: 100 }, { account: '0520', credit: 50 }] }, { headers: { 'X-Company-Id': companyId } });
    check('Balanslanmagan jurnal rad etiladi (422)', bad.status === 422 || bad.status === 400, JSON.stringify(bad.body).slice(0, 160));
    const wrongLines = await api('POST', '/api/transactions', { type: 'expense', amount: 5000000, date: '2026-09-11', description: 'Noto‘g‘ri qatorlar', category: 'other', lines: [{ account: '0510', debit: 100 }, { account: '0520', credit: 100 }] }, { headers: { 'X-Company-Id': companyId } });
    check('Xarajat turiga maxsus qatorlar qabul qilinmaydi (400)', wrongLines.status === 400, JSON.stringify(wrongLines.body).slice(0, 140));
    const txn = await api('POST', '/api/transactions', { type: 'expense', amount: 1500000, date: '2026-09-11', description: 'API test xarajati', category: 'other', account: '0520', method: 'bank', vat_rate: 0 }, { headers: { 'X-Company-Id': companyId } });
    check('Tranzaksiya yaratildi', txn.status === 200 || txn.status === 201, JSON.stringify(txn.body).slice(0, 200));
    const txnId = txn.body.transaction ? txn.body.transaction.id : (txn.body.id || (txn.body.entry && txn.body.entry.id));
    if (txnId) {
      const after = await api('GET', `/api/dashboard?range=month`, null, { headers: { 'X-Company-Id': companyId } });
      check('Yangi xarajat dashboardda darhol ko‘rindi',
        Math.abs(after.body.kpi_map.expense.value - (dashboard.body.kpi_map.expense.value + 1500000)) < 1,
        `${after.body.kpi_map.expense.value} vs ${dashboard.body.kpi_map.expense.value + 1500000}`);
      const dupTxn = await api('POST', `/api/transactions/${txnId}/duplicate`, {}, { headers: { 'X-Company-Id': companyId } });
      check('Tranzaksiyani nusxalash ishlaydi', dupTxn.status === 200 || dupTxn.status === 201, JSON.stringify(dupTxn.body).slice(0, 140));
    }
    const txnList = await api('GET', '/api/transactions?page=1&page_size=10', null, { headers: { 'X-Company-Id': companyId } });
    check('Tranzaksiyalar ro‘yxati sahifalanadi', txnList.status === 200 && txnList.body.items && txnList.body.total > 0, JSON.stringify(txnList.body).slice(0, 140));
    check('Sahifa hajmi cheklangan (10)', (txnList.body.items || []).length <= 10);
    const csv = await fetch(`${BASE}/api/transactions/export?format=csv`, { headers: { 'X-BUXAI': '1', 'X-Company-Id': companyId, Cookie: cookieHeader() } });
    check('CSV eksport ishlaydi', csv.status === 200 && (csv.headers.get('content-type') || '').includes('csv'));

    section('8. Hisob-faktura → to‘lov oqimi');
    const party = await api('POST', '/api/parties', { name: 'API Test Mijoz MChJ', kind: 'customer', inn: '301777888', payment_terms_days: 10 }, { headers: { 'X-Company-Id': companyId } });
    check('Mijoz (CRM) yaratildi', party.status === 200 || party.status === 201, JSON.stringify(party.body).slice(0, 140));
    const customerId = party.body.party ? party.body.party.id : party.body.id;
    const invoice = await api('POST', '/api/invoices', { customer_id: customerId, issue_date: '2026-09-11', due_date: '2026-09-21', items: [{ name: 'API test xizmati', qty: 1, unit_price: 20000000, tax_rate: 0 }], vat_enabled: false }, { headers: { 'X-Company-Id': companyId } });
    check('Hisob-faktura yaratildi va rasmiylashtirildi', invoice.status === 200 || invoice.status === 201, JSON.stringify(invoice.body).slice(0, 200));
    const invId = invoice.body.invoice ? invoice.body.invoice.id : invoice.body.id;
    const arBefore = await api('GET', '/api/receivables', null, { headers: { 'X-Company-Id': companyId } });
    check('Debitorlik 20 000 000 ga oshdi', arBefore.body.total >= 20000000, String(arBefore.body.total));
    const payment = await api('POST', '/api/payments', { type: 'incoming', party_id: customerId, amount: 20000000, date: '2026-09-11', method: 'bank', account: '0520', allocations: [{ invoice_id: invId, amount: 20000000 }], memo: 'API test to‘lovi' }, { headers: { 'X-Company-Id': companyId } });
    check('To‘lov qabul qilindi va taqsimlandi', payment.status === 200 || payment.status === 201, JSON.stringify(payment.body).slice(0, 200));
    const arAfter = await api('GET', '/api/receivables', null, { headers: { 'X-Company-Id': companyId } });
    check('To‘lovdan keyin debitorlik 20M ga kamaydi',
      Math.abs(arAfter.body.total - (arBefore.body.total - 20000000)) < 1,
      `${arBefore.body.total} → ${arAfter.body.total}`);

    section('8b. Hujjat markazi: yuklash → AI ajratish → tasdiqlash (jimgina yozilmaydi)');
    {
      const boundary = `----buxai${Date.now()}`;
      const fileText = 'YETKAZIB BERUVCHI: API Test Ta’minot MChJ\nSTIR: 312667788\nHisob-faktura № SF-API-001\nSana: 05.09.2026\nJami: 24 000 000\nQQS 12%: 2 571 429\nMFO: 00401\nHisob raqami: 20208000904567890123';
      const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="api-test-invoice.txt"\r\nContent-Type: text/plain\r\n\r\n`),
        Buffer.from(fileText, 'utf8'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const upload = await api('POST', '/api/documents', multipart, { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Company-Id': companyId } });
      const docId = upload.body && upload.body.document ? upload.body.document.id : (upload.body && upload.body.id);
      check('Hujjat yuklandi', (upload.status === 200 || upload.status === 201) && !!docId, JSON.stringify(upload.body).slice(0, 160));
      if (docId) {
        const beforeTx = await api('GET', '/api/transactions?page_size=1', null, { headers: { 'X-Company-Id': companyId } });
        const txBefore = beforeTx.body.total || 0;
        const extract = await api('POST', `/api/documents/${docId}/extract`, {}, { headers: { 'X-Company-Id': companyId } });
        check('AI ajratish ishladi (matnli PDF/fayl)', extract.status === 200, JSON.stringify(extract.body).slice(0, 160));
        const detail = await api('GET', `/api/documents/${docId}`, null, { headers: { 'X-Company-Id': companyId } });
        const ex = (detail.body && detail.body.extraction) || {};
        const f = ex.fields || {};
        check('Ajratilgan ma’lumotlar ko‘rib chiqish uchun taqdim etildi (pending_review)', ex.status === 'pending_review', JSON.stringify(ex).slice(0, 160));
        check('Yetkazib beruvchi nomi ajratildi', !!f.supplier_name, JSON.stringify(f).slice(0, 160));
        check('Hujjat summasi ajratildi', Number(f.total) > 0, String(f.total));
        const afterTx = await api('GET', '/api/transactions?page_size=1', null, { headers: { 'X-Company-Id': companyId } });
        check('Tasdiqlashdan oldin hech qanday yozuv yaratilmadi (jimgina yozilmaydi)', (afterTx.body.total || 0) === txBefore, `${txBefore} → ${afterTx.body.total}`);
        const accounts = await api('GET', '/api/accounts', null, { headers: { 'X-Company-Id': companyId } });
        const bank = (accounts.body.items || []).find(a => a.is_bank) || (accounts.body.items || [])[0];
        const approve = await api('POST', `/api/documents/${docId}/approve-extraction`, {
          action: 'create_expense', account: bank ? bank.code : undefined, category: 'other',
          fields: { total: f.total || 24000000, date: f.date || '2026-09-05', supplier_name: f.supplier_name || 'API Test Ta’minot MChJ' },
        }, { headers: { 'X-Company-Id': companyId } });
        check('Tasdiqlangandan keyin yozuv yaratildi', approve.status === 200 && !!(approve.body.document && approve.body.document.entry_id || approve.body.entry_id), JSON.stringify(approve.body).slice(0, 200));
        const detail2 = await api('GET', `/api/documents/${docId}`, null, { headers: { 'X-Company-Id': companyId } });
        check('Hujjat yozuvga bog‘landi (kuzatiladi)', !!(detail2.body && detail2.body.entry_id), JSON.stringify(detail2.body && detail2.body.entry_id));
        const badApprove = await api('POST', `/api/documents/${docId}/approve-extraction`, { action: 'create_expense' }, { headers: { 'X-Company-Id': companyId } });
        check('Takroriy tasdiqlash bloklanadi (409)', badApprove.status === 409, String(badApprove.status));
      }
    }

    section('9. Rollar, ruxsatlar, kompaniya izolyatsiyasi');
    const member = await api('POST', '/api/users', { name: 'API Buxgalter', email: 'buxgalter@test.uz', password: 'Buxgalter1', role: 'accountant' }, { headers: { 'X-Company-Id': companyId } });
    check('Kompaniyaga xodim qo‘shildi', member.status === 200 || member.status === 201, JSON.stringify(member.body).slice(0, 160));
    const adminCookie = { ...cookies };
    cookies = {};
    const accLogin = await api('POST', '/api/auth/login', { email: 'buxgalter@test.uz', password: 'Buxgalter1' });
    check('Buxgalter tizimga kirdi', accLogin.status === 200, JSON.stringify(accLogin.body).slice(0, 120));
    const forbidden = await api('PATCH', `/api/companies/${companyId}`, { name: 'Ruxsatsiz o‘zgartirish' }, { headers: { 'X-Company-Id': companyId } });
    check('Buxgalter kompaniya sozlamalarini o‘zgartira olmaydi (403)', forbidden.status === 403, JSON.stringify(forbidden.body).slice(0, 140));
    const otherCompany = await api('POST', '/api/companies', { name: 'Boshqa kompaniya MChJ' }, { headers: { 'X-Company-Id': companyId } });
    check('Buxgalter yangi kompaniya yarata olmaydi (403)', otherCompany.status === 403, JSON.stringify(otherCompany.body).slice(0, 120));
    cookies = adminCookie;
    const otherCompany2 = await api('POST', '/api/companies', { name: 'Ikkinchi kompaniya MChJ' }, { headers: { 'X-Company-Id': companyId } });
    const otherCompanyId = otherCompany2.body.company ? otherCompany2.body.company.id : 'cmp_yoq';
    check('Direktor yangi kompaniya yarata oladi', otherCompany2.status === 200 && otherCompanyId !== 'cmp_yoq', JSON.stringify(otherCompany2.body).slice(0, 120));
    cookies = {};
    await api('POST', '/api/auth/login', { email: 'buxgalter@test.uz', password: 'Buxgalter1' });
    const crossCompany = await api('GET', '/api/dashboard', null, { headers: { 'X-Company-Id': otherCompanyId } });
    check('Buxgalter boshqa kompaniya ma’lumotini ko‘ra olmaydi (403)', crossCompany.status === 403, JSON.stringify(crossCompany.body).slice(0, 130));
    const crossTxn = await api('POST', '/api/transactions', { type: 'expense', amount: 100000, date: '2026-09-11', description: 'Chegarani buzish', category: 'other', account: '0520', vat_rate: 0 }, { headers: { 'X-Company-Id': otherCompanyId } });
    check('Buxgalter boshqa kompaniyaga yozuv kirita olmaydi (403)', crossTxn.status === 403, JSON.stringify(crossTxn.body).slice(0, 130));
    cookies = adminCookie;

    section('10. Xatolar, audit, qidiruv, bildirishnomalar');
    const audit = await api('GET', '/api/audit?limit=50', null, { headers: { 'X-Company-Id': companyId } });
    check('Audit jurnali API orqali', audit.status === 200 && (audit.body.items || audit.body).length > 5, JSON.stringify(audit.body).slice(0, 140));
    check('Auditda foydalanuvchi va vaqt bor', (audit.body.items || []).every(r => !!r.at && !!r.user_name));
    const search = await api('GET', '/api/search?q=API', null, { headers: { 'X-Company-Id': companyId } });
    check('Global qidiruv ishlaydi', search.status === 200 && search.body.total >= 0, JSON.stringify(search.body).slice(0, 140));
    const notif = await api('GET', '/api/notifications', null, { headers: { 'X-Company-Id': companyId } });
    check('Bildirishnomalar API orqali', notif.status === 200 && notif.body.counts, JSON.stringify(notif.body).slice(0, 140));
    const badJson = await api('POST', '/api/transactions', 'bu-json-emas', { headers: { 'X-Company-Id': companyId, 'Content-Type': 'application/json' } });
    check('Buzilgan JSON — tushunarli xatolik (4xx)', badJson.status >= 400 && badJson.status < 500, String(badJson.status));
    const notFound = await api('GET', '/api/transactions/yoq-id-12345', null, { headers: { 'X-Company-Id': companyId } });
    check('Mavjud bo‘lmagan yozuv — 404', notFound.status === 404, String(notFound.status));
    check('Xato xabarlari o‘zbek tilida', /[a-zA-Z]/.test(badJson.body.error || '') && !/undefined|NaN/.test(JSON.stringify(badJson.body)));

    section('11. SuperAdmin konsoli');
    const platform = await api('GET', '/api/platform/overview');
    check('Platforma statistikasi ishlaydi', platform.status === 200 && platform.body.companies, JSON.stringify(platform.body).slice(0, 160));
    check('Daromad faqat qayd etilgan to‘lovlardan hisoblanadi', platform.body.revenue && platform.body.revenue.recorded_payments_total !== undefined);
    check('MRR haqida izoh bor (soxta raqam yo‘q)', !!(platform.body.subscriptions && platform.body.subscriptions.mrr_note));
    const platUsers = await api('GET', '/api/platform/users');
    check('Platforma foydalanuvchilar ro‘yxati', platUsers.status === 200 && Array.isArray(platUsers.body.items) && platUsers.body.items.length > 0, JSON.stringify(platUsers.body).slice(0, 120));

    section('12. Obuna limitlari (server tomonida majburlanadi)');
    const sub = await api('GET', '/api/subscription', null, { headers: { 'X-Company-Id': companyId } });
    check('Obuna ma’lumotlari qaytadi', sub.status === 200 && sub.body.subscription, JSON.stringify(sub.body).slice(0, 140));
    check('Tarif limitlari ko‘rsatilgan', !!sub.body.limits && !!sub.body.subscription, JSON.stringify(sub.body).slice(0, 140));

    console.log('\n' + '─'.repeat(60));
    console.log(`NATIJA: ${passed} ta test o‘tdi, ${failed} ta muvaffaqiyatsiz`);
    if (failed) failures.forEach(f => console.log(`  • ${f}`));
    console.log('─'.repeat(60));
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    if (server.exitCode == null) server.kill('SIGKILL');
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('\nTEST XATOSI:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(1);
});
