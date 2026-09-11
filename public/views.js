'use strict';
/** BUXAI — sahifalar: bosh sahifa, kunlik ish, operatsiyalar, hisob-fakturalar, to‘lovlar, debitorlik/kreditorlik. */
(function () {
  const { S, api, go, toast, money, num, esc, can, chip, card, table, metricCard, statRows, emptyState, errorState, pager,
    progressBar, barsChart, openForm, confirmDialog, fmtDate, shortDate, timeAgo, pct, compact, definitionList,
    statusTone, severityTone, download } = window.BUX;
  const VIEWS = (window.VIEWS = window.VIEWS || {});
  const rangeQs = () => ({ from: S.range.from, to: S.range.to });
  const rangeLabel = () => S.range.label || 'Bu oy';

  function kpiRow(overview) {
    const k = overview.kpi_map || {};
    const items = [
      ['cash', 'Kassa va bank', '◈', 'blue'],
      ['revenue', 'Daromad', '↗', 'purple'],
      ['expense', 'Xarajat', '↘', 'orange'],
      ['profit', 'Sof foyda', '✦', 'green-icon'],
    ];
    return `<section class="metrics">${items.map(([key, label, icon, tone]) => {
      const kpi = k[key]; if (!kpi) return '';
      const trend = kpi.change == null ? null : {
        direction: kpi.change >= 0 ? 'up' : 'down',
        text: `${kpi.change >= 0 ? '↗' : '↘'} ${Math.abs(kpi.change).toFixed(1)}%`,
        note: kpi.previous == null ? 'o‘tgan davrga nisbatan' : `o‘tgan davr: ${compact(kpi.previous)}`,
      };
      return metricCard({ label: kpi.label || label, value: kpi.formatted || money(kpi.value), icon, tone, trend, hint: kpi.hint, action: kpi.drill ? { label: 'Batafsil →', action: 'drill:open' } : null });
    }).join('')}</section>`;
  }

  function trendOf(overview) {
    const trend = overview.trend || [];
    if (!trend.length) return emptyState({ title: 'Ma’lumot yo‘q', text: 'Tendensiya uchun bu davrda yozuvlar yo‘q.' });
    return barsChart(trend.map(t => ({
      label: t.label, short: (t.period || '').slice(5) || t.label,
      in: t.revenue, out: t.expense,
    })), { height: 150 });
  }

  // ═══════════════════════════════ Bosh sahifa ═════════════════════════════
  VIEWS.dashboard = {
    async load() {
      const [data, work] = await Promise.all([
        api('/api/dashboard', { query: rangeQs() }),
        api('/api/my-work').catch(() => null),
      ]);
      if (!data.has_data) {
        return `${emptyState({
          icon: '▦', title: 'Hisobot yaratish uchun tranzaksiyalar qo‘shing',
          text: 'Hozircha bu davrda buxgalteriya yozuvlari yo‘q. Birinchi operatsiyani kiritsangiz, barcha ko‘rsatkichlar real ma’lumotdan hisoblanadi.',
          cta: { label: '＋ Yangi operatsiya', action: 'entry:new' },
          hint: 'Alternativa: bank ko‘chirmasini yuklang yoki demo ma’lumotlarni yuklab sinab ko‘ring.',
        })}`;
      }
      const attention = data.attention || {};
      const radar = data.radar || {};
      const insight = data.insight || {};
      const health = data.health || {};
      const goals = data.goals || [];
      return `
      ${kpiRow(data)}
      <section class="grid-main">
        <div class="card flow-card">
          <div class="card-head"><div><h2>Pul oqimi</h2><p>Oylar bo‘yicha kirim va chiqim (real jurnal)</p></div>
            <span class="chip neutral">${esc(rangeLabel())}</span></div>
          ${trendOf(data)}
        </div>
        <div class="card goals">
          <div class="card-head"><div><h2>Maqsadlar</h2><p>Real ko‘rsatkichlar bo‘yicha progress</p></div>
            <button class="text-btn" data-page="goals" data-action="nav:go">Boshqarish →</button></div>
          ${goals.length ? goals.slice(0, 3).map(g => `
            <div class="goal">
              <div class="goal-title"><span>${esc(g.title || g.label)}</span><b>${pct(g.percent)}</b></div>
              ${progressBar(g.bar_percent != null ? g.bar_percent : g.percent, g.status_color === 'orange' ? 'orange-progress' : '')}
              <small>${esc(money(g.current))} / ${esc(money(g.target))}${g.message ? ` · ${esc(g.message)}` : ''}</small>
            </div>`).join('')
            : `<p class="empty-hint">Maqsad qo‘yilmagan. Maqsadlar real ma’lumot asosida avtomatik hisoblanadi.</p>`}
          <button class="outline full" data-action="goal:new">＋ Yangi maqsad qo‘shish</button>
        </div>
      </section>
      <section class="grid-main">
        <div class="card transactions">
          <div class="card-head"><div><h2>So‘nggi operatsiyalar</h2><p>Moliyaviy harakatlaringiz</p></div>
            <button class="text-btn" data-page="transactions" data-action="nav:go">Barchasini ko‘rish →</button></div>
          ${table(['Operatsiya', 'Kategoriya', 'Sana', 'Summa', 'Holat'], (data.recent_transactions || []).map(t => [
            `<div class="trans-title"><div class="trans-icon ${t.type === 'expense' ? 'exp' : ''}">${t.type === 'income' ? '↗' : t.type === 'expense' ? '↘' : '⇄'}</div>${esc(t.description || t.memo || '—')}</div>`,
            esc(t.category_label || t.category || '—'),
            shortDate(t.date),
            `<span class="${t.type === 'income' ? 'income-text' : t.type === 'expense' ? 'expense-text' : ''}">${t.type === 'income' ? '+' : t.type === 'expense' ? '−' : ''} ${esc(money(t.amount))}</span>`,
            chip(t.status === 'pending_approval' ? 'Tasdiqlash kutilmoqda' : 'Jurnalda', statusTone(t.status)),
          ]), { empty: emptyState({ title: 'Operatsiya yo‘q', text: 'Bu davrda yozuvlar topilmadi.' }) })}
        </div>
        <div class="card insight">
          <div class="insight-title"><div class="spark">✦</div><div><h2>BuxAI tahlili</h2><span>Faqat real raqamlar asosida</span></div></div>
          <div class="quote">“</div>
          <p>${esc(insight.text || 'Ma’lumot yetarli emas.')}</p>
          ${insight.classification ? `<div class="answer-meta">Tasnif: ${esc(insight.classification)}${insight.confidence_label ? ` · Ishonch: ${esc(insight.confidence_label)}` : ''}</div>` : ''}
          <button class="ai-link" data-action="ai:open">Batafsil tahlil qilish <span>→</span></button>
        </div>
      </section>
      <section class="grid-bottom">
        <div class="card">
          <div class="card-head"><div><h2>Diqqat talab qiladi</h2><p>Real holat bo‘yicha hisoblangan ko‘rsatkichlar</p></div>
            <button class="text-btn" data-page="radar" data-action="nav:go">Xato Radar →</button></div>
          ${statRows([
            ['Solishtirilmagan bank qatorlari', `<b>${num(attention.unmatched_bank_rows)}</b>`, attention.unmatched_bank_rows ? 'Bank solishtirish bo‘limini oching' : 'Hammasi solishtirilgan'],
            ['Tasdiqlash kutilayotgan so‘rovlar', `<b>${num(attention.pending_approvals)}</b>`, attention.pending_approvals ? 'Tasdiqlash markazida ko‘ring' : 'Kutilayotgan so‘rov yo‘q'],
            ['Muddati o‘tgan hisob-fakturalar', `<b>${num(attention.overdue_invoices)}</b>`, attention.overdue_invoices ? 'Debitorlik bo‘limida undirish' : 'Muddati o‘tganlar yo‘q'],
            ['Muddati o‘tgan hisoblar (kreditorlik)', `<b>${num(attention.overdue_bills)}</b>`, attention.overdue_bills ? 'To‘lov rejasini tuzing' : 'Muddati o‘tganlar yo‘q'],
            ['Kam qolgan mahsulotlar', `<b>${num(attention.low_stock)}</b>`, attention.low_stock ? 'Ombor bo‘limida to‘ldirish' : 'Qoldiqlar yetarli'],
            ['Yuqori jiddiylikdagi xatolar', `<b>${num(attention.radar_high)}</b>`, radar.impact ? `Moliyaviy ta’sir: ${money(radar.impact)}` : ''],
          ])}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Moliyaviy salomatlik</h2><p>Real ko‘rsatkichlar asosida hisoblangan</p></div></div>
          ${health.available ? `
            <div class="health-big"><div class="health-ring ${health.score >= 70 ? '' : health.score >= 50 ? 'warn' : 'bad'}">${health.score}<small>%</small></div>
            <div><b>${esc(health.rating || '')}</b><small>${esc(health.explanation || '')}</small></div></div>
            ${statRows((health.positives || []).slice(0, 2).map(p => ['➕ ' + p.label, '', esc(p.reason)]))}
            ${statRows((health.risks || []).slice(0, 2).map(r => ['⚠ ' + r.label, '', esc(r.reason)]))}
            <div class="answer-meta">${esc(health.formula || '')}</div>
            <button class="text-btn" data-page="advisor" data-action="nav:go">To‘liq tahlil →</button>`
            : `<p class="empty-hint">${esc(health.message || 'Salomatlik skorini hisoblash uchun ma’lumot yetarli emas.')}</p>`}
        </div>
      </section>
      ${work && work.priorities && work.priorities.length ? `
      <section class="card">
        <div class="card-head"><div><h2>Bugungi ustuvor vazifalar</h2><p>My Work markazidan</p></div>
          <button class="text-btn" data-page="my-work" data-action="nav:go">Barchasi →</button></div>
        ${table(['Vazifa', 'Jiddiylik', 'Moliyaviy ta’sir', 'Batafsil'], work.priorities.slice(0, 5).map(p => [
          esc(p.title), chip(p.severity_label || p.severity, severityTone(p.severity)), p.amount ? money(p.amount) : '—',
          `<button class="ghost small" data-link='${esc(JSON.stringify(p.link || { page: 'my-work' }))}' data-action="goto:link">Ochish</button>`,
        ]))}
      </section>` : ''}`;
    },
  };

  // ═══════════════════════════ Mening ishim ════════════════════════════════
  VIEWS['my-work'] = {
    async load() {
      const data = await api('/api/my-work');
      const totals = data.totals || {};
      const priorities = data.priorities || [];
      const tasks = data.tasks || [];
      return `
      <section class="welcome">
        <div><h1>${esc(data.greeting || 'Xayrli kun')} <span>✦</span></h1>
        <p>${esc(S.company ? S.company.name : '')} · ${esc(rangeLabel())} · bugun ${fmtDate(new Date().toISOString().slice(0, 10))}</p></div>
        <div class="health"><div class="health-ring ${totals.critical ? 'bad' : ''}">${num(totals.total)}</div><div><b>Faol vazifalar</b><small>${num(totals.critical)} ta kritik · moliyaviy ta’sir ${compact(totals.financial_impact)}</small></div></div>
      </section>
      <section class="metrics">
        ${metricCard({ label: 'Tasdiqlash kutayotgan', value: num(data.approvals_pending), icon: '☑', tone: 'orange', hint: 'Approval Center' })}
        ${metricCard({ label: 'Xato Radar topilmalari', value: num(data.radar && data.radar.total), icon: '◬', tone: 'purple', hint: data.radar ? `Yuqori jiddiylik: ${num(data.radar.high)}` : '' })}
        ${metricCard({ label: 'Muddati o‘tgan vazifalar', value: (data.overdue || []).length, icon: '◷', tone: 'blue' })}
        ${metricCard({ label: 'Bugun bajariladigan', value: (data.today && data.today.tasks ? data.today.tasks.length : 0) + (data.today && data.today.actions ? data.today.actions.length : 0), icon: '◆', tone: 'green-icon' })}
      </section>
      <section class="grid-main">
        <div class="card">
          <div class="card-head"><div><h2>Ustuvorliklar</h2><p>Jiddiylik va moliyaviy ta’sir bo‘yicha tartiblangan</p></div></div>
          ${priorities.length ? priorities.map(p => `
            <div class="priority-row">
              <span class="sev-bar ${severityTone(p.severity)}"></span>
              <div class="priority-body">
                <div class="priority-head"><b>${esc(p.title)}</b> ${chip(p.severity_label || p.severity, severityTone(p.severity))} ${p.amount ? chip(money(p.amount), 'neutral') : ''}</div>
                <p>${esc(p.detail || '')}</p>
                ${p.suggestion ? `<small>${esc(p.suggestion)}</small>` : ''}
              </div>
              <button class="ghost small" data-link='${esc(JSON.stringify(p.link || { page: 'my-work' }))}' data-action="goto:link">Ochish</button>
            </div>`).join('')
            : emptyState({ title: 'Ustuvor vazifa yo‘q', text: 'Barcha tekshiruvlar bajarilgan — xatolar aniqlanmadi.' })}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>AI tavsiyalari</h2><p>Real ma’lumotlarga asoslangan</p></div></div>
          ${(data.ai_recommendations || []).length ? `<div class="insight-list">${data.ai_recommendations.map(r => `
            <div class="insight-item"><b>${esc(r.title)}</b><p>${esc(r.detail || '')}</p>${r.evidence ? `<small>${esc(r.evidence)}</small>` : ''}</div>`).join('')}</div>`
            : `<p class="empty-hint">Hozircha tavsiya yo‘q — AI real ma’lumot yig‘ilishini kutmoqda.</p>`}
          <div class="notice subtle" style="margin-top:12px">
            <b>Nima bo‘ldi:</b> ${esc((data.attention && data.attention.what_happened && data.attention.what_happened[0] && data.attention.what_happened[0].what) || 'Yangi o‘zgarish yo‘q')}
          </div>
        </div>
      </section>
      <section class="grid-bottom">
        <div class="card">
          <div class="card-head"><div><h2>Bugun va yaqin kunlar</h2><p>Muddatli vazifalar va to‘lovlar</p></div>
            <button class="primary" data-action="task:new">＋ Vazifa</button></div>
          ${table(['Vazifa', 'Muddat', 'Jiddiylik', 'Manba', ''], [
            ...(data.upcoming || []).map(u => [esc(u.title), shortDate(u.due_date || u.date), chip(u.severity_label || u.severity || 'info', severityTone(u.severity)), esc(u.source || 'Tizim'), `<button class="ghost small" data-link='${esc(JSON.stringify(u.link || { page: 'dashboard' }))}' data-action="goto:link">Ochish</button>`]),
            ...tasks.map(t => [esc(t.title), t.due_date ? shortDate(t.due_date) : '—', chip(t.status === 'done' ? 'Bajarildi' : 'Ochiq', t.status === 'done' ? 'ok' : 'warn'), 'Vazifa',
              t.status === 'done' ? '' : `<button class="ghost small" data-action="task:complete" data-id="${esc(t.id)}">Bajarildi</button>`]),
          ], { empty: emptyState({ title: 'Rejalashtirilgan ish yo‘q', text: 'Vazifalar va muddatli to‘lovlar bu yerda ko‘rinadi.' }) })}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Bugungi harakatlar</h2><p>Tizim qayd etgan o‘zgarishlar</p></div>
            <button class="text-btn" data-page="audit" data-action="nav:go">Audit jurnali →</button></div>
          ${(data.attention && data.attention.what_happened || []).length ? statRows(data.attention.what_happened.map(h => [h.what, '', `${esc(h.who || '—')} · ${esc(timeAgo(h.at))}`])) : `<p class="empty-hint">Bugun o‘zgarish qayd etilmagan.</p>`}
          ${(data.attention && data.attention.what_is_wrong || []).length ? `<div class="notice warn"><b>E’tibor bering:</b> ${esc((data.attention.what_is_wrong || []).slice(0, 3).join(' · '))}</div>` : ''}
          ${(data.attention && data.attention.what_is_next || []).length ? `<div class="notice"><b>Keyingi qadam:</b> ${esc((data.attention.what_is_next || []).slice(0, 3).join(' · '))}</div>` : ''}
        </div>
      </section>`;
    },
    async mount() {
      const form = document.createElement('div');
      form.id = 'task-form-host';
      document.body.appendChild(form);
      window.BUX.ACTIONS['task:new'] = () => openForm({
        title: 'Yangi vazifa', fields: [
          { name: 'title', label: 'Vazifa', required: true, placeholder: 'Masalan: QQS deklaratsiyasini tayyorlash' },
          { name: 'due_date', label: 'Muddat', type: 'date', value: new Date().toISOString().slice(0, 10) },
          { name: 'priority', label: 'Muhimlik', type: 'select', options: [{ value: 'medium', label: 'O‘rta' }, { value: 'high', label: 'Yuqori' }, { value: 'low', label: 'Past' }] },
          { name: 'note', label: 'Izoh', type: 'textarea', rows: 2 },
        ], submitLabel: 'Saqlash',
        onSubmit: async (data) => { await api('/api/tasks', { method: 'POST', body: data }); toast('Vazifa qo‘shildi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['task:complete'] = async (el) => { await api(`/api/tasks/${el.dataset.id}/complete`, { method: 'POST' }); toast('Vazifa bajarildi.', 'success'); window.BUX.renderPage(); };
    },
  };

  // ═══════════════════════════ Operatsiyalar ═══════════════════════════════
  VIEWS.transactions = {
    async load(params) {
      const page = num(params.page) || 1;
      const query = {
        ...rangeQs(), page, page_size: 25,
        type: params.type, category: params.category, search: params.q, status: params.status,
        party_id: params.party_id, account: params.account, include_void: params.void === '1' ? '1' : undefined,
      };
      const [data, accounts, parties] = await Promise.all([
        api('/api/transactions', { query }),
        api('/api/accounts').catch(() => ({ items: [] })),
        api('/api/parties').catch(() => ({ items: [] })),
      ]);
      const items = data.items || [];
      const types = (S.meta && S.meta.transaction_types) || [];
      const cats = (S.meta && S.meta.categories) || { expense: [], income: [] };
      const filters = `
        <div class="filters">
          <input id="txn-search" placeholder="Qidirish: izoh, kontragent, summa…" value="${esc(params.q || '')}">
          <select id="txn-type"><option value="">Barcha turlar</option>${types.map(t => `<option value="${esc(t.key || t)}" ${params.type === (t.key || t) ? 'selected' : ''}>${esc(t.label || t)}</option>`).join('')}</select>
          <select id="txn-category"><option value="">Barcha kategoriyalar</option>
            ${cats.expense.map(c => `<option value="${esc(c.key)}" ${params.category === c.key ? 'selected' : ''}>Xarajat: ${esc(c.label)}</option>`).join('')}
            ${cats.income.map(c => `<option value="${esc(c.key)}" ${params.category === c.key ? 'selected' : ''}>Daromad: ${esc(c.label)}</option>`).join('')}
          </select>
          <select id="txn-party"><option value="">Barcha kontragentlar</option>${(parties.items || []).map(p => `<option value="${esc(p.id)}" ${params.party_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
          <select id="txn-account"><option value="">Barcha hisoblar</option>${(accounts.items || accounts.accounts || []).map(a => `<option value="${esc(a.code)}" ${params.account === a.code ? 'selected' : ''}>${esc(a.code)} — ${esc(a.name)}</option>`).join('')}</select>
          <label class="inline-check"><input type="checkbox" id="txn-void" ${params.void === '1' ? 'checked' : ''}> Bekor qilinganlar</label>
          <button class="ghost" data-action="txn:export">CSV yuklab olish</button>
          <button class="primary" data-action="entry:new">＋ Yangi operatsiya</button>
        </div>`;
      return `
      ${card({
        title: 'Operatsiyalar jurnali', subtitle: `${rangeLabel()} · jami ${num(data.total)} yozuv · debet = kredit nazorati`,
        body: filters + table(
          ['№', 'Sana', 'Operatsiya', 'Kontragent', 'Kategoriya', 'Summa', 'Holat', ''],
          items.map(t => ({
            className: t.status === 'void' ? 'row-void' : '',
            cells: [
              `<b>${esc(t.no || '')}</b>${t.source && t.source.type === 'reversal' ? ` ${chip('teskari', 'info')}` : ''}`,
              shortDate(t.date),
              `<div class="trans-title"><div class="trans-icon ${t.type === 'expense' ? 'exp' : ''}">${t.type === 'income' ? '↗' : t.type === 'expense' ? '↘' : t.type === 'transfer' ? '⇄' : '≡'}</div>
                <div><b>${esc(t.description || t.memo || '—')}</b><br><small>${esc(t.account_label || t.money_account || '')}</small></div></div>`,
              esc(t.party_name || '—'),
              esc(t.category_label || '—'),
              `<b>${esc(money(t.amount))}</b>${t.vat_amount ? `<br><small>QQS: ${esc(money(t.vat_amount))}</small>` : ''}`,
              chip(t.status_label || (t.status === 'void' ? 'Bekor qilingan' : t.status === 'pending_approval' ? 'Tasdiqlashda' : 'Jurnalda'), statusTone(t.status)),
              `<div class="row-actions">
                <button class="ghost small" data-action="txn:view" data-id="${esc(t.id)}">Ko‘rish</button>
                ${t.status === 'posted' ? `<button class="ghost small" data-action="txn:duplicate" data-id="${esc(t.id)}">Nusxa</button>` : ''}
                ${t.status === 'posted' && can('transactions.reverse') ? `<button class="ghost small danger" data-action="txn:reverse" data-id="${esc(t.id)}">Bekor qilish</button>` : ''}
              </div>`,
            ],
          })),
          { empty: emptyState({ icon: '⇄', title: 'Operatsiya topilmadi', text: 'Filtrni o‘zgartiring yoki yangi operatsiya kiriting.', cta: { label: '＋ Yangi operatsiya', action: 'entry:new' } }) }
        ) + pager({ total: data.total, page: data.page || page, pageSize: 25 }),
      })}
      <div class="notice subtle">Har bir yozuv ikki tomonlama (debet/kredit) tamoyili bo‘yicha saqlanadi. Yozuvlar o‘chirilmaydi — faqat teskari yozuv bilan bekor qilinadi (audit saqlanadi).</div>`;
    },
    async mount() {
      const push = (patch, resetPage = true) => go('transactions', { ...S.params, ...patch, page: resetPage ? 1 : S.params.page, q: patch.q !== undefined ? patch.q : S.params.q });
      let timer = null;
      const search = document.getElementById('txn-search');
      if (search) search.addEventListener('input', (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => push({ q: v }), 400); });
      const bind = (id, key) => { const el = document.getElementById(id); if (el) el.addEventListener('change', (e) => push({ [key]: e.target.value })); };
      bind('txn-type', 'type'); bind('txn-category', 'category'); bind('txn-party', 'party_id'); bind('txn-account', 'account');
      const voidEl = document.getElementById('txn-void');
      if (voidEl) voidEl.addEventListener('change', (e) => push({ void: e.target.checked ? '1' : '' }));
      window.BUX.ACTIONS['txn:export'] = () => download(`/api/transactions/export?from=${S.range.from}&to=${S.range.to}${S.params.q ? `&search=${encodeURIComponent(S.params.q)}` : ''}`, `operatsiyalar-${S.range.from}.csv`);
      window.BUX.ACTIONS['txn:view'] = async (el) => {
        const t = await api(`/api/transactions/${el.dataset.id}`);
        const entry = t.entry || t;
        openForm({
          title: `${entry.no} — ${entry.description || entry.memo || ''}`,
          description: `${fmtDate(entry.date)} · ${entry.status === 'void' ? 'BEKOR QILINGAN' : entry.status === 'pending_approval' ? 'Tasdiqlash kutilmoqda' : 'Jurnalda'}`,
          wide: true,
          fields: [
            { name: 'date', label: 'Sana', type: 'date', value: entry.date, readonly: entry.status !== 'pending_approval' },
            { name: 'description', label: 'Izoh', value: entry.description || entry.memo || '', readonly: entry.status !== 'pending_approval' },
          ],
          extraHtml: `${table(['Hisob', 'Debet', 'Kredit', 'Izoh'], (entry.lines || []).map(l => [
            `${esc(l.account)} ${esc(l.account_name || '')}`, l.debit ? money(l.debit) : '—', l.credit ? money(l.credit) : '—', esc(l.description || ''),
          ]), { empty: '<p class="empty-hint">Qatorlar yo‘q</p>' })}
          ${definitionList([
            ['Manba', esc((entry.source && entry.source.type) || '—')],
            ['Kiritgan', esc(entry.created_by_name || '—')],
            ['Yaratilgan', esc(entry.created_at ? timeAgo(entry.created_at) : '—')],
            ['Teskari yozuv', entry.reversed_by ? esc(entry.reversed_by) : '—'],
            ['Bekor qilish sababi', esc(entry.void_reason || '—')],
          ])}`,
          submitLabel: 'Yopish',
          onSubmit: async () => {},
        });
      };
      window.BUX.ACTIONS['txn:duplicate'] = (el) => confirmDialog({
        title: 'Operatsiyani nusxalash', message: 'Yozuv nusxasi yangi sana bilan yaratiladi va jurnalga tushadi.',
        confirmLabel: 'Nusxalash',
        onConfirm: async () => { const res = await api(`/api/transactions/${el.dataset.id}/duplicate`, { method: 'POST' }); toast(`Nusxa yaratildi: ${(res.transaction || res).no || ''}`, 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['txn:reverse'] = (el) => confirmDialog({
        title: 'Yozuvni bekor qilish',
        message: 'Yozuv o‘chirilmaydi: teskari (reversal) yozuv yaratiladi va asl yozuv «bekor qilingan» holatiga o‘tadi.',
        confirmLabel: 'Bekor qilish', danger: true, extraField: { label: 'Sabab' },
        onConfirm: async (reason) => { await api(`/api/transactions/${el.dataset.id}/reverse`, { method: 'POST', body: { reason } }); toast('Yozuv bekor qilindi (teskari yozuv yaratildi).', 'success'); window.BUX.renderPage(); },
      });
    },
  };

  // ═══════════════════════ Hisob-fakturalar (sotuv) ════════════════════════
  VIEWS.invoices = {
    async load(params) {
      const page = num(params.page) || 1;
      const [data, parties] = await Promise.all([
        api('/api/invoices', { query: { ...rangeQs(), status: params.status, customer_id: params.customer_id, search: params.q, page, page_size: 25, aging_bucket: params.aging } }),
        api('/api/parties', { query: { kind: 'customer' } }).catch(() => ({ items: [] })),
      ]);
      const summary = data.summary || {};
      const items = data.items || [];
      return `
      <section class="metrics">
        ${metricCard({ label: 'Jami hisob-fakturalar', value: money(summary.total || 0), icon: '▤', tone: 'purple', hint: `${num(summary.count)} ta hujjat` })}
        ${metricCard({ label: 'To‘langan', value: money(summary.paid || 0), icon: '✓', tone: 'green-icon' })}
        ${metricCard({ label: 'Ochiq qoldiq', value: money(summary.open || 0), icon: '◔', tone: 'orange', hint: 'Debitorlik bilan solishtiriladi' })}
        ${metricCard({ label: 'Muddati o‘tgan', value: money(summary.overdue || 0), icon: '⚠', tone: 'orange', hint: `${num(summary.overdue_count)} ta hujjat` })}
      </section>
      ${card({
        title: 'Hisob-fakturalar', subtitle: `${rangeLabel()} · holat bo‘yicha filtr`,
        actions: `<div class="row-actions"><button class="ghost" data-action="invoice:new">＋ Yangi hisob-faktura</button></div>`,
        body: `<div class="filters">
            <input id="inv-search" placeholder="Qidirish: raqam, mijoz…" value="${esc(params.q || '')}">
            <select id="inv-status">
              <option value="">Barcha holatlar</option>
              ${Object.entries((S.meta && S.meta.invoice_statuses) || {}).map(([k, v]) => `<option value="${esc(k)}" ${params.status === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
            </select>
            <select id="inv-customer"><option value="">Barcha mijozlar</option>${(parties.items || []).map(p => `<option value="${esc(p.id)}" ${params.customer_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
            <select id="inv-aging"><option value="">Barcha muddatlar</option>
              ${[['not_due', 'Muddati kelmagan'], ['0-30', '0–30 kun'], ['31-60', '31–60 kun'], ['61-90', '61–90 kun'], ['90+', '90+ kun']].map(([k, l]) => `<option value="${k}" ${params.aging === k ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          ${table(['Raqam', 'Mijoz', 'Berilgan', 'Muddat', 'Summa', 'To‘langan', 'Qoldiq', 'Holat', ''], items.map(i => [
            `<b>${esc(i.no)}</b>`,
            esc(i.customer_name || '—'),
            shortDate(i.issue_date),
            shortDate(i.due_date) + (i.overdue_days ? `<br><small class="danger-text">${i.overdue_days} kun kechikdi</small>` : ''),
            money(i.total),
            money(i.paid_amount || 0),
            money(i.open_amount || 0),
            chip(i.status_label || i.status, statusTone(i.status)),
            `<div class="row-actions"><button class="ghost small" data-action="invoice:view" data-id="${esc(i.id)}">Ochish</button></div>`,
          ]), { empty: emptyState({ icon: '▤', title: 'Hisob-faktura yo‘q', text: 'Birinchi hisob-fakturani yarating — u darhol daromad va debitorlikka ta’sir qiladi.', cta: { label: '＋ Yangi hisob-faktura', action: 'invoice:new' } }) })}
        ${pager({ total: data.total, page: data.page || page, pageSize: 25 })}`,
      })}`;
    },
    async mount() {
      const push = (patch, reset = true) => go('invoices', { ...S.params, ...patch, page: reset ? 1 : S.params.page });
      let timer = null;
      const search = document.getElementById('inv-search');
      if (search) search.addEventListener('input', (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => push({ q: v }), 400); });
      const bind = (id, key) => { const el = document.getElementById(id); if (el) el.addEventListener('change', (e) => push({ [key]: e.target.value })); };
      bind('inv-status', 'status'); bind('inv-customer', 'customer_id'); bind('inv-aging', 'aging');
      window.BUX.ACTIONS['invoice:new'] = () => openInvoiceForm();
      window.BUX.ACTIONS['invoice:view'] = (el) => openInvoiceDetail(el.dataset.id);
    },
  };

  let INVOICE_PRODUCTS = [];
  async function openInvoiceForm() {
    const [partiesRes, productsRes] = await Promise.all([
      api('/api/parties', { query: { kind: 'customer' } }),
      api('/api/products').catch(() => ({ items: [] })),
    ]);
    const customers = partiesRes.items || [];
    if (!customers.length) {
      toast('Avval mijoz (kontragent) yarating.', 'warn');
      go('parties');
      return;
    }
    const products = productsRes.items || [];
    INVOICE_PRODUCTS = products;
    const form = openForm({
      title: 'Yangi hisob-faktura',
      description: 'Hisob-faktura rasmiylashtirilganda AR (0610) va daromad hisobiga yozuv tushadi.',
      wide: true,
      fields: [
        { name: 'customer_id', label: 'Mijoz', type: 'select', options: customers.map(c => ({ value: c.id, label: `${c.name}${c.inn ? ` · STIR ${c.inn}` : ''}` })), required: true },
        { name: 'issue_date', label: 'Berilgan sana', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
        { name: 'due_date', label: 'To‘lov muddati', type: 'date' },
        { name: 'vat_enabled', label: 'QQS hisoblansin', type: 'checkbox', value: !!(S.settings && S.settings.vat_enabled) },
        { name: 'notes', label: 'Izoh (shartnoma raqami va h.k.)', placeholder: 'Masalan: Shartnoma №12 bo‘yicha' },
      ],
      extraHtml: `<div class="notice"><b>Qatorlar:</b><div id="invoice-items" class="invoice-items"></div>
        <button type="button" class="outline" data-action="invoice:add-item" style="margin-top:8px">＋ Qator qo‘shish</button>
        <div id="invoice-total" class="journal-totals"></div></div>`,
      submitLabel: 'Yaratish va rasmiylashtirish',
      onSubmit: async (data) => {
        const items = readInvoiceItems();
        if (!items.length) throw window.BUX.ApiError('Kamida bitta qator qo‘shing (nomi va narxi bilan).');
        const res = await api('/api/invoices', { method: 'POST', body: { ...data, items } });
        toast(`Hisob-faktura yaratildi: ${(res.invoice || res).no}`, 'success');
        window.BUX.refreshBadges();
        window.BUX.renderPage();
      },
    });
    renderInvoiceItems(document.getElementById('invoice-items'), products, 1);
    window.BUX.ACTIONS['invoice:add-item'] = () => renderInvoiceItemsAdd(products);
  }

  function invoiceItemRowHtml(products) {
    return `<div class="invoice-row">
      <select class="ii-product"><option value="">— erkin qator —</option>${products.map(p => `<option value="${esc(p.id)}" data-price="${esc(p.sale_price || 0)}" data-unit="${esc(p.unit || 'dona')}">${esc(p.name)} (${esc(money(p.sale_price || 0))})</option>`).join('')}</select>
      <input class="ii-name" placeholder="Nomi">
      <input class="ii-qty" type="number" min="0" step="1" placeholder="Miqdor" value="1">
      <input class="ii-price" type="number" min="0" step="1" placeholder="Narx">
      <button type="button" class="ghost small" data-action="invoice:del-item">×</button>
    </div>`;
  }
  function renderInvoiceItems(host, products, count) {
    if (!host) return;
    host.innerHTML = `<div class="invoice-head"><span>Mahsulot</span><span>Nomi</span><span>Miqdor</span><span>Narx</span><span></span></div>` +
      Array.from({ length: count }, () => invoiceItemRowHtml(products)).join('') +
      `<div id="invoice-total-line" class="journal-totals"></div>`;
    host.addEventListener('input', recalcInvoiceTotal);
    host.addEventListener('change', (e) => {
      if (e.target.classList.contains('ii-product')) {
        const opt = e.target.selectedOptions[0];
        const row = e.target.closest('.invoice-row');
        if (opt && opt.dataset.price) { row.querySelector('.ii-name').value = opt.textContent.replace(/\s\(.*\)$/, ''); row.querySelector('.ii-price').value = opt.dataset.price; recalcInvoiceTotal(); }
      }
    });
    host.addEventListener('click', (e) => { if (e.target.closest('[data-action="invoice:del-item"]')) { e.target.closest('.invoice-row').remove(); recalcInvoiceTotal(); } });
    recalcInvoiceTotal();
  }
  function renderInvoiceItemsAdd(products) {
    const host = document.getElementById('invoice-items');
    if (!host) return;
    const div = document.createElement('div');
    div.innerHTML = invoiceItemRowHtml(products && products.length ? products : INVOICE_PRODUCTS);
    host.insertBefore(div.firstElementChild, host.querySelector('#invoice-total-line'));
    recalcInvoiceTotal();
  }
  function readInvoiceItems() {
    return Array.from(document.querySelectorAll('#invoice-items .invoice-row')).map(r => ({
      product_id: r.querySelector('.ii-product').value || null,
      name: r.querySelector('.ii-name').value || (r.querySelector('.ii-product').selectedOptions[0] ? r.querySelector('.ii-product').selectedOptions[0].textContent : ''),
      qty: Number(r.querySelector('.ii-qty').value || 0),
      unit_price: Number(r.querySelector('.ii-price').value || 0),
    })).filter(i => i.name && i.qty > 0 && i.unit_price > 0);
  }
  function recalcInvoiceTotal() {
    const items = readInvoiceItems();
    const vat = document.querySelector('[name=vat_enabled]');
    const rate = vat && vat.checked ? num(S.settings && S.settings.vat_rate) : 0;
    const subtotal = items.reduce((a, i) => a + i.qty * i.unit_price, 0);
    const tax = Math.round(subtotal * rate / 100);
    const el = document.getElementById('invoice-total-line') || document.getElementById('invoice-total');
    if (el) el.innerHTML = `Jami: <b>${money(subtotal + tax)}</b> (QQS ${rate}%: ${money(tax)})`;
  }

  async function openInvoiceDetail(id) {
    const inv = await api(`/api/invoices/${id}`);
    const i = inv.invoice || inv;
    const actions = [];
    if (i.status === 'draft') actions.push({ label: 'Rasmiylashtirish', action: 'invoice:issue', danger: false });
    if (['sent', 'viewed', 'partially_paid', 'overdue'].includes(i.status)) actions.push({ label: 'To‘lov qabul qilish', action: 'payment:new', invoice: i });
    if (['draft', 'sent', 'viewed'].includes(i.status)) actions.push({ label: 'Bekor qilish', action: 'invoice:cancel', danger: true });
    if (i.paid_amount > 0 && i.status !== 'refunded') actions.push({ label: 'Refund (qaytarish)', action: 'invoice:refund', danger: true });
    openForm({
      title: `${i.no} · ${i.customer_name || ''}`,
      description: `${fmtDate(i.issue_date)} → muddat ${fmtDate(i.due_date)} · ${i.status_label || i.status}`,
      wide: true,
      fields: [
        { name: 'note', label: 'Izoh', value: i.notes || '' },
      ],
      extraHtml: `
        ${table(['Nomi', 'Miqdor', 'Narx', 'QQS', 'Jami'], (i.items || []).map(it => [
          esc(it.name), `${num(it.qty)} ${esc(it.unit || '')}`, money(it.unit_price), money(it.tax_amount), money(it.total),
        ]))}
        ${statRows([
          ['Oraliq jami', money(i.subtotal)],
          ['Chegirma', money(i.discount_total || 0)],
          ['QQS', money(i.tax_total)],
          ['Umumiy summa', `<b>${money(i.total)}</b>`],
          ['To‘langan', money(i.paid_amount || 0)],
          ['Qoldiq', `<b>${money(i.open_amount || 0)}</b>`],
        ])}
        ${(i.payments || []).length ? table(['To‘lov', 'Sana', 'Summa'], i.payments.map(p => [esc(p.no || p.id), shortDate(p.date), money(p.amount)])) : ''}
        ${i.public_token ? `<div class="notice subtle">Mijoz uchun havola: <code>${esc(location.origin)}/api/public/invoice/${esc(i.public_token)}</code></div>` : ''}
        <div class="row-actions">
          ${actions.map(a => `<button class="${a.danger ? 'ghost danger' : 'primary'} small" data-action="${a.action}" data-id="${esc(i.id)}">${esc(a.label)}</button>`).join('')}
          ${['draft', 'sent', 'viewed', 'partially_paid', 'overdue'].includes(i.status) ? `<button class="ghost small" data-action="invoice:mark-sent" data-id="${esc(i.id)}">«Yuborilgan» deb belgilash</button>` : ''}
        </div>`,
      submitLabel: 'Yopish',
      onSubmit: async () => {},
    });
    window.BUX.ACTIONS['invoice:issue'] = (el) => confirmDialog({
      title: 'Hisob-fakturani rasmiylashtirish',
      message: 'Jurnalga AR (debitorlik) va daromad yozuvi tushadi. Hujjat holati «yuborilgan» bo‘ladi.',
      confirmLabel: 'Rasmiylashtirish',
      onConfirm: async () => { await api(`/api/invoices/${el.dataset.id}/issue`, { method: 'POST' }); toast('Hisob-faktura rasmiylashtirildi.', 'success'); window.BUX.renderPage(); },
    });
    window.BUX.ACTIONS['invoice:mark-sent'] = async (el) => { await api(`/api/invoices/${el.dataset.id}/mark-sent`, { method: 'POST' }); toast('Holat yangilandi.', 'success'); window.BUX.renderPage(); };
    window.BUX.ACTIONS['invoice:cancel'] = (el) => confirmDialog({
      title: 'Hisob-fakturani bekor qilish',
      message: 'Bekor qilish uchun jurnalga teskari yozuv kiritiladi (daromad va debitorlik kamayadi).',
      confirmLabel: 'Bekor qilish', danger: true, extraField: { label: 'Sabab' },
      onConfirm: async (reason) => { await api(`/api/invoices/${el.dataset.id}/cancel`, { method: 'POST', body: { reason } }); toast('Hisob-faktura bekor qilindi.', 'success'); window.BUX.renderPage(); },
    });
    window.BUX.ACTIONS['invoice:refund'] = (el) => openForm({
      title: 'Refund (qaytarish)', fields: [
        { name: 'amount', label: 'Qaytariladigan summa', type: 'number', required: true, min: 1, value: num(i.open_amount || i.paid_amount) },
        { name: 'date', label: 'Sana', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
        { name: 'reason', label: 'Sabab', required: true },
      ], submitLabel: 'Refund qilish',
      onSubmit: async (data) => { await api(`/api/invoices/${el.dataset.id}/refund`, { method: 'POST', body: data }); toast('Refund qayd etildi.', 'success'); window.BUX.renderPage(); },
    });
    window.BUX.ACTIONS['payment:new'] = () => openPaymentForm({ invoice: i });
  }

  // ═══════════════════════════════ To‘lovlar ═══════════════════════════════
  VIEWS.payments = {
    async load(params) {
      const [data, open] = await Promise.all([
        api('/api/payments', { query: { ...rangeQs(), type: params.type, page: num(params.page) || 1, page_size: 25 } }),
        api('/api/payments/open-documents').catch(() => ({ invoices: [], bills: [], advances: [] })),
      ]);
      const items = data.items || [];
      return `
      <section class="metrics">
        ${metricCard({ label: 'Kirim to‘lovlari', value: money(data.summary && data.summary.incoming), icon: '↙', tone: 'green-icon' })}
        ${metricCard({ label: 'Chiqim to‘lovlari', value: money(data.summary && data.summary.outgoing), icon: '↗', tone: 'orange' })}
        ${metricCard({ label: 'Ochiq hisob-fakturalar', value: num((open.invoices || []).length), icon: '▤', tone: 'purple', hint: money((open.invoices || []).reduce((a, x) => a + num(x.open_amount), 0)) })}
        ${metricCard({ label: 'To‘lanmagan hisoblar', value: num((open.bills || []).length), icon: '▥', tone: 'blue', hint: money((open.bills || []).reduce((a, x) => a + num(x.open_amount), 0)) })}
      </section>
      ${card({
        title: 'To‘lovlar tarixi', subtitle: `${rangeLabel()} · har bir to‘lov AR/AP, kassa va kontragent balansini yangilaydi`,
        actions: `<div class="row-actions"><button class="ghost" data-action="kassa:count">Kassa sanog‘i</button><button class="primary" data-action="payment:new">＋ Yangi to‘lov</button></div>`,
        body: `<div class="filters">
            <select id="pay-type"><option value="">Barcha turlar</option><option value="incoming" ${params.type === 'incoming' ? 'selected' : ''}>Kirim (mijozdan)</option><option value="outgoing" ${params.type === 'outgoing' ? 'selected' : ''}>Chiqim (yetkazib beruvchiga)</option></select>
          </div>
          ${table(['№', 'Sana', 'Turi', 'Kontragent', 'Usul', 'Summa', 'Taqsimlangan', ''] , items.map(p => [
            `<b>${esc(p.no || '')}</b>`, shortDate(p.date),
            p.type === 'incoming' ? chip('Kirim', 'ok') : chip('Chiqim', 'warn'),
            esc(p.party_name || '—'),
            esc(p.method_label || p.method || '—'),
            money(p.amount),
            (p.allocations || []).length ? `${num((p.allocations || []).length)} hujjat` : (p.advance_amount ? `avans: ${money(p.advance_amount)}` : '—'),
            `<div class="row-actions">${p.cancelled_at ? chip('Bekor qilingan', 'neutral') : (can('payments.manage') ? `<button class="ghost small danger" data-action="payment:cancel" data-id="${esc(p.id)}">Bekor qilish</button>` : '')}</div>`,
          ]), { empty: emptyState({ icon: '₴', title: 'To‘lov yo‘q', text: 'Hisob-faktura uchun to‘lov qabul qilsangiz, u shu yerda ko‘rinadi.', cta: { label: '＋ Yangi to‘lov', action: 'payment:new' } }) })}
        ${pager({ total: data.total, page: data.page || 1, pageSize: 25 })}`,
      })}`;
    },
    async mount() {
      const el = document.getElementById('pay-type');
      if (el) el.addEventListener('change', (e) => go('payments', { ...S.params, type: e.target.value, page: 1 }));
      window.BUX.ACTIONS['payment:new'] = (btn) => openPaymentForm({});
      window.BUX.ACTIONS['payment:cancel'] = (el2) => confirmDialog({
        title: 'To‘lovni bekor qilish',
        message: 'To‘lov bekor qilinadi: AR/AP va kassa qoldiqlari teskari yozuv bilan tiklanadi.',
        confirmLabel: 'Bekor qilish', danger: true,
        onConfirm: async () => { await api(`/api/payments/${el2.dataset.id}/cancel`, { method: 'POST' }); toast('To‘lov bekor qilindi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['kassa:count'] = () => openCashCount();
    },
  };

  async function openPaymentForm({ invoice = null, bill = null } = {}) {
    const [partiesRes, accountsRes, open] = await Promise.all([
      api('/api/parties'), api('/api/accounts'), api('/api/payments/open-documents').catch(() => ({ invoices: [], bills: [] })),
    ]);
    const accounts = (accountsRes.items || accountsRes.accounts || []).filter(a => a.is_cash || a.is_bank);
    const parties = partiesRes.items || [];
    const openInvoices = (invoice ? [invoice] : (open.invoices || []));
    const openBills = (bill ? [bill] : (open.bills || []));
    openForm({
      title: 'Yangi to‘lov',
      description: 'To‘lov hujjatlarga taqsimlanadi; taqsimlanmagan qism avans sifatida qayd etiladi.',
      wide: true,
      fields: [
        { name: 'type', label: 'Turi', type: 'select', options: [{ value: 'incoming', label: 'Kirim (mijozdan)' }, { value: 'outgoing', label: 'Chiqim (yetkazib beruvchiga)' }], value: bill ? 'outgoing' : 'incoming' },
        { name: 'date', label: 'Sana', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
        { name: 'party_id', label: 'Kontragent', type: 'select', options: parties.map(p => ({ value: p.id, label: `${p.name} (${p.kind})` })), value: invoice ? invoice.customer_id : (bill ? bill.supplier_id : ''), required: true },
        { name: 'amount', label: 'Summa', type: 'number', required: true, min: 1, value: invoice ? num(invoice.open_amount) : (bill ? num(bill.open_amount) : '') },
        { name: 'method', label: 'To‘lov usuli', type: 'select', options: (S.meta && S.meta.payment_methods ? Object.entries(S.meta.payment_methods).map(([k, v]) => ({ value: k, label: v.label || v })) : [{ value: 'bank', label: 'Bank' }, { value: 'cash', label: 'Kassa' }]) },
        { name: 'account', label: 'Hisob', type: 'select', options: accounts.map(a => ({ value: a.code, label: `${a.code} — ${a.name}` })), required: true },
        { name: 'memo', label: 'Izoh', placeholder: 'Masalan: INV-2026-0007 uchun to‘lov' },
      ],
      extraHtml: `<div class="notice"><b>Hujjatga taqsimlash (ixtiyoriy):</b>
        <div class="notice subtle">Taqsimlanmasa, summa kontragent avansi sifatida qayd etiladi va keyin hisob-fakturaga bog‘lanadi.</div>
        ${openInvoices.length ? `<div class="alloc-block"><b>Ochiq hisob-fakturalar</b>${openInvoices.slice(0, 8).map(i => `
          <label class="alloc-row"><input type="checkbox" class="alloc-inv" value="${esc(i.id)}" data-open="${num(i.open_amount)}" ${invoice && invoice.id === i.id ? 'checked' : ''}>
            <span>${esc(i.no)} · ${esc(i.customer_name || '')} · qoldiq ${esc(money(i.open_amount))}</span>
            <input type="number" class="alloc-inv-amount" placeholder="0" value="${invoice && invoice.id === i.id ? num(i.open_amount) : ''}"></label>`).join('')}</div>` : ''}
        ${openBills.length ? `<div class="alloc-block"><b>To‘lanmagan hisoblar (xarid)</b>${openBills.slice(0, 8).map(b => `
          <label class="alloc-row"><input type="checkbox" class="alloc-bill" value="${esc(b.id)}" data-open="${num(b.open_amount)}" ${bill && bill.id === b.id ? 'checked' : ''}>
            <span>${esc(b.no)} · ${esc(b.supplier_name || '')} · qoldiq ${esc(money(b.open_amount))}</span>
            <input type="number" class="alloc-bill-amount" placeholder="0" value="${bill && bill.id === b.id ? num(b.open_amount) : ''}"></label>`).join('')}</div>` : ''}
      </div>`,
      submitLabel: 'To‘lovni saqlash',
      onSubmit: async (data) => {
        const allocations = [];
        document.querySelectorAll('.alloc-inv:checked').forEach(cb => {
          const amountEl = cb.closest('.alloc-row').querySelector('.alloc-inv-amount');
          allocations.push({ invoice_id: cb.value, amount: Number(amountEl.value || cb.dataset.open) });
        });
        document.querySelectorAll('.alloc-bill:checked').forEach(cb => {
          const amountEl = cb.closest('.alloc-row').querySelector('.alloc-bill-amount');
          allocations.push({ bill_id: cb.value, amount: Number(amountEl.value || cb.dataset.open) });
        });
        const res = await api('/api/payments', { method: 'POST', body: { ...data, allocations } });
        toast(`To‘lov saqlandi: ${(res.payment || res).no || ''}`, 'success');
        window.BUX.refreshBadges();
        window.BUX.renderPage();
      },
    });
  }

  async function openCashCount() {
    const accounts = await api('/api/accounts');
    const cashAccounts = (accounts.items || accounts.accounts || []).filter(a => a.is_cash);
    openForm({
      title: 'Kassa sanog‘i (inventarizatsiya)',
      description: 'Haqiqiy kassa qoldig‘ini kiriting — farq bo‘lsa tuzatish yozuvi taklif qilinadi.',
      fields: [
        { name: 'account', label: 'Kassa hisobi', type: 'select', options: cashAccounts.map(a => ({ value: a.code, label: `${a.code} — ${a.name}` })), required: true },
        { name: 'actual', label: 'Haqiqiy qoldiq (so‘m)', type: 'number', required: true, min: 0 },
        { name: 'date', label: 'Sana', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
        { name: 'note', label: 'Izoh', placeholder: 'Masalan: kassa hisobchisi tomonidan sanaldi' },
      ],
      submitLabel: 'Taqqoslash',
      onSubmit: async (data) => {
        const res = await api('/api/bank/cash-count', { method: 'POST', body: data });
        if (res.difference === 0) toast('Kassa qoldig‘i mos keldi.', 'success');
        else toast(`Farq aniqlandi: ${money(res.difference)}. Tuzatish yozuvi tasdiqlashga yuborildi.`, 'warn', 9000);
        window.BUX.renderPage();
      },
    });
  }

  // ═══════════════════════════════ Debitorlik ══════════════════════════════
  VIEWS.receivables = {
    async load() {
      const [data, aging, paymentOpen] = await Promise.all([
        api('/api/receivables'),
        api('/api/parties-aging').catch(() => ({ receivables: null })),
        api('/api/payments/open-documents').catch(() => ({ invoices: [] })),
      ]);
      const buckets = (aging.receivables && aging.receivables.buckets) || data.aging || {};
      const overdue = data.overdue_items || data.overdue || [];
      const overdueList = Array.isArray(overdue) ? overdue : (overdue.items || []);
      const total = num(data.total);
      const consistent = data.consistent !== false;
      return `
      <section class="metrics">
        ${metricCard({ label: 'Jami debitorlik', value: money(total), icon: '↙', tone: 'purple', hint: `${num(data.count)} ta ochiq hujjat` })}
        ${metricCard({ label: 'Muddati o‘tgan', value: money(data.overdue_total), icon: '⚠', tone: 'orange', hint: `${num(data.overdue_count)} ta hujjat` })}
        ${metricCard({ label: '7 kun ichida kutilayotgan', value: money(data.due_this_week), icon: '◷', tone: 'blue' })}
        ${metricCard({ label: 'Jurnal bilan moslik', value: consistent ? 'Mos ✓' : 'Farq bor', icon: '≡', tone: 'green-icon', hint: consistent ? 'Debitorlik hisobi (0610) bilan solishtirildi' : `Farq: ${money(data.difference)}` })}
      </section>
      <section class="grid-main">
        <div class="card">
          <div class="card-head"><div><h2>Muddati bo‘yicha taqsimot (aging)</h2><p>0–30, 31–60, 61–90, 90+ kun</p></div></div>
          ${statRows([
            ['Muddati kelmagan', money(buckets.not_due), (buckets.not_due_count != null ? `${num(buckets.not_due_count)} ta hujjat` : '')],
            ['0–30 kun', money(buckets['0-30']), (buckets['0_30_count'] != null ? `${num(buckets['0_30_count'])} ta` : '')],
            ['31–60 kun', money(buckets['31-60'])],
            ['61–90 kun', money(buckets['61-90'])],
            ['90+ kun', money(buckets['90+'])],
          ])}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Kechiktirib to‘laydigan mijozlar</h2><p>AI: real to‘lov tarixi asosida</p></div></div>
          ${(data.late_payers || []).length ? table(['Mijoz', 'O‘rtacha kechikish', 'Ochiq qarz', 'Xatar'], (data.late_payers || []).map(p => [
            esc(p.name), `${num(p.avg_delay_days)} kun`, money(p.open_amount), chip(p.risk_label || p.risk || 'o‘rta', severityTone(p.risk === 'high' ? 'high' : 'medium')),
          ])) : `<p class="empty-hint">Kechiktirib to‘lov holati aniqlanmagan.</p>`}
        </div>
      </section>
      ${card({
        title: 'Ochiq hisob-fakturalar (undirish navbati)', subtitle: `${rangeLabel()} · muddati o‘tganlar birinchi`,
        body: table(['№', 'Mijoz', 'Muddat', 'Kechikish', 'Qoldiq', 'Holat', ''],
          (data.items || []).map(i => [
            `<b>${esc(i.no)}</b>`, esc(i.customer_name || '—'), shortDate(i.due_date),
            i.overdue_days ? `<span class="danger-text">${num(i.overdue_days)} kun</span>` : '—',
            money(i.open_amount), chip(i.status_label || i.status, statusTone(i.status)),
            `<div class="row-actions">
              <button class="ghost small" data-action="invoice:view" data-id="${esc(i.id)}">Hujjat</button>
              <button class="ghost small" data-action="party:view" data-id="${esc(i.customer_id)}">CRM</button>
            </div>`,
          ]),
          { empty: emptyState({ icon: '↙', title: 'Debitorlik yo‘q', text: 'Ochiq hisob-fakturalar mavjud emas — barchasi to‘langan.' }) })}
      )}`;
    },
    async mount() {
      window.BUX.ACTIONS['party:view'] = (el) => (window.BUX_SHARED && window.BUX_SHARED.openPartyProfile)
        ? window.BUX_SHARED.openPartyProfile(el.dataset.id) : go('parties', { id: el.dataset.id });
    },
  };

  // ═══════════════════════════════ Kreditorlik ═════════════════════════════
  VIEWS.payables = {
    async load() {
      const [data, aging] = await Promise.all([api('/api/payables'), api('/api/parties-aging').catch(() => ({ payables: null }))]);
      const buckets = (aging.payables && aging.payables.buckets) || data.aging || {};
      const upcoming = data.upcoming || [];
      const nextWeek = upcoming.filter(u => num(u.days_left) <= 7);
      return `
      <section class="metrics">
        ${metricCard({ label: 'Jami kreditorlik', value: money(data.total), icon: '↗', tone: 'orange', hint: `${num(data.count)} ta ochiq hisob` })}
        ${metricCard({ label: 'Muddati o‘tgan', value: money(data.overdue_total), icon: '⚠', tone: 'orange', hint: `${num(data.overdue_count)} ta hisob` })}
        ${metricCard({ label: '7 kun ichida to‘lanadi', value: money(nextWeek.reduce((a, b) => a + num(b.open_amount), 0)), icon: '◷', tone: 'blue', hint: `${nextWeek.length} ta hisob` })}
        ${metricCard({ label: 'Jurnal bilan moslik', value: data.consistent !== false ? 'Mos ✓' : 'Farq bor', icon: '≡', tone: 'green-icon', hint: data.consistent !== false ? 'Kreditorlik hisobi (6010) bilan solishtirildi' : `Farq: ${money(data.difference)}` })}
      </section>
      ${nextWeek.length ? `<div class="notice warn"><b>Diqqat:</b> ${nextWeek.length} ta yetkazib beruvchi to‘lovi 7 kun ichida to‘lanishi kerak — jami ${esc(money(nextWeek.reduce((a, b) => a + num(b.open_amount), 0)))}.</div>` : ''}
      <section class="grid-main">
        <div class="card">
          <div class="card-head"><div><h2>To‘lov navbati</h2><p>Muddat bo‘yicha yaqinlashib kelayotgan to‘lovlar</p></div></div>
          ${upcoming.length ? table(['Yetkazib beruvchi', 'Hisob', 'Muddat', 'Kun', 'Qoldiq'], upcoming.slice(0, 12).map(u => [
            esc(u.supplier_name || '—'), esc(u.no), shortDate(u.due_date),
            num(u.days_left) < 0 ? `<span class="danger-text">${Math.abs(num(u.days_left))} kun o‘tdi</span>` : `${num(u.days_left)} kun`,
            money(u.open_amount),
          ])) : `<p class="empty-hint">Yaqin 30 kun ichida to‘lanadigan hisob yo‘q.</p>`}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Muddat bo‘yicha taqsimot</h2><p>Aging hisoboti</p></div></div>
          ${statRows([
            ['Muddati kelmagan', money(buckets.not_due)],
            ['0–30 kun', money(buckets['0-30'])],
            ['31–60 kun', money(buckets['31-60'])],
            ['61–90 kun', money(buckets['61-90'])],
            ['90+ kun', money(buckets['90+'])],
          ])}
        </div>
      </section>
      ${card({
        title: 'Ochiq xarid hisob-varaqlari',
        actions: `<button class="primary" data-action="bill:new">＋ Yangi xarid hisobi</button>`,
        body: table(['№', 'Yetkazib beruvchi', 'Sana', 'Muddat', 'Summa', 'To‘langan', 'Qoldiq', 'Holat', ''], (data.items || []).map(b => [
          `<b>${esc(b.no)}</b>`, esc(b.supplier_name || '—'), shortDate(b.issue_date), shortDate(b.due_date),
          money(b.total), money(b.paid_amount || 0), money(b.open_amount), chip(b.status_label || b.status, statusTone(b.status)),
          `<div class="row-actions"><button class="ghost small" data-action="bill:pay" data-id="${esc(b.id)}">To‘lash</button></div>`,
        ]), { empty: emptyState({ icon: '↗', title: 'Kreditorlik yo‘q', text: 'Yetkazib beruvchilarga qarz yo‘q yoki xarid hisoblari kiritilmagan.', cta: { label: '＋ Yangi xarid hisobi', action: 'bill:new' } }) }),
      })}`;
    },
    async mount() {
      window.BUX.ACTIONS['bill:new'] = () => openBillForm();
      window.BUX.ACTIONS['bill:pay'] = async (el) => {
        const bill = await api(`/api/bills/${el.dataset.id}`);
        openPaymentForm({ bill: bill.bill || bill });
      };
    },
  };

  async function openBillForm() {
    const [partiesRes, productsRes] = await Promise.all([
      api('/api/parties', { query: { kind: 'supplier' } }),
      api('/api/products').catch(() => ({ items: [] })),
    ]);
    const suppliers = partiesRes.items || [];
    if (!suppliers.length) { toast('Avval yetkazib beruvchi yarating.', 'warn'); go('parties'); return; }
    const products = productsRes.items || [];
    INVOICE_PRODUCTS = products;
    openForm({
      title: 'Yangi xarid hisobi (bill)',
      description: 'Xarid hisobi kreditorlikni oshiradi; tovarlar bo‘lsa omborga kirim qilish mumkin.',
      wide: true,
      fields: [
        { name: 'supplier_id', label: 'Yetkazib beruvchi', type: 'select', options: suppliers.map(s => ({ value: s.id, label: `${s.name}${s.inn ? ` · STIR ${s.inn}` : ''}` })), required: true },
        { name: 'issue_date', label: 'Hisob sanasi', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
        { name: 'due_date', label: 'To‘lov muddati', type: 'date' },
        { name: 'no', label: 'Hujjat raqami', placeholder: 'Masalan: SF-2026-0042' },
      ],
      extraHtml: `<div class="notice"><b>Qatorlar:</b><div id="invoice-items" class="invoice-items"></div>
        <button type="button" class="outline" data-action="invoice:add-item" style="margin-top:8px">＋ Qator qo‘shish</button>
        <div id="invoice-total" class="journal-totals"></div></div>`,
      submitLabel: 'Xarid hisobini yaratish',
      onSubmit: async (data) => {
        const items = readInvoiceItems();
        if (!items.length) throw window.BUX.ApiError('Kamida bitta qator qo‘shing.');
        const res = await api('/api/bills', { method: 'POST', body: { ...data, items } });
        toast(`Xarid hisobi yaratildi: ${(res.bill || res).no}`, 'success');
        window.BUX.renderPage();
      },
    });
    renderInvoiceItems(document.getElementById('invoice-items'), products, 1);
    window.BUX.ACTIONS['invoice:add-item'] = () => renderInvoiceItemsAdd(products);
  }

  // ═══════ Sahifalararo umumiy amallar — bir marta ro‘yxatga olinadi ═══════
  // (sahifa mount tartibidan qat’i nazar ishlashi uchun; keyinroq mount aniqroq
  //  variantni o‘rnatsa, u ustuvor bo‘ladi)
  const SHARED_ACTIONS = {
    'invoice:new': () => openInvoiceForm(),
    'invoice:view': (el) => openInvoiceDetail(el.dataset.id),
    'invoice:add-item': () => renderInvoiceItemsAdd(),
    'payment:new': (el) => openPaymentForm(el && el.dataset.invoice ? { invoice: { id: el.dataset.invoice } } : {}),
    'party:view': (el) => (window.BUX_SHARED && window.BUX_SHARED.openPartyProfile)
      ? window.BUX_SHARED.openPartyProfile(el.dataset.id) : go('parties', { id: el.dataset.id }),
    'bill:new': () => openBillForm(),
  };
  Object.keys(SHARED_ACTIONS).forEach(k => { if (!window.BUX.ACTIONS[k]) window.BUX.ACTIONS[k] = SHARED_ACTIONS[k]; });

  window.VIEWS = VIEWS;
})();
