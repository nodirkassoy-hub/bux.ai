'use strict';
/**
 * BUXAI — ilova yadrosi (SPA).
 * Barcha raqamlar serverdagi yagona buxgalteriya jurnaliga tayanadi;
 * interfeys hech qanday qiymatni o'zi "o'ylab topmaydi".
 */

// ══════════════════════════════ Holat (state) ═══════════════════════════════

const S = {
  user: null, companies: [], companyId: null, company: null, role: null,
  permissions: [], meta: null, settings: null, subscription: null,
  range: { key: 'month', from: null, to: null, label: 'Bu oy' },
  page: 'dashboard', params: {}, params2: {},
  notifications: { unread: 0, critical: 0 }, radar: { total: 0, high: 0, impact: 0 },
  approvals_pending: 0, cash: null, loading: false,
};

const RANGE_LABELS = { today: 'Bugun', week: 'Bu hafta', month: 'Bu oy', last_month: 'O‘tgan oy', quarter: 'Bu chorak', year: 'Bu yil', all: 'Butun davr' };

// ══════════════════════════════ Yordamchilar ═══════════════════════════════

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function money(v, currency = 'UZS') {
  const n = Math.round(num(v));
  const sign = n < 0 ? '−' : '';
  const digits = new Intl.NumberFormat('uz-UZ').format(Math.abs(n));
  return `${sign}${digits} ${currency === 'USD' ? 'USD' : 'so‘m'}`;
}
function compact(v) {
  const n = Math.abs(Math.round(num(v)));
  const sign = num(v) < 0 ? '−' : '';
  if (n >= 1e9) return `${sign}${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} mlrd`;
  if (n >= 1e6) return `${sign}${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} mln`;
  if (n >= 1e3) return `${sign}${(n / 1e3).toFixed(0)} ming`;
  return `${sign}${n}`;
}
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  const months = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
  return `${Number(day)}-${months[Number(m) - 1] || m}, ${y}`;
}
function shortDate(d) {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day}.${m}.${y}`;
}
function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'hozir';
  if (min < 60) return `${min} daqiqa oldin`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} soat oldin`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} kun oldin`;
  return shortDate(iso.slice(0, 10));
}
function pct(v) { return v == null ? '—' : `${num(v).toFixed(num(v) % 1 === 0 ? 0 : 1)}%`; }
function growthText(v) { return v == null ? null : `${v >= 0 ? '+' : ''}${num(v).toFixed(1)}%`; }
function can(permission) {
  if (!S.user) return false;
  if (S.user.is_platform_admin) return true;
  return (S.permissions || []).includes('*') || (S.permissions || []).includes(permission);
}
function isPlatformAdmin() { return !!(S.user && S.user.is_platform_admin); }

// ══════════════════════════════ API klient ═════════════════════════════════

function ApiError(message, code, status, details) {
  const err = new Error(message || 'Xatolik yuz berdi.');
  err.name = 'ApiError';
  err.code = code || 'error';
  err.status = status || 0;
  err.details = details || null;
  return err;
}

async function api(path, { method = 'GET', body = null, query = null, form = null, raw = false } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, String(v)); });
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const headers = { 'X-BUXAI': '1' };
  if (S.companyId) headers['X-Company-Id'] = S.companyId;
  let payload;
  if (form) { payload = form; }
  else if (body != null) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  if (raw) {
    if (!res.ok) throw ApiError('Faylni yuklab bo‘lmadi.', 'download_failed', res.status);
    return res;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok) {
    if (res.status === 401 && S.user && path !== '/api/auth/me') {
      showLogin('Sessiya muddati tugadi. Qaytadan kiring.');
      throw ApiError('Sessiya muddati tugadi.', 'unauthorized', 401);
    }
    const message = (data && (data.error || data.message)) || (res.status === 500 ? 'Serverda xatolik yuz berdi.' : 'So‘rovni bajarib bo‘lmadi.');
    throw ApiError(message, (data && data.code) || 'error', res.status, data && data.details);
  }
  return data;
}

function download(url, fallbackName) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fallbackName || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Yuklab olish boshlandi.', 'success');
}

// ══════════════════════════════ Toast / holat ══════════════════════════════

function toast(message, type = 'info', timeout = 5000) {
  const host = $('#toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="toast-body">${esc(message)}</div>`;
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.textContent = '×';
  close.onclick = () => el.remove();
  el.appendChild(close);
  host.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

function loadingBlock(lines = 3) {
  let html = '<div class="loading-block">';
  html += '<div class="skeleton lg"></div>';
  for (let i = 0; i < lines; i++) html += '<div class="skeleton"></div>';
  return html + '</div>';
}

function emptyState({ icon = '◌', title = 'Ma’lumot yo‘q', text = '', cta = null, hint = null } = {}) {
  return `<div class="empty-state">
    <div class="empty-icon">${esc(icon)}</div>
    <h3>${esc(title)}</h3>
    ${text ? `<p>${esc(text)}</p>` : ''}
    ${hint ? `<small>${esc(hint)}</small>` : ''}
    ${cta ? `<button class="primary" data-action="${esc(cta.action)}">${esc(cta.label)}</button>` : ''}
  </div>`;
}

function errorState(err, retryAction = 'page:reload') {
  return `<div class="empty-state error">
    <div class="empty-icon">⚠</div>
    <h3>Ma’lumotlarni yuklashda xatolik yuz berdi.</h3>
    <p>${esc(err && err.message ? err.message : 'Qayta urinib ko‘ring.')}</p>
    <button class="primary" data-action="${esc(retryAction)}">Qayta urinib ko‘ring</button>
  </div>`;
}

// ══════════════════════════════ UI quruvchilar ═════════════════════════════

function card({ title, subtitle, actions = '', body = '', className = '' }) {
  return `<div class="card ${className}">
    ${title ? `<div class="card-head"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>${actions}</div>` : ''}
    ${body}
  </div>`;
}

function chip(text, tone = 'neutral', title = '') {
  return `<span class="chip ${tone}" ${title ? `title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

function severityTone(sev) {
  return sev === 'critical' ? 'danger' : sev === 'high' ? 'warn' : sev === 'medium' ? 'info' : 'neutral';
}
function statusTone(status) {
  const map = {
    paid: 'ok', sent: 'info', viewed: 'info', partially_paid: 'warn', overdue: 'danger', cancelled: 'neutral', draft: 'neutral', refunded: 'info',
    ok: 'ok', warning: 'warn', failed: 'danger', done: 'ok', pending: 'neutral', due_soon: 'warn', upcoming: 'neutral',
    matched: 'ok', unmatched: 'warn', created: 'ok', ignored: 'neutral', pending_approval: 'warn', posted: 'ok', void: 'neutral',
    approved: 'ok', rejected: 'danger', open: 'warn', resolved: 'ok', trialing: 'info', active: 'ok', expired: 'danger',
  };
  return map[status] || 'neutral';
}

function metricCard({ label, value, icon = '◈', tone = 'purple', trend = null, hint = null, action = null }) {
  return `<div class="metric">
    <div class="metric-top"><span>${esc(label)}</span><i class="${tone}">${esc(icon)}</i></div>
    <strong>${esc(value)}</strong>
    ${trend ? `<div class="trend ${trend.direction}">${esc(trend.text)} <small>${esc(trend.note || '')}</small></div>`
      : hint ? `<div class="trend"><small>${esc(hint)}</small></div>` : ''}
    ${action ? `<button class="text-btn" data-action="${esc(action.action)}">${esc(action.label)}</button>` : ''}
  </div>`;
}

function table(headers, rows, { empty = null, className = '', mobile = true } = {}) {
  if (!rows || !rows.length) return empty || emptyState({ title: 'Ma’lumot yo‘q', text: 'Ko‘rsatiladigan yozuvlar topilmadi.' });
  const head = headers.map(h => `<th>${esc(h)}</th>`).join('');
  const body = rows.map(row => {
    const cells = Array.isArray(row) ? row : row.cells;
    const cls = (!Array.isArray(row) && row.className) ? ` class="${row.className}"` : '';
    const attrs = (!Array.isArray(row) && row.attrs) ? row.attrs : '';
    return `<tr${cls} ${attrs}>${cells.map((c, i) => `<td data-label="${esc(headers[i] || '')}">${c == null ? '—' : c}</td>`).join('')}</tr>`;
  }).join('');
  return `<div class="table-wrap ${mobile ? 'm-table' : ''} ${className}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function pager({ total = 0, page = 1, pageSize = 25, action = 'page:go' } = {}) {
  const pages = Math.max(1, Math.ceil(num(total) / pageSize));
  if (pages <= 1) return '';
  const btn = (p, label, disabled) => `<button class="ghost" ${disabled ? 'disabled' : ''} data-action="${action}" data-page-num="${p}">${label}</button>`;
  return `<div class="pager">
    ${btn(page - 1, '← Oldingi', page <= 1)}
    <span class="pager-info">${page} / ${pages} · jami ${num(total)}</span>
    ${btn(page + 1, 'Keyingi →', page >= pages)}
  </div>`;
}

function progressBar(percent, tone = '') {
  const p = Math.max(0, Math.min(100, num(percent)));
  return `<div class="progress ${tone}"><i style="width:${p}%"></i></div>`;
}

function barsChart(items, { height = 135, labelKey = 'label', inKey = 'in', outKey = 'out' } = {}) {
  if (!items || !items.length) return emptyState({ title: 'Ma’lumot yo‘q', text: 'Grafik uchun bu davrda ma’lumot yo‘q.' });
  const max = Math.max(...items.map(i => Math.max(num(i[inKey]), num(i[outKey]))), 1);
  const bars = items.map(i => {
    const inH = Math.max(2, Math.round(num(i[inKey]) / max * height));
    const outH = Math.max(2, Math.round(num(i[outKey]) / max * height));
    return `<div class="bar-group" title="${esc(i[labelKey])}: kirim ${money(i[inKey])}, chiqim ${money(i[outKey])}">
      <i class="bar in" style="height:${inH}px"></i><i class="bar out" style="height:${outH}px"></i>
    </div>`;
  }).join('');
  const labels = items.map(i => `<span>${esc(i.short || i[labelKey])}</span>`).join('');
  return `<div class="chart-legend"><span><i class="dot purple-dot"></i>Kirim</span><span><i class="dot grey-dot"></i>Chiqim</span></div>
    <div class="chart">
      <div class="y-labels"><span>${compact(max)}</span><span>${compact(max / 2)}</span><span>0</span></div>
      <div class="bars" style="height:${height}px">${bars}</div>
      <div class="x-labels">${labels}</div>
    </div>`;
}

function statRows(rows) {
  return `<div class="stat-list">${rows.map(([label, value, extra]) => `
    <div class="stat-row"><span>${esc(label)}</span><b>${value == null ? '—' : value}</b>${extra ? `<small>${extra}</small>` : ''}</div>`).join('')}</div>`;
}

function definitionList(items) {
  return `<dl class="def-list">${items.filter(Boolean).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v == null || v === '' ? '—' : v}</dd></div>`).join('')}</dl>`;
}

// ══════════════════════════════ Modallar ═══════════════════════════════════

function openModal(sel) { const el = $(sel); if (el) el.classList.add('show'); }
function closeModal(el) {
  const root = el && el.closest ? el.closest('.modal-backdrop') : el;
  if (root && root.classList) root.classList.remove('show');
}
function closeAllModals() { $$('.modal-backdrop').forEach(m => m.classList.remove('show')); }

/**
 * Universal forma modali. fields: [{name,label,type,options,required,value,min,step,help,col}]
 */
function openForm({ title, description = '', fields = [], submitLabel = 'Saqlash', onSubmit, wide = false, extraHtml = '' }) {
  const fieldHtml = fields.map(f => {
    const id = `f_${f.name}`;
    const label = `<label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>`;
    let input;
    if (f.type === 'select') {
      input = `<select id="${id}" name="${esc(f.name)}" ${f.required ? 'required' : ''}>${(f.options || []).map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea id="${id}" name="${esc(f.name)}" rows="${f.rows || 3}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}>${esc(f.value || '')}</textarea>`;
    } else if (f.type === 'checkbox') {
      return `<label class="checkbox-row" for="${id}"><input type="checkbox" id="${id}" name="${esc(f.name)}" ${f.value ? 'checked' : ''}> <span>${esc(f.label)}</span></label>`;
    } else if (f.type === 'file') {
      input = `<input type="file" id="${id}" name="${esc(f.name)}" ${f.accept ? `accept="${esc(f.accept)}"` : ''} ${f.required ? 'required' : ''}>`;
    } else {
      input = `<input type="${esc(f.type || 'text')}" id="${id}" name="${esc(f.name)}" value="${esc(f.value == null ? '' : f.value)}" placeholder="${esc(f.placeholder || '')}" ${f.min != null ? `min="${f.min}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.required ? 'required' : ''} ${f.readonly ? 'readonly' : ''}>`;
    }
    return `<div class="form-field ${f.col === 2 ? 'col-2' : ''}">${label}${input}${f.help ? `<small class="help">${esc(f.help)}</small>` : ''}</div>`;
  }).join('');

  const host = $('#generic-modal-host');
  host.innerHTML = `<h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}
    <form id="generic-form" class="${wide ? 'wide' : ''}">${fieldHtml}${extraHtml}
      <div class="form-actions"><button type="button" class="ghost" data-action="modal:close">Bekor qilish</button>
      <button class="primary full" type="submit">${esc(submitLabel)}</button></div>
      <div id="generic-form-msg" class="form-msg" hidden></div>
    </form>`;
  openModal('#generic-modal');
  const form = $('#generic-form');
  focusFirst(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#generic-form-msg');
    const btn = form.querySelector('button[type=submit]');
    const data = {};
    const fd = new FormData(form);
    for (const f of fields) {
      const raw = f.type === 'file' ? fd.get(f.name) : fd.get(f.name);
      if (f.type === 'checkbox') data[f.name] = fd.get(f.name) === 'on';
      else if (f.type === 'number' || f.type === 'money') data[f.name] = raw === '' || raw == null ? '' : Number(String(raw).replace(/\s/g, '').replace(/,/g, '.'));
      else data[f.name] = raw;
    }
    btn.disabled = true;
    btn.textContent = 'Yuborilmoqda…';
    try {
      await onSubmit(data, { form, files: fd });
      closeAllModals();
    } catch (err) {
      msg.hidden = false;
      msg.className = `form-msg error`;
      msg.textContent = err.message || 'Xatolik yuz berdi.';
    } finally {
      btn.disabled = false;
      btn.textContent = submitLabel;
    }
  });
  return form;
}

function focusFirst(root) {
  const el = root.querySelector('input:not([type=hidden]),select,textarea');
  if (el && window.innerWidth > 700) setTimeout(() => el.focus(), 50);
}

function confirmDialog({ title, message, confirmLabel = 'Tasdiqlash', danger = false, onConfirm, extraField = null, note = null }) {
  const host = $('#generic-modal-host');
  host.innerHTML = `<h2>${esc(title)}</h2><p>${esc(message)}</p>
    ${note ? `<div class="notice">${esc(note)}</div>` : ''}
    ${extraField ? `<label>${esc(extraField.label)}<textarea id="confirm-note" rows="2">${esc(extraField.value || '')}</textarea></label>` : ''}
    <div class="form-actions"><button class="ghost" data-action="modal:close">Bekor qilish</button>
    <button class="primary ${danger ? 'danger' : ''}" id="confirm-yes">${esc(confirmLabel)}</button></div>
    <div id="generic-form-msg" class="form-msg" hidden></div>`;
  openModal('#generic-modal');
  $('#confirm-yes').addEventListener('click', async () => {
    const btn = $('#confirm-yes');
    btn.disabled = true;
    try {
      await onConfirm(extraField ? ($('#confirm-note') ? $('#confirm-note').value : '') : undefined);
      closeAllModals();
    } catch (err) {
      const msg = $('#generic-form-msg');
      msg.hidden = false; msg.className = 'form-msg error'; msg.textContent = err.message;
    } finally { btn.disabled = false; }
  });
}

// ══════════════════════════════ Autentifikatsiya ekrani ════════════════════

function showLogin(message = '') {
  S.user = null;
  document.body.classList.add('auth-mode');
  $('#page-content').innerHTML = `
  <div class="auth-wrap">
    <div class="card auth-card">
      <div class="brand auth-brand"><div class="brand-mark">B</div><div><strong>Bux<span>AI</span></strong><small>Moliyaviy platforma</small></div></div>
      <h1 id="auth-title">Tizimga kirish</h1>
      <p class="auth-sub">O‘zbekiston biznesi uchun moslashtirilgan zamonaviy AI accounting platforma.</p>
      ${message ? `<div class="notice warn">${esc(message)}</div>` : ''}
      <div class="type-switch auth-switch">
        <label><input type="radio" name="auth_mode" value="login" checked><span>Tizimga kirish</span></label>
        <label><input type="radio" name="auth_mode" value="register"><span>Ro‘yxatdan o‘tish</span></label>
      </div>
      <form id="auth-form">
        <div id="register-fields" hidden>
          <label>Ism familiya<input name="name" placeholder="Masalan: Aziz Karimov"></label>
          <label>Kompaniya nomi<input name="company_name" placeholder="Masalan: Orient Textile MChJ"></label>
          <div class="form-row">
            <label>STIR (INN)<input name="inn" placeholder="305987123" maxlength="9"></label>
            <label>Bojxona rejimi
              <select name="tax_mode"><option value="vat">QQS to‘lovchisi</option><option value="turnover">Aylanma solig‘i</option></select>
            </label>
          </div>
        </div>
        <label>Email<input name="email" type="email" autocomplete="username" required placeholder="siz@kompaniya.uz"></label>
        <label>Parol<input name="password" type="password" autocomplete="current-password" required placeholder="Kamida 8 belgi"></label>
        <button class="primary full" type="submit" id="auth-submit">Kirish</button>
        <div id="auth-msg" class="form-msg" hidden></div>
      </form>
      <div class="auth-foot">Hisobingiz yo‘qmi? «Ro‘yxatdan o‘tish»ni tanlang — kompaniya va hisoblar rejasi avtomatik yaratiladi.</div>
    </div>
  </div>`;
  const form = $('#auth-form');
  $('#auth-title').textContent = 'Tizimga kirish';
  $$('input[name=auth_mode]').forEach(radio => radio.addEventListener('change', () => {
    const register = $('input[name=auth_mode]:checked').value === 'register';
    $('#register-fields').hidden = !register;
    $('#auth-title').textContent = register ? 'Ro‘yxatdan o‘tish' : 'Tizimga kirish';
    $('#auth-submit').textContent = register ? 'Kompaniya yaratish' : 'Kirish';
  }));
  focusFirst(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#auth-msg');
    const btn = $('#auth-submit');
    const fd = Object.fromEntries(new FormData(form).entries());
    btn.disabled = true;
    msg.hidden = true;
    try {
      if (fd.auth_mode === 'register') {
        await api('/api/auth/register', { method: 'POST', body: { name: fd.name, email: fd.email, password: fd.password, company_name: fd.company_name, inn: fd.inn, tax_mode: fd.tax_mode } });
      } else {
        await api('/api/auth/login', { method: 'POST', body: { email: fd.email, password: fd.password } });
      }
      document.body.classList.remove('auth-mode');
      toast('Xush kelibsiz!', 'success');
      await boot();
    } catch (err) {
      msg.hidden = false;
      msg.className = 'form-msg error';
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ══════════════════════════════ Navigatsiya ════════════════════════════════

const NAV = {
  'my-work': { kicker: 'Mening ishim', title: 'Kunlik ish markazi' },
  dashboard: { kicker: 'Bosh sahifa', title: 'Umumiy ko‘rinish' },
  transactions: { kicker: 'Buxgalteriya', title: 'Operatsiyalar' },
  invoices: { kicker: 'Sotuv', title: 'Hisob-fakturalar' },
  payments: { kicker: 'Buxgalteriya', title: 'To‘lovlar' },
  receivables: { kicker: 'Debitorlik', title: 'Mijozlardan qarzlar' },
  payables: { kicker: 'Kreditorlik', title: 'Yetkazib beruvchilarga qarzlar' },
  parties: { kicker: 'CRM', title: 'Kontragentlar' },
  inventory: { kicker: 'Ombor', title: 'Mahsulotlar va qoldiqlar' },
  radar: { kicker: 'Xato Radar', title: 'Xatolar va anomaliyalar' },
  banking: { kicker: 'Bank va kassa', title: 'Hisoblar va solishtirish' },
  documents: { kicker: 'Hujjatlar', title: 'Hujjat markazi' },
  reports: { kicker: 'Hisobotlar', title: 'Hisobot markazi' },
  cashflow: { kicker: 'Pul oqimi', title: 'Pul oqimi va prognoz' },
  tax: { kicker: 'Soliqlar', title: 'Soliq markazi' },
  close: { kicker: 'Davr yopish', title: 'Month-End Close' },
  ai: { kicker: 'AI', title: 'AI Buxgalter / CFO' },
  advisor: { kicker: 'AI', title: 'AI Business Advisor' },
  team: { kicker: 'Boshqaruv', title: 'Jamoa va rollar' },
  approvals: { kicker: 'Boshqaruv', title: 'Tasdiqlash markazi' },
  goals: { kicker: 'Boshqaruv', title: 'Maqsadlar' },
  audit: { kicker: 'Boshqaruv', title: 'Audit jurnali' },
  subscription: { kicker: 'Boshqaruv', title: 'Tarif va limitlar' },
  settings: { kicker: 'Boshqaruv', title: 'Sozlamalar' },
  platform: { kicker: 'SuperAdmin', title: 'Platforma konsoli' },
  support: { kicker: 'Yordam', title: 'Qo‘llab-quvvatlash' },
};

function currentHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const params = {};
  if (qs) new URLSearchParams(qs).forEach((v, k) => { params[k] = v; });
  const [page, id] = path.split('/');
  return { page: page || 'dashboard', id: id || null, params };
}

function go(page, params = {}, { replace = false } = {}) {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, String(v)); });
  const path = `#/${page}${params && params.id && !qs.has('id') ? '/' + params.id : ''}${qs.toString() ? '?' + qs.toString() : ''}`;
  if (replace) history.replaceState(null, '', path); else location.hash = path;
  if (!replace) renderPage();
}

async function renderPage() {
  const { page, id, params } = currentHash();
  const p = NAV[page] ? page : 'dashboard';
  S.page = p;
  S.params = { ...params, id: id || params.id || null };
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === p));
  $('#page-kicker').textContent = NAV[p].kicker;
  $('#page-title').textContent = NAV[p].title;
  const view = (window.VIEWS || {})[p];
  const host = $('#page-content');
  if (!view) {
    host.innerHTML = emptyState({ title: 'Bo‘lim topilmadi', text: 'Bu bo‘lim mavjud emas yoki hali ochilmagan.' });
    return;
  }
  host.innerHTML = loadingBlock();
  try {
    const html = await view.load(S.params, S);
    if (S.page !== p) return;
    host.innerHTML = html;
    if (view.mount) await view.mount(S.params);
  } catch (err) {
    if (S.page !== p) return;
    host.innerHTML = errorState(err);
    if (err && err.code === 'plan_limit') toast(err.message, 'warn', 8000);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ══════════════════════════════ Ma’lumotlarni yuklash ══════════════════════

async function refreshBadges() {
  try {
    const me = await api('/api/auth/me');
    S.notifications = me.notifications || { unread: 0, critical: 0 };
    S.radar = me.radar || { total: 0, high: 0, impact: 0 };
    S.subscription = me.subscription || S.subscription;
    S.settings = me.settings || S.settings;
    const dot = $('#notif-dot');
    if (dot) dot.hidden = !(S.notifications.unread > 0);
    const setBadge = (sel, value, tone) => {
      const el = $(sel);
      if (!el) return;
      if (value > 0) { el.hidden = false; el.textContent = value > 99 ? '99+' : String(value); el.style.background = tone === 'danger' ? '#fdeaea' : ''; el.style.color = tone === 'danger' ? '#e0565d' : ''; }
      else el.hidden = true;
    };
    setBadge('#badge-radar', (S.radar.high || 0), 'danger');
    setBadge('#badge-invoices', 0);
    $('#nav-platform').hidden = !isPlatformAdmin();
  } catch (_) { /* jimgina o'tkazamiz */ }
}

async function loadMyWorkBadges() {
  try {
    const work = await api('/api/my-work');
    S.approvals_pending = work.approvals_pending || 0;
    const badge = $('#badge-approvals');
    if (badge) { badge.hidden = !S.approvals_pending; badge.textContent = String(S.approvals_pending); }
    const workBadge = $('#badge-work');
    if (workBadge) { workBadge.hidden = !(work.totals && work.totals.critical); workBadge.textContent = String(work.totals ? work.totals.critical : 0); }
  } catch (_) { /* ignore */ }
}

function updateProfileUi() {
  if (!S.user) return;
  const initials = String(S.user.name || 'U').split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
  $('#user-name').textContent = S.user.name || '—';
  const roleLabels = { superadmin: 'SuperAdmin', director: 'Rahbar', accountant: 'Buxgalter', employee: 'Xodim' };
  $('#user-role').textContent = roleLabels[S.role] || S.user.role || '—';
  $('#user-avatar').textContent = initials;
  const company = S.company || (S.companies.find(c => c.id === S.companyId)) || null;
  $('#company-name').textContent = company ? company.name : 'Kompaniya tanlang';
  $('#company-role').textContent = company ? (roleLabels[(company.role || S.role)] || '') : '—';
  $('#company-avatar').textContent = company ? String(company.name).replace(/[^A-Za-zА-Яа-я0-9]/g, '').slice(0, 2).toUpperCase() : '—';
}

async function boot() {
  try {
    const me = await api('/api/auth/me');
    S.user = me.user;
    S.companies = me.companies || [];
    S.companyId = me.active_company_id || (S.companies[0] && S.companies[0].id) || null;
    S.company = me.company || (S.companies.find(c => c.id === S.companyId) || null);
    S.role = me.role;
    S.permissions = me.permissions || [];
    S.subscription = me.subscription || null;
    S.settings = me.settings || null;
    S.notifications = me.notifications || { unread: 0, critical: 0 };
    S.radar = me.radar || { total: 0, high: 0, impact: 0 };
    document.body.classList.remove('auth-mode');
    updateProfileUi();
    try { S.meta = await api('/api/meta'); } catch (_) { S.meta = null; }
    if (!S.companies.length) {
      // Kompaniyasi yo'q foydalanuvchi: yaratish taklifi
      $('#page-content').innerHTML = emptyState({
        icon: '◈', title: 'Kompaniya hali yaratilmagan',
        text: 'Buxgalteriya hisobini yuritish uchun kompaniya yarating. Hisoblar rejasi avtomatik shakllanadi.',
        cta: { label: '＋ Kompaniya yaratish', action: 'company:create' },
      });
      return;
    }
    await refreshBadges();
    loadMyWorkBadges();
    if (!location.hash) go('dashboard', {}, { replace: true });
    await renderPage();
  } catch (err) {
    if (err && err.status === 401) return showLogin();
    showLogin('Serverga ulanib bo‘lmadi. Qayta urinib ko‘ring.');
  }
}

// ══════════════════════════════ Amallar (delegatsiya) ══════════════════════

const ACTIONS = {
  'modal:close': (el) => closeModal(el),
  'page:reload': () => renderPage(),
  'page:go': (el) => { if (!el.disabled) go(S.page, { ...S.params, page: el.dataset.pageNum }); },
  'company:create': () => openCompanyForm(),
  'company:switch': (el) => companySwitcher(),
  'company:seed': (el) => confirmDialog({
    title: 'Demo ma’lumotlarni yuklash',
    message: 'Kompaniyaga real buxgalteriya yozuvlari, hisob-fakturalar, to‘lovlar va ombor harakatlari yaratiladi. Faqat bo‘sh kompaniyada ishlaydi.',
    confirmLabel: 'Yuklash',
    onConfirm: async () => {
      const res = await api(`/api/companies/${S.companyId}/seed`, { method: 'POST', body: { profile: 'demo' } });
      toast(res && res.skipped ? res.reason : 'Demo ma’lumotlar yuklandi.', res && res.skipped ? 'warn' : 'success');
      await renderPage();
    },
  }),
  'range:custom': () => openForm({
    title: 'Boshqa davr',
    description: 'Sana oralig‘ini tanlang. Barcha ko‘rsatkichlar shu davr bo‘yicha hisoblanadi.',
    fields: [
      { name: 'from', label: 'Boshlanish sanasi', type: 'date', required: true, value: S.range.from },
      { name: 'to', label: 'Tugash sanasi', type: 'date', required: true, value: S.range.to },
    ],
    submitLabel: 'Qo‘llash',
    onSubmit: async (data) => {
      if (data.from > data.to) throw ApiError('Boshlanish sanasi tugash sanasidan keyin bo‘lishi mumkin emas.');
      S.range = { key: 'custom', from: data.from, to: data.to, label: `${shortDate(data.from)} — ${shortDate(data.to)}` };
      const sel = $('#range-select');
      sel.value = 'custom';
      toast('Davr o‘zgartirildi: ' + S.range.label, 'success');
      await renderPage();
    },
  }),
  'search:open': () => { openModal('#search-layer'); const i = $('#search-input'); if (i) { i.value = ''; i.focus(); $('#search-results').innerHTML = '<p class="empty-hint">Qidiruv natijalari shu yerda ko‘rinadi.</p>'; } },
  'notifications:open': () => openNotifications(),
  'notifications:read-all': async () => { await api('/api/notifications/read-all', { method: 'POST' }); toast('Barchasi o‘qilgan deb belgilandi.', 'success'); await refreshBadges(); openNotifications(); },
  'notifications:read': async (el) => { await api(`/api/notifications/${el.dataset.id}/read`, { method: 'POST' }); await refreshBadges(); openNotifications(); },
  'notifications:remove': async (el) => { await api(`/api/notifications/${el.dataset.id}`, { method: 'DELETE' }); await refreshBadges(); openNotifications(); },
  'ai:open': (el) => { openModal('#ai-modal'); const q = el && el.dataset.q ? el.dataset.q : null; if (q) $('#chat-input').value = q; setTimeout(() => { const i = $('#chat-input'); if (i && !q) i.focus(); }, 60); },
  'ai:ask': (el) => { $('#chat-input').value = el.dataset.q || ''; $('#chat-form').dispatchEvent(new Event('submit', { cancelable: true })); },
  'logout': async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {} location.hash = ''; location.reload(); },
  'entry:new': () => openTransactionForm(),
  'modal:close-top': () => closeAllModals(),
  'nav:go': (el) => { const page = el.dataset.page || (el.closest('[data-page]') && el.closest('[data-page]').dataset.page); if (page) go(page); },
  'goto:link': (el) => { let link = null; try { link = JSON.parse(el.dataset.link || 'null'); } catch (_) { link = null; } if (link && link.page) go(link.page, link.params || {}); },
  'drill:open': (el) => { let drill = null; try { drill = JSON.parse(el.dataset.link || 'null'); } catch (_) { drill = null; } if (!drill) return; openDrill(drill); },
};

/** Drill-down: hisob/hujjat darajasigacha ochish (hisobotlardagi har bir raqam uchun) */
async function openDrill(drill) {
  if (drill.page) { go(drill.page, drill.params || {}); return; }
  const data = await api('/api/drill', { query: { type: drill.type, ...(drill.params || {}) } });
  const rows = data.rows || [];
  const columns = data.columns || (rows[0] ? Object.keys(rows[0]).filter(k => k !== 'drill') : []);
  const title = data.title || 'Batafsil ma’lumot';
  openForm({
    title,
    description: data.subtitle || `${rows.length} ta yozuv${data.total != null ? ` · jami ${money(data.total)}` : ''}`,
    wide: true,
    fields: [{ name: '_x', label: 'Manba', value: data.source || 'Buxgalteriya jurnali', readonly: true }],
    extraHtml: data.summary ? statRows(Object.entries(data.summary).map(([k, v]) => [k, typeof v === 'number' ? money(v) : esc(String(v))])) : ''
      + table(columns.map(k => k.replace(/_/g, ' ')), rows.slice(0, 200).map(r => columns.map(c => {
        const v = r[c];
        if (v == null) return '—';
        if (typeof v === 'number') return /(amount|summa|debit|credit|balance|total|jami|value)/i.test(c) ? money(v) : num(v);
        return esc(String(v));
      }))),
    submitLabel: 'Yopish',
    onSubmit: async () => {},
  });
}

document.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'page:go') { e.preventDefault(); }
  const handler = ACTIONS[action];
  if (!handler) return;
  e.preventDefault();
  try {
    await handler(target);
  } catch (err) {
    toast(err.message || 'Xatolik yuz berdi.', 'error', 7000);
  }
});

// ══════════════════════════════ Kompaniya boshqaruvi ═══════════════════════

function companySwitcher() {
  const host = $('#generic-modal-host');
  host.innerHTML = `<h2>Kompaniyani tanlash</h2><p>Har bir kompaniya ma’lumotlari to‘liq ajratilgan.</p>
    <div class="company-list">${S.companies.map(c => `
      <button class="company-row ${c.id === S.companyId ? 'active' : ''}" data-action="company:choose" data-id="${esc(c.id)}">
        <b>${esc(c.name)}</b><small>${esc({ superadmin: 'SuperAdmin', director: 'Rahbar', accountant: 'Buxgalter', employee: 'Xodim' }[c.role] || c.role || '')}</small>
      </button>`).join('')}</div>
    <div class="form-actions"><button class="ghost" data-action="modal:close">Yopish</button>
    <button class="primary" data-action="company:create">＋ Yangi kompaniya</button></div>`;
  openModal('#generic-modal');
}
ACTIONS['company:choose'] = async (el) => {
  const res = await api(`/api/companies/${el.dataset.id}/switch`, { method: 'POST' });
  S.companyId = res.active_company_id;
  S.role = res.role;
  S.company = res.company;
  closeAllModals();
  toast(`Kompaniya: ${res.company.name}`, 'success');
  await boot();
};

function openCompanyForm() {
  openForm({
    title: 'Yangi kompaniya',
    description: 'Yuridik shakl, STIR, MFO va bank rekvizitlari keyinroq sozlamalarda to‘ldiriladi.',
    fields: [
      { name: 'name', label: 'Kompaniya nomi', required: true, placeholder: 'Masalan: Orient Textile MChJ' },
      { name: 'legal_form', label: 'Yuridik shakl', type: 'select', options: (S.meta && S.meta.legal_forms ? S.meta.legal_forms : [{ key: 'mchj', label: 'MChJ' }]).map(f => ({ value: f.key, label: f.label })) },
      { name: 'inn', label: 'STIR (INN)', placeholder: '9 xonali raqam' },
      { name: 'tax_mode', label: 'Soliq rejimi', type: 'select', options: [{ value: 'vat', label: 'QQS to‘lovchisi' }, { value: 'turnover', label: 'Aylanma solig‘i' }] },
      { name: 'seed', label: 'Demo ma’lumotlarni yuklash (real buxgalteriya yozuvlari)', type: 'checkbox', value: false },
    ],
    wide: true,
    submitLabel: 'Kompaniya yaratish',
    onSubmit: async (data) => {
      const res = await api('/api/companies', { method: 'POST', body: { ...data, seed: !!data.seed } });
      S.companies = res.companies || S.companies;
      S.companyId = res.company.id;
      toast(`Kompaniya yaratildi: ${res.company.name}`, 'success');
      await boot();
    },
  });
}

// ══════════════════════════════ Yangi operatsiya formasi ═══════════════════

async function openTransactionForm(prefill = {}) {
  let accounts = [];
  let parties = [];
  try {
    const acc = await api('/api/accounts');
    accounts = (acc.items || acc.accounts || []).filter(a => a.active !== false);
    const p = await api('/api/parties');
    parties = p.items || [];
  } catch (err) { toast(err.message, 'error'); return; }
  const moneyAccounts = accounts.filter(a => a.is_cash || a.is_bank);
  const expenseAccounts = accounts.filter(a => a.type === 'expense');
  const incomeAccounts = accounts.filter(a => a.type === 'income');
  const categories = (S.meta && S.meta.categories) || { expense: [], income: [] };
  const types = (S.meta && S.meta.transaction_types) || [];

  const typeOptions = [
    { value: 'income', label: '＋ Kirim (daromad)' },
    { value: 'expense', label: '− Chiqim (xarajat)' },
    { value: 'transfer', label: '⇄ Kassa/bank o‘tkazmasi' },
    { value: 'refund', label: '↩︎ Qaytarish (refund)' },
    { value: 'adjustment', label: '◎ Tuzatish (inventarizatsiya)' },
    { value: 'journal', label: '≡ Jurnal yozuvi (qo‘lda)' },
  ];
  const form = openForm({
    title: 'Yangi operatsiya',
    description: 'Yozuv balanslanmasa (debet ≠ kredit) saqlanmaydi — tizim farqni ko‘rsatadi.',
    wide: true,
    fields: [
      { name: 'type', label: 'Operatsiya turi', type: 'select', options: typeOptions, value: prefill.type || 'expense' },
      { name: 'date', label: 'Sana', type: 'date', required: true, value: prefill.date || S.range.to || new Date().toISOString().slice(0, 10) },
      { name: 'description', label: 'Izoh / nomi', required: true, placeholder: 'Masalan: Ijara to‘lovi — Sentabr' },
      { name: 'amount', label: 'Summa (so‘m)', type: 'number', min: 0, step: '1', placeholder: '0' },
      { name: 'category', label: 'Kategoriya', type: 'select', options: [...categories.expense.map(c => ({ value: c.key, label: `Xarajat: ${c.label}` })), ...categories.income.map(c => ({ value: c.key, label: `Daromad: ${c.label}` }))] },
      { name: 'account', label: 'Kassa / bank hisobi', type: 'select', options: moneyAccounts.map(a => ({ value: a.code, label: `${a.code} — ${a.name}` })) },
      { name: 'party_id', label: 'Kontragent', type: 'select', options: [{ value: '', label: '— tanlanmagan —' }, ...parties.map(p => ({ value: p.id, label: `${p.name} (${p.kind === 'customer' ? 'mijoz' : p.kind === 'supplier' ? 'yetkazib beruvchi' : 'ikkalasi'})` }))] },
      { name: 'vat_rate', label: 'QQS stavkasi (%)', type: 'number', min: 0, max: 100, value: S.settings && S.settings.vat_enabled ? S.settings.vat_rate : 0, help: '0 — QQS hisoblanmaydi' },
      { name: 'to_account', label: 'Qabul qiluvchi hisob (o‘tkazma uchun)', type: 'select', options: [{ value: '', label: '— tanlanmagan —' }, ...moneyAccounts.map(a => ({ value: a.code, label: `${a.code} — ${a.name}` }))] },
      { name: 'reason', label: 'Sabab (qaytarish/tuzatish uchun)', placeholder: 'Masalan: xaridor shartnomani bekor qildi' },
    ],
    extraHtml: `<div class="notice">
      <b>Jurnal yozuvi uchun:</b> quyidagi qatorlarni to‘ldiring (faqat «Jurnal yozuvi» yoki «Tuzatish» turida ishlatiladi).
      <div id="journal-lines" class="journal-lines"></div>
      <button type="button" class="outline" data-action="entry:add-line" style="margin-top:8px">＋ Qator qo‘shish</button>
      <input type="hidden" id="journal-lines-json" name="lines_json" value="">
    </div>
    <div class="notice subtle">Buxgalteriya hisoblari: ${accounts.length} ta faol hisob (${expenseAccounts.length} xarajat, ${incomeAccounts.length} daromad).</div>`,
    submitLabel: 'Saqlash',
    onSubmit: async (data) => {
      const payload = { ...data };
      delete payload.lines_json;
      if (data.type === 'journal' || data.type === 'adjustment') {
        const lines = readJournalLines();
        if (!lines.length) throw ApiError('Jurnal yozuvi uchun kamida 2 qator kiritilishi kerak.');
        payload.lines = lines;
        delete payload.amount;
      } else {
        delete payload.to_account_extra;
        if (!num(data.amount)) throw ApiError('Summani kiriting (0 dan katta bo‘lishi kerak).');
      }
      if (data.type !== 'transfer') delete payload.to_account;
      const res = await api('/api/transactions', { method: 'POST', body: payload });
      const created = res.transaction || res.entry || res;
      if (created && created.status === 'pending_approval') {
        toast('Yozuv saqlandi va tasdiqlashga yuborildi (summa tasdiqlash chegarasidan yuqori).', 'warn', 8000);
      } else {
        toast('Operatsiya saqlandi va buxgalteriya jurnaliga tushdi.', 'success');
      }
      await refreshBadges();
      await renderPage();
    },
  });
  renderJournalLines(form, accounts, 2, prefill);
  if (prefill.type === 'journal' || prefill.type === 'adjustment') toggleJournalVisibility(form);
  const typeSelect = form.querySelector('[name=type]');
  typeSelect.addEventListener('change', () => toggleJournalVisibility(form));
}

function toggleJournalVisibility(form) {
  const type = form.querySelector('[name=type]').value;
  const lines = form.querySelector('#journal-lines');
  const addBtn = form.querySelector('[data-action="entry:add-line"]');
  const show = type === 'journal' || type === 'adjustment';
  if (lines) lines.style.display = show ? '' : 'none';
  if (addBtn) addBtn.style.display = show ? '' : 'none';
  const amount = form.querySelector('[name=amount]');
  if (amount) amount.required = !show;
}

function renderJournalLines(form, accounts, count = 2, prefill = {}) {
  const host = form.querySelector('#journal-lines');
  if (!host) return;
  const options = accounts.map(a => `<option value="${esc(a.code)}">${esc(a.code)} — ${esc(a.name)}</option>`).join('');
  const existing = Array.isArray(prefill.lines) && prefill.lines.length ? prefill.lines : null;
  const rows = existing || Array.from({ length: count }, () => ({ account: '', debit: '', credit: '' }));
  host.innerHTML = `<div class="journal-head"><span>Hisob</span><span>Debet</span><span>Kredit</span><span></span></div>` +
    rows.map((l, i) => `<div class="journal-row" data-row="${i}">
      <select class="jl-account">${options.replace(`value="${esc(l.account)}"`, `value="${esc(l.account)}" selected`)}</select>
      <input class="jl-debit" type="number" min="0" step="1" placeholder="0" value="${esc(l.debit || '')}">
      <input class="jl-credit" type="number" min="0" step="1" placeholder="0" value="${esc(l.credit || '')}">
      <button type="button" class="ghost small" data-action="entry:del-line">×</button>
    </div>`).join('') +
    `<div class="journal-totals" id="journal-totals"></div>`;
  const recalc = () => {
    const rows = readJournalLines();
    const debit = rows.reduce((a, r) => a + num(r.debit), 0);
    const credit = rows.reduce((a, r) => a + num(r.credit), 0);
    const diff = debit - credit;
    const el = form.querySelector('#journal-totals');
    if (el) {
      el.innerHTML = `Debet: <b>${money(debit)}</b> · Kredit: <b>${money(credit)}</b> · ${diff === 0 ? '<span class="ok-text">Balanslangan ✓</span>' : `<span class="danger-text">Farq: ${money(Math.abs(diff))} ${diff > 0 ? '(debet ko‘p)' : '(kredit ko‘p)'}</span>`}`;
    }
  };
  host.addEventListener('input', recalc);
  host.addEventListener('click', (e) => {
    const del = e.target.closest('[data-action="entry:del-line"]');
    if (del) { del.closest('.journal-row').remove(); recalc(); }
  });
  ACTIONS['entry:add-line'] = () => {
    const div = document.createElement('div');
    div.className = 'journal-row';
    div.innerHTML = `<select class="jl-account">${options}</select>
      <input class="jl-debit" type="number" min="0" step="1" placeholder="0">
      <input class="jl-credit" type="number" min="0" step="1" placeholder="0">
      <button type="button" class="ghost small" data-action="entry:del-line">×</button>`;
    host.insertBefore(div, host.querySelector('.journal-totals'));
    recalc();
  };
  recalc();
}

function readJournalLines() {
  const rows = $$('#journal-lines .journal-row');
  return rows.map(r => ({
    account: r.querySelector('.jl-account').value,
    debit: Number(r.querySelector('.jl-debit').value || 0),
    credit: Number(r.querySelector('.jl-credit').value || 0),
  })).filter(l => l.account && (num(l.debit) || num(l.credit)));
}

// ══════════════════════════════ Bildirishnomalar ═══════════════════════════

async function openNotifications() {
  const data = await api('/api/notifications', { query: { limit: 50 } });
  const items = data.items || [];
  const tone = { critical: 'danger', warning: 'warn', info: 'info', success: 'ok' };
  $('#notif-host').innerHTML = `<div class="card-head"><div><h2>Bildirishnomalar</h2><p>${num(data.counts && data.counts.unread)} ta o‘qilmagan</p></div>
      <button class="text-btn" data-action="notifications:read-all">Barchasini o‘qilgan qilish</button></div>
    ${items.length ? `<div class="notif-list">${items.map(n => `
      <div class="notif-item ${n.read_at ? 'read' : ''}">
        <span class="notif-dot ${tone[n.severity] || 'info'}"></span>
        <div class="notif-body">
          <b>${esc(n.title)}</b>
          <p>${esc(n.body || '')}</p>
          <small>${esc(timeAgo(n.created_at))}${n.link ? ` · <a href="#/${esc(n.link.page || 'dashboard')}${n.link.params && n.link.params.id ? '/' + esc(n.link.params.id) : ''}" data-action="modal:close">ochish</a>` : ''}</small>
        </div>
        ${n.read_at ? '' : `<button class="ghost small" data-action="notifications:read" data-id="${esc(n.id)}">O‘qildi</button>`}
        <button class="ghost small" data-action="notifications:remove" data-id="${esc(n.id)}">×</button>
      </div>`).join('')}</div>`
      : emptyState({ title: 'Bildirishnoma yo‘q', text: 'Muhim o‘zgarishlar bo‘lganda shu yerda ko‘rinadi.' })}`;
  openModal('#notif-layer');
}

// ══════════════════════════════ Qidiruv ════════════════════════════════════

let searchTimer = null;
async function runSearch(q) {
  const host = $('#search-results');
  if (!host) return;
  if (String(q).trim().length < 2) {
    host.innerHTML = '<p class="empty-hint">Kamida 2 belgi kiriting.</p>';
    return;
  }
  host.innerHTML = '<div class="skeleton"></div>';
  try {
    const res = await api('/api/search', { query: { q } });
    if (!res.total) {
      host.innerHTML = `<p class="empty-hint">«${esc(q)}» bo‘yicha hech narsa topilmadi. Boshqa so‘z yoki raqam bilan urinib ko‘ring.</p>`;
      return;
    }
    host.innerHTML = (res.groups || []).map(g => `
      <div class="search-group">
        <div class="search-group-head"><b>${esc(g.label || g.type)}</b><span>${g.items.length}</span></div>
        ${g.items.slice(0, 6).map(it => `<button class="search-item" data-action="search:go" data-link='${esc(JSON.stringify(it.link || { page: g.type, params: {} }))}'>
          <span>${esc(it.title)}</span><small>${esc(it.subtitle || '')}${it.amount != null ? ` · ${money(it.amount)}` : ''}</small>
        </button>`).join('')}
      </div>`).join('') + (res.hint ? `<p class="empty-hint">${esc(res.hint)}</p>` : '');
  } catch (err) {
    host.innerHTML = `<p class="empty-hint">${esc(err.message)}</p>`;
  }
}
ACTIONS['search:go'] = (el) => {
  let link = { page: 'dashboard', params: {} };
  try { link = JSON.parse(el.dataset.link); } catch (_) {}
  closeAllModals();
  go(link.page || 'dashboard', link.params || {});
};

// ══════════════════════════════ Chat (AI) ══════════════════════════════════

function chatBubble(text, cls = 'bot') {
  const el = document.createElement('div');
  el.className = `message ${cls}`;
  el.innerHTML = esc(text).replace(/\n/g, '<br>');
  $('#chat').appendChild(el);
  $('#chat').scrollTop = 99999;
  return el;
}

function renderAnswer(answer) {
  const blocks = (answer.blocks || []).map(b => {
    if (b.type === 'table' || b.type === 'metrics') {
      return `<div class="answer-block"><b>${esc(b.title)}</b>${statRows((b.rows || []).map(r => [r.label, r.value == null ? '—' : esc(String(r.value)), r.hint ? esc(r.hint) : (r.share ? esc(r.share) : '')]))}</div>`;
    }
    return `<div class="answer-block"><b>${esc(b.title)}</b><p>${esc(b.text || '')}</p></div>`;
  }).join('');
  const meta = [
    answer.classification ? `Tasnif: ${esc(answer.classification)}` : null,
    answer.confidence_label ? `Ishonch: ${esc(answer.confidence_label)}` : null,
    answer.data_range ? `Davr: ${esc(answer.data_range)}` : null,
    answer.provider ? esc(answer.provider) : null,
  ].filter(Boolean).join(' · ');
  const sources = (answer.sources || []).length
    ? `<div class="answer-sources"><b>Manbalar:</b> ${answer.sources.map(s => `${esc(s.label)}: ${esc(String(s.value))}`).join(' · ')}</div>` : '';
  return `${blocks}${sources}${meta ? `<div class="answer-meta">${meta}</div>` : ''}${answer.provider_note ? `<div class="answer-note">${esc(answer.provider_note)}</div>` : ''}`;
}

async function askAi(question) {
  chatBubble(question, 'user');
  const bubble = chatBubble('Tahlil qilinmoqda…', 'bot');
  try {
    const answer = await api('/api/ai/ask', { method: 'POST', body: { message: question, from: S.range.from, to: S.range.to } });
    bubble.innerHTML = renderAnswer(answer);
    const follow = $('#chat-suggestions');
    if (follow && answer.followups && answer.followups.length) {
      follow.innerHTML = answer.followups.map(f => `<button data-action="ai:ask" data-q="${esc(f)}">${esc(f)}</button>`).join('');
    }
  } catch (err) {
    bubble.innerHTML = `<span class="danger-text">${esc(err.message)}</span>`;
  }
}

// ══════════════════════════════ Hodisalar (eventlar) ═══════════════════════

function wireShell() {
  $$('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.classList.remove('show'); });
  });
  document.addEventListener('click', (e) => {
    const close = e.target.closest('.close');
    if (close) closeModal(close);
  });

  $('#nav').addEventListener('click', (e) => {
    const link = e.target.closest('a[data-page]');
    if (!link) return;
    go(link.dataset.page);
  });
  $('#open-ai').addEventListener('click', () => ACTIONS['ai:open']($('#open-ai')));
  $('#new-entry').addEventListener('click', () => openTransactionForm());
  $('#open-search').addEventListener('click', () => ACTIONS['search:open']());
  $('#open-notifications').addEventListener('click', () => ACTIONS['notifications:open']());
  $('#logout').addEventListener('click', () => ACTIONS['logout']());
  $('#company-switch').addEventListener('click', () => companySwitcher());

  $('#range-select').addEventListener('change', async (e) => {
    const key = e.target.value;
    if (key === 'custom') { ACTIONS['range:custom'](); return; }
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const ranges = {
      today: { from: today, to: today, label: RANGE_LABELS.today },
      week: { from: weekStart(today), to: today, label: RANGE_LABELS.week },
      month: { from: monthStart(today), to: monthEnd(today), label: RANGE_LABELS.month },
      last_month: (() => { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); const s = d.toISOString().slice(0, 10); return { from: s, to: monthEnd(s), label: RANGE_LABELS.last_month }; })(),
      quarter: (() => { const q = Math.floor(now.getMonth() / 3) * 3; const s = new Date(now.getFullYear(), q, 1).toISOString().slice(0, 10); const e = monthEnd(new Date(now.getFullYear(), q + 2, 1).toISOString().slice(0, 10)); return { from: s, to: e, label: RANGE_LABELS.quarter }; })(),
      year: { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31`, label: RANGE_LABELS.year },
      all: { from: '1900-01-01', to: '2999-12-31', label: RANGE_LABELS.all },
    };
    S.range = { key, ...ranges[key] };
    await renderPage();
  });
  function monthStart(d) { return `${String(d).slice(0, 7)}-01`; }
  function monthEnd(d) { const [y, m] = d.split('-').map(Number); const last = new Date(y, m, 0).getDate(); return `${d.slice(0, 7)}-${String(last).padStart(2, '0')}`; }
  function weekStart(d) { const dt = new Date(d + 'T00:00:00'); const day = (dt.getDay() + 6) % 7; dt.setDate(dt.getDate() - day); return dt.toISOString().slice(0, 10); }

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    await askAi(q);
  });

  $('#search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value;
    searchTimer = setTimeout(() => runSearch(value), 250);
  });
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const first = $('#search-results .search-item'); if (first) first.click(); }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ACTIONS['search:open'](); }
    if (e.key === 'Escape') closeAllModals();
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey && e.target === document.body) { e.preventDefault(); openTransactionForm(); }
  });

  window.addEventListener('hashchange', () => renderPage());
  setInterval(() => { if (S.user) refreshBadges(); }, 60000);
}

// ══════════════════════════════ Ishga tushirish ════════════════════════════

window.BUX = { S, ACTIONS, api, ApiError, go, toast, money, num, esc, can, chip, card, table, metricCard, statRows, emptyState, errorState, loadingBlock, pager, progressBar, barsChart, openForm, confirmDialog, openModal, closeAllModals, fmtDate, shortDate, timeAgo, pct, compact, definitionList, statusTone, severityTone, refreshBadges, renderPage, download, RANGE_LABELS };

wireShell();
boot();
