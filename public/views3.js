'use strict';
/** BUXAI — sahifalar: soliqlar, davr yopish, AI, jamoa, tasdiqlash, maqsadlar, audit, tarif, sozlamalar, SuperAdmin, yordam. */
(function () {
  const { S, api, go, toast, money, num, esc, can, chip, card, table, metricCard, statRows, emptyState, pager,
    progressBar, barsChart, openForm, confirmDialog, fmtDate, shortDate, timeAgo, pct, compact, definitionList,
    statusTone, severityTone, download, ApiError } = window.BUX;
  const VIEWS = (window.VIEWS = window.VIEWS || {});
  const rangeQs = () => ({ from: S.range.from, to: S.range.to });
  const rangeLabel = () => S.range.label || 'Bu oy';

  // ════════════════════════════════ Soliqlar ═══════════════════════════════
  VIEWS.tax = {
    async load() {
      const data = await api('/api/tax', { query: rangeQs() });
      const summary = data.summary || {};
      const calendar = data.calendar || [];
      const statusLabel = { done: 'Bajarilgan', overdue: 'Muddati o‘tgan', due_soon: 'Muddat yaqin', upcoming: 'Rejalashtirilgan', pending: 'Kutilmoqda' };
      return `
      <section class="metrics">
        ${metricCard({ label: 'Soliq rejimi', value: summary.mode_label || '—', icon: '§', tone: 'purple', hint: `Davr: ${rangeLabel()}` })}
        ${metricCard({ label: 'QQS (hisoblangan — hisobga olinadigan)', value: `${money(summary.vat_out)} / ${money(summary.vat_in)}`, icon: '◈', tone: 'blue', hint: `Sof QQS: ${money(summary.net_vat)}` })}
        ${metricCard({ label: 'Aylanma', value: money(summary.turnover), icon: '↗', tone: 'green-icon' })}
        ${metricCard({ label: 'Soliqdan oldingi foyda', value: money(summary.profit_before_tax), icon: '✦', tone: 'green-icon', hint: 'Hisob-kitob (kitob) ma’lumoti' })}
      </section>
      ${card({
        title: 'Soliq kalendari', subtitle: 'Muddatlar tasdiqlanmagan (verified: false) — buxgalter tasdiqlashi kerak',
        body: table(['Majburiyat', 'Davr', 'Muddat', 'Summa', 'Holat', 'Manba', ''], calendar.map(e => [
          `<b>${esc(e.title)}</b>${e.note ? `<br><small>${esc(e.note)}</small>` : ''}`,
          esc(e.period || '—'), shortDate(e.due_date),
          e.amount ? money(e.amount) : '—',
          chip(statusLabel[e.status] || e.status, statusTone(e.status)),
          `${esc(e.source_note || e.amount_basis || 'Kalendar shabloni')}${e.verified === false ? ' · tasdiqlanmagan' : ''}`,
          `<div class="row-actions">
            ${e.status !== 'done' ? `<button class="ghost small" data-action="tax:done" data-key="${esc(e.key || e.id)}" data-period="${esc(e.period || '')}">Bajarildi</button>` : `<button class="ghost small" data-action="tax:undone" data-key="${esc(e.key || e.id)}" data-period="${esc(e.period || '')}">Bekor qilish</button>`}
            <button class="ghost small" data-action="tax:verify" data-key="${esc(e.key || e.id)}">Aniqlashtirish</button>
          </div>`,
        ]), { empty: emptyState({ title: 'Soliq majburiyatlari yo‘q', text: 'Kompaniya uchun soliq majburiyatlari ro‘yxati shakllantirilmagan.' }) }),
      })}
      <section class="grid-main">
        <div class="card">
          <div class="card-head"><div><h2>QQS hisob-kitobi</h2><p>Hisob-fakturalar va jurnal asosida</p></div></div>
          ${statRows([
            ['Sotuv bo‘yicha QQS (chiqim)', money(summary.vat_out)],
            ['Xarid bo‘yicha QQS (kirim)', money(summary.vat_in)],
            ['To‘lanadigan sof QQS', `<b>${money(summary.net_vat)}</b>`],
            ['QQS deklaratsiyasi muddati', summary.vat_deadline ? shortDate(summary.vat_deadline) : '—'],
          ])}
          ${(summary.overdue_count || summary.unverified_deadlines) ? `<div class="notice warn">
            ${summary.overdue_count ? `${num(summary.overdue_count)} ta majburiyat muddati o‘tgan. ` : ''}
            ${summary.unverified_deadlines ? `${num(summary.unverified_deadlines)} ta muddat tasdiqlanmagan.` : ''}
          </div>` : ''}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Kerakli hujjatlar</h2><p>Hisobot tayyorlash uchun</p></div></div>
          ${(summary.requires_documents || []).length ? `<ul class="plain-list">${(summary.requires_documents || []).map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : `<p class="empty-hint">Qo‘shimcha hujjat talabi yo‘q.</p>`}
          <div class="notice subtle">${esc(summary.disclaimer || 'Bu ma’lumotlar buxgalteriya kitoblaridan hisoblanadi va soliq organiga taqdim etiladigan hisobot emas.')}</div>
        </div>
      </section>`;
    },
    async mount() {
      window.BUX.ACTIONS['tax:done'] = (el) => openForm({
        title: 'Majburiyatni bajarildi deb belgilash', fields: [{ name: 'note', label: 'Izoh', placeholder: 'Masalan: deklaratsiya topshirildi, to‘lov amalga oshirildi' }],
        submitLabel: 'Belgilash',
        onSubmit: async (data) => { await api('/api/tax/mark', { method: 'POST', body: { key: el.dataset.key, period: el.dataset.period, note: data.note } }); toast('Belgilandi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['tax:undone'] = (el) => confirmDialog({
        title: 'Belgini bekor qilish', message: 'Majburiyat yana «kutilmoqda» holatiga qaytadi.',
        confirmLabel: 'Bekor qilish', onConfirm: async () => { await api('/api/tax/unmark', { method: 'POST', body: { key: el.dataset.key, period: el.dataset.period } }); toast('Bekor qilindi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['tax:verify'] = (el) => openForm({
        title: 'Muddat va summani aniqlashtirish',
        description: 'Shablondagi muddatlar tasdiqlanmagan. Soliq organi talablariga moslab aniqlashtiring.',
        fields: [
          { name: 'due_day', label: 'Oyning kuni', type: 'number', min: 1, max: 31, value: 20 },
          { name: 'periodicity', label: 'Davriylik', type: 'select', options: [{ value: 'monthly', label: 'Har oy' }, { value: 'quarterly', label: 'Har chorak' }, { value: 'annual', label: 'Yiliga bir marta' }] },
          { name: 'note', label: 'Izoh' },
        ], submitLabel: 'Saqlash',
        onSubmit: async (data) => { await api('/api/tax/verify-deadline', { method: 'POST', body: { key: el.dataset.key, ...data } }); toast('Muddat aniqlashtirildi.', 'success'); window.BUX.renderPage(); },
      });
    },
  };

  // ═════════════════════════════ Davr yopish ═══════════════════════════════
  VIEWS.close = {
    async load(params) {
      const data = await api('/api/close', { query: { period: params.period } });
      const items = data.items || [];
      const summary = data.summary || {};
      const periods = data.periods || [];
      const statusChip = (s) => chip(s === 'ok' ? 'Bajarilgan' : s === 'warning' ? 'Ogohlantirish' : 'Xato', statusTone(s));
      return `
      <section class="welcome">
        <div><h1>Davr yopish: ${esc(data.period_label || data.period || '')} <span>✓</span></h1>
        <p>Yopishdan oldin barcha tekshiruvlar bajarilishi kerak. Kritik xato bo‘lsa yopish bloklanadi.</p></div>
        <div class="health"><div class="health-ring ${summary.can_close ? '' : 'bad'}">${num(summary.progress)}<small>%</small></div><div><b>Tayyorlik</b><small>${num(summary.ok)} ok · ${num(summary.warning)} ogohlantirish · ${num(summary.failed)} xato</small></div></div>
      </section>
      ${card({
        title: 'Tekshiruv ro‘yxati (checklist)', subtitle: '12 ta avtomatik tekshiruv — real buxgalteriya ma’lumotlari bo‘yicha',
        actions: `<div class="row-actions">
          <select id="close-period">${(periods.length ? periods : [{ period: data.period }]).map(p => `<option value="${esc(p.period)}" ${data.period === p.period ? 'selected' : ''}>${esc(p.period)}${p.status ? ` · ${esc(p.status === 'closed' ? 'yopilgan' : p.status)}` : ''}</option>`).join('')}</select>
          ${data.status === 'closed' ? `<button class="ghost danger" data-action="close:reopen">Davrni qayta ochish</button>`
            : `<button class="primary" data-action="close:run" ${summary.can_close ? '' : 'title="Kritik xatolar mavjud"'}>Davrni yopish</button>`}
        </div>`,
        body: table(['Tekshiruv', 'Holat', 'Batafsil', 'Dalillar', ''], items.map(i => [
          `<b>${esc(i.title)}</b>${i.critical ? ' ' + chip('kritik', 'danger') : ''}`,
          statusChip(i.status),
          esc(i.detail || ''),
          (i.evidence || []).slice(0, 2).map(e => `${esc(e.label)}: ${esc(e.value)}`).join(' · ') || '—',
          `<div class="row-actions">${(i.actions || []).slice(0, 2).map(a => `<button class="ghost small" data-action="close:action" data-page="${esc(a.page || 'dashboard')}" data-id="${esc(a.id || '')}">${esc(a.label || 'Ochish')}</button>`).join('')}</div>`,
        ])),
      })}
      ${card({
        title: 'Davrlar holati (12 oy)', subtitle: 'Yopilgan davrlarga yozuv kiritish bloklanadi',
        body: table(['Davr', 'Holat', 'Yopilgan', 'Kim yopdi', ''], periods.map(p => [
          esc(p.period),
          chip(p.status === 'closed' ? 'Yopilgan' : p.status === 'reopened' ? 'Qayta ochilgan' : p.status || 'Ochiq', p.status === 'closed' ? 'ok' : p.status === 'reopened' ? 'warn' : 'neutral'),
          p.closed_at ? shortDate(p.closed_at.slice(0, 10)) : '—',
          esc(p.closed_by_name || '—'),
          p.status === 'closed' ? `<button class="ghost small" data-action="close:report" data-period="${esc(p.period)}">Yopilish hisoboti</button>` : '',
        ]), { empty: emptyState({ title: 'Yopilgan davr yo‘q', text: 'Oy tugagach checklistni bajarib, davrni yoping.' }) }),
      })}`;
    },
    async mount() {
      const sel = document.getElementById('close-period');
      if (sel) sel.addEventListener('change', (e) => go('close', { period: e.target.value }));
      window.BUX.ACTIONS['close:run'] = (el) => confirmDialog({
        title: 'Davrni yopish',
        message: 'Yopilgandan so‘ng bu davrga yangi yozuv kiritilmaydi (faqat qayta ochish bilan).',
        confirmLabel: 'Davrni yopish',
        onConfirm: async () => {
          try {
            await api('/api/close', { method: 'POST', body: { period: S.params.period } });
            toast('Davr yopildi.', 'success');
          } catch (err) {
            if (err.code === 'close_blocked') {
              const override = confirm(`Kritik xatolar mavjud: ${err.details && err.details.blockers ? err.details.blockers.join(', ') : err.message}\n\nRahbar sifatida majburiy yopishni xohlaysizmi?`);
              if (!override) throw err;
              await api('/api/close', { method: 'POST', body: { period: S.params.period, override: true, override_reason: 'Rahbar qarori bilan majburiy yopish' } });
              toast('Davr majburiy yopildi (sabab audit jurnalida qayd etildi).', 'warn', 8000);
            } else throw err;
          }
          window.BUX.renderPage();
        },
      });
      window.BUX.ACTIONS['close:reopen'] = (el) => openForm({
        title: 'Davrni qayta ochish', description: 'Faqat rahbar (direktor) qayta ochishi mumkin. Sabab audit jurnalida saqlanadi.',
        fields: [{ name: 'reason', label: 'Sabab', required: true }], submitLabel: 'Qayta ochish',
        onSubmit: async (data) => { await api('/api/close/reopen', { method: 'POST', body: { period: S.params.period, reason: data.reason } }); toast('Davr qayta ochildi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['close:action'] = (el) => go(el.dataset.page || 'dashboard', el.dataset.id ? { id: el.dataset.id } : {});
      window.BUX.ACTIONS['close:report'] = () => download(`/api/reports/pnl/export?from=${S.params.period}-01&to=${S.params.period}-31`, `davr-${S.params.period}.csv`);
    },
  };

  // ═════════════════════════════ AI Buxgalter ══════════════════════════════
  VIEWS.ai = {
    async load() {
      const [history, suggestions, health] = await Promise.all([
        api('/api/ai/history', { query: { limit: 30 } }).catch(() => ({ items: [] })),
        api('/api/ai/suggestions').catch(() => ({ questions: [] })),
        api('/api/ai/health', { query: rangeQs() }).catch(() => null),
      ]);
      const questions = suggestions.questions || [];
      return `
      <section class="grid-main">
        <div class="card">
          <div class="card-head"><div><h2>AI Buxgalter / CFO</h2><p>Faqat real buxgalteriya ma’lumotlari asosida — har bir javobda manba va ishonch darajasi</p></div>
            <span class="chip neutral">${esc(suggestions.provider || '')}</span></div>
          <div class="chat chat-page" id="page-chat">
            ${(history.items || []).slice().reverse().map(m => `
              <div class="message user">${esc(m.question)}</div>
              <div class="message bot">${esc((m.answer && m.answer.text) || '').replace(/\n/g, '<br>')}
                ${m.answer && m.answer.classification ? `<div class="answer-meta">Tasnif: ${esc(m.answer.classification)} · Ishonch: ${esc(m.answer.confidence_label || '')} · Davr: ${esc(m.answer.data_range || '')}</div>` : ''}
              </div>`).join('') || `<div class="message bot">Salom! Savolingizni yozing — javob faqat real ma’lumotlar asosida bo‘ladi.</div>`}
          </div>
          <form class="chat-form" id="page-chat-form"><input id="page-chat-input" placeholder="Masalan: Bu oy qancha foyda qildik?" autocomplete="off"><button>↑</button></form>
          <div class="suggestions">${questions.slice(0, 8).map(q => `<button data-action="ai:page-ask" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Moliyaviy salomatlik</h2><p>Real ko‘rsatkichlar asosida</p></div></div>
          ${health && health.available ? `
            <div class="health-big"><div class="health-ring ${health.score >= 70 ? '' : health.score >= 50 ? 'warn' : 'bad'}">${num(health.score)}<small>%</small></div>
              <div><b>${esc(health.rating || '')}</b><small>${esc(health.explanation || '')}</small></div></div>
            ${table(['Ko‘rsatkich', 'Ball', 'Izoh'], (health.components || []).map(c => [
              esc(c.label), c.score == null ? chip('Ma’lumot yo‘q', 'neutral') : `${Math.round(num(c.score))}%`, esc(c.reason || ''),
            ]))}
            <div class="answer-meta">${esc(health.formula || '')}</div>`
            : `<p class="empty-hint">${esc((health && health.message) || 'Salomatlik skorini hisoblash uchun ma’lumot yetarli emas.')}</p>`}
          <div class="notice subtle"><b>AI xavfsizligi:</b> AI hech narsani jimgina o‘zgartirmaydi — o‘chirish, to‘lov, soliq hisoboti yoki hisob-faktura yuborish faqat siz tasdiqlaganingizdan keyin amalga oshadi.</div>
        </div>
      </section>`;
    },
    async mount() {
      const form = document.getElementById('page-chat-form');
      const ask = async (q) => {
        const chat = document.getElementById('page-chat');
        chat.insertAdjacentHTML('beforeend', `<div class="message user">${esc(q)}</div>`);
        const bubble = document.createElement('div');
        bubble.className = 'message bot';
        bubble.textContent = 'Tahlil qilinmoqda…';
        chat.appendChild(bubble);
        chat.scrollTop = 99999;
        try {
          const answer = await api('/api/ai/ask', { method: 'POST', body: { message: q, from: S.range.from, to: S.range.to } });
          bubble.innerHTML = esc(answer.text || '').replace(/\n/g, '<br>') +
            ((answer.blocks || []).length ? (answer.blocks || []).map(b => `<div class="answer-block"><b>${esc(b.title)}</b>${statRows((b.rows || []).map(r => [r.label, esc(String(r.value))]))}</div>`).join('') : '') +
            `<div class="answer-meta">Tasnif: ${esc(answer.classification || '')} · Ishonch: ${esc(answer.confidence_label || '')} · Davr: ${esc(answer.data_range || '')}</div>` +
            ((answer.sources || []).length ? `<div class="answer-sources"><b>Manbalar:</b> ${answer.sources.map(s => `${esc(s.label)}: ${esc(String(s.value))}`).join(' · ')}</div>` : '');
        } catch (err) {
          bubble.innerHTML = `<span class="danger-text">${esc(err.message)}</span>`;
        }
        chat.scrollTop = 99999;
      };
      if (form) form.addEventListener('submit', (e) => { e.preventDefault(); const i = document.getElementById('page-chat-input'); const q = i.value.trim(); if (!q) return; i.value = ''; ask(q); });
      window.BUX.ACTIONS['ai:page-ask'] = (el) => { const i = document.getElementById('page-chat-input'); if (i) i.value = el.dataset.q; ask(el.dataset.q); };
    },
  };

  // ═══════════════════════════ AI Business Advisor ═════════════════════════
  VIEWS.advisor = {
    async load() {
      const [adv, forecast] = await Promise.all([
        api('/api/ai/advisor'),
        api('/api/ai/forecast', { query: { days: 30 } }).catch(() => null),
      ]);
      if (!adv.available) {
        return emptyState({ icon: '◆', title: 'Tahlil uchun ma’lumot yetarli emas', text: adv.explanation || 'Bir necha tranzaksiya kiritilgandan so‘ng AI Business Advisor real tahlil qiladi.' });
      }
      const block = (title, items, tone) => card({
        title, subtitle: items.length ? `${items.length} ta band` : 'Topilmadi',
        body: items.length ? `<div class="insight-list">${items.map(i => `<div class="insight-item ${tone}"><b>${esc(i.title)}</b><p>${esc(i.detail || '')}</p>${i.evidence ? `<small>${esc(i.evidence)}</small>` : ''}</div>`).join('')}</div>` : `<p class="empty-hint">Bu bo‘limda band yo‘q.</p>`,
      });
      return `
      <section class="metrics">
        ${metricCard({ label: 'Bugungi ustuvorliklar', value: (adv.priorities || []).length, icon: '◆', tone: 'purple' })}
        ${metricCard({ label: 'Xatarlar', value: (adv.risks || []).length, icon: '⚠', tone: 'orange' })}
        ${metricCard({ label: 'Imkoniyatlar', value: (adv.opportunities || []).length, icon: '↗', tone: 'green-icon' })}
        ${metricCard({ label: 'Tavsiyalar', value: (adv.recommendations || []).length, icon: '✦', tone: 'blue' })}
      </section>
      ${adv.health ? `<div class="notice ${adv.health.score >= 60 ? '' : 'warn'}"><b>Moliyaviy salomatlik:</b> ${num(adv.health.score)}% — ${esc(adv.health.explanation || '')}</div>` : ''}
      <section class="grid-main">
        ${block('Bugungi ustuvorliklar', adv.priorities || [], 'primary')}
        ${block('Xatarlar', adv.risks || [], 'danger')}
      </section>
      <section class="grid-main">
        ${block('Imkoniyatlar', adv.opportunities || [], 'ok')}
        ${block('Tavsiyalar', adv.recommendations || [], 'info')}
      </section>
      ${forecast && forecast.available ? card({
        title: 'Pul oqimi prognozi (30 kun)',
        subtitle: 'Bu — prognoz, fakt emas. Farazlar va ma’lumot sifati ko‘rsatilgan.',
        body: statRows([
          ['Joriy qoldiq', money(forecast.totals.opening)],
          ['Kutilayotgan kirim', money(forecast.totals.inflow)],
          ['Kutilayotgan chiqim', money(forecast.totals.outflow)],
          ['Yakuniy qoldiq', `<b>${money(forecast.totals.closing)}</b>`],
          ['Minimal qoldiq', money(forecast.totals.min_balance)],
          ['Ma’lumot sifati', esc(forecast.data_quality)],
        ]) + statRows((forecast.assumptions || []).map(a => ['• ' + a, ''])),
      }) : ''}
      <div class="notice subtle">Barcha tavsiyalar real buxgalteriya yozuvlari, hisob-fakturalar va ombor ma’lumotlaridan hisoblanadi. AI faqat taklif qiladi — har qanday o‘zgarish tasdiqlashni talab qiladi.</div>`;
    },
  };

  // ════════════════════════════════ Jamoa ══════════════════════════════════
  VIEWS.team = {
    async load() {
      const data = await api('/api/users');
      const members = data.items || [];
      return `
      ${card({
        title: 'Jamoa a’zolari va rollar', subtitle: 'Ruxsatlar server tomonida tekshiriladi (RBAC)',
        actions: can('users.manage') ? `<button class="primary" data-action="user:invite">＋ Xodim qo‘shish</button>` : '',
        body: table(['Xodim', 'Email', 'Rol', 'Holat', 'Qo‘shilgan', ''], members.map(m => [
          `<div class="trans-title"><div class="trans-icon">${esc(String(m.name || '?').slice(0, 1).toUpperCase())}</div><b>${esc(m.name)}</b></div>`,
          esc(m.email), chip(m.role_label || m.role, m.role === 'director' ? 'ok' : 'info'),
          chip(m.status === 'blocked' ? 'Bloklangan' : 'Faol', m.status === 'blocked' ? 'danger' : 'ok'),
          m.created_at ? shortDate(m.created_at.slice(0, 10)) : '—',
          can('users.manage') ? `<div class="row-actions">
            <button class="ghost small" data-action="user:role" data-id="${esc(m.user_id || m.id)}" data-name="${esc(m.name)}" data-role="${esc(m.role)}">Rolni o‘zgartirish</button>
            ${(m.user_id || m.id) !== S.user.id ? `<button class="ghost small danger" data-action="user:remove" data-id="${esc(m.user_id || m.id)}">Chiqarish</button>` : ''}
          </div>` : '',
        ]), { empty: emptyState({ title: 'Xodim yo‘q', text: 'Buxgalter yoki xodim qo‘shsangiz, ular uchun rol va ruxsatlar belgilanadi.' }) }),
      })}
      ${card({
        title: 'Rollar va ruxsatlar', subtitle: 'Har bir rol qanday amallarni bajarishi mumkin',
        body: table(['Rol', 'Tavsif', 'Ruxsatlar'], ((S.meta && S.meta.roles) || []).map(r => [
          `<b>${esc(r.label)}</b>`, esc(r.description || ''),
          r.permissions.includes('*') ? chip('Barcha ruxsatlar', 'ok') : `<span class="perm-list">${r.permissions.slice(0, 12).map(p => chip(p, 'neutral')).join('')}${r.permissions.length > 12 ? ` +${r.permissions.length - 12}` : ''}</span>`,
        ])),
      })}`;
    },
    async mount() {
      window.BUX.ACTIONS['user:invite'] = () => openForm({
        title: 'Xodim qo‘shish', description: 'Agar email mavjud bo‘lmasa, yangi foydalanuvchi yaratiladi va vaqtinchalik parol beriladi.',
        fields: [
          { name: 'name', label: 'Ism familiya', required: true },
          { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'role', label: 'Rol', type: 'select', options: ((S.meta && S.meta.roles) || []).filter(r => r.key !== 'superadmin').map(r => ({ value: r.key, label: `${r.label} — ${r.description}` })) },
          { name: 'password', label: 'Vaqtinchalik parol (ixtiyoriy)', placeholder: 'Kamida 8 belgi' },
          { name: 'phone', label: 'Telefon' },
        ], wide: true, submitLabel: 'Qo‘shish',
        onSubmit: async (data) => {
          const res = await api('/api/users', { method: 'POST', body: data });
          toast(res.created ? `Foydalanuvchi yaratildi. Vaqtinchalik parol: ${res.temporary_password}` : 'Foydalanuvchi kompaniyaga qo‘shildi.', 'success', 12000);
          window.BUX.renderPage();
        },
      });
      window.BUX.ACTIONS['user:role'] = (el) => openForm({
        title: `${el.dataset.name} — rolni o‘zgartirish`,
        fields: [{ name: 'role', label: 'Yangi rol', type: 'select', options: ((S.meta && S.meta.roles) || []).filter(r => r.key !== 'superadmin').map(r => ({ value: r.key, label: r.label, value2: '' })), value: el.dataset.role }],
        submitLabel: 'Saqlash',
        onSubmit: async (data) => { await api(`/api/users/${el.dataset.id}`, { method: 'PATCH', body: { role: data.role } }); toast('Rol yangilandi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['user:remove'] = (el) => confirmDialog({
        title: 'Xodimni kompaniyadan chiqarish', message: 'Xodim kompaniya ma’lumotlariga kirisha olmaydi (tarixiy yozuvlar saqlanadi).',
        confirmLabel: 'Chiqarish', danger: true,
        onConfirm: async () => { await api(`/api/users/${el.dataset.id}`, { method: 'DELETE' }); toast('Xodim chiqarildi.', 'success'); window.BUX.renderPage(); },
      });
    },
  };

  // ═══════════════════════════ Tasdiqlash markazi ══════════════════════════
  VIEWS.approvals = {
    async load(params) {
      const status = params.status || 'pending';
      const data = await api('/api/approvals', { query: { status } });
      const items = data.items || [];
      return `
      ${card({
        title: 'Tasdiqlash markazi', subtitle: 'Yirik xarajatlar, qo‘lda kiritilgan jurnal yozuvlari, refund va Xato Radar tuzatishlari',
        actions: `<div class="filters" style="margin:0">
            <select id="appr-status">
              ${[['pending', 'Kutilmoqda'], ['approved', 'Tasdiqlangan'], ['rejected', 'Rad etilgan'], ['all', 'Barchasi']].map(([k, l]) => `<option value="${k}" ${status === k ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>`,
        body: items.length ? items.map(a => `
          <div class="issue-row">
            <span class="sev-bar ${a.is_overdue ? 'danger' : a.severity === 'high' ? 'warn' : 'info'}"></span>
            <div class="issue-body">
              <div class="issue-head"><b>${esc(a.title)}</b> ${chip(a.type_label || a.type, 'neutral')} ${a.amount ? chip(money(a.amount), 'info') : ''} ${a.is_overdue ? chip(`${num(a.age_days)} kun kutdi`, 'danger') : ''}</div>
              <p>${esc(a.summary || '')}</p>
              ${a.impact ? `<p><b>Ta’sir:</b> ${esc(a.impact)}</p>` : ''}
              <small>So‘rov: ${esc(a.requested_by_name || '—')} · ${esc(timeAgo(a.created_at))}${a.decided_by_name ? ` · qaror: ${esc(a.decided_by_name)}` : ''}</small>
              ${a.status === 'pending' && can('approvals.approve') ? `<div class="row-actions">
                <button class="primary small" data-action="approval:approve" data-id="${esc(a.id)}">Tasdiqlash</button>
                <button class="ghost small danger" data-action="approval:reject" data-id="${esc(a.id)}">Rad etish</button>
                ${a.link ? `<button class="ghost small" data-link='${esc(JSON.stringify(a.link))}' data-action="goto:link">Tegishli bo‘lim</button>` : ''}
              </div>` : `<div class="row-actions">${a.status_label ? chip(a.status_label, statusTone(a.status)) : ''}</div>`}
            </div>
          </div>`).join('')
          : emptyState({ icon: '☑', title: 'Tasdiqlash kutilayotgan so‘rov yo‘q', text: 'Summasi tasdiqlash chegarasidan yuqori xarajatlar va qo‘lda kiritilgan jurnal yozuvlari shu yerda paydo bo‘ladi.' }),
      })}`;
    },
    async mount() {
      const sel = document.getElementById('appr-status');
      if (sel) sel.addEventListener('change', (e) => go('approvals', { status: e.target.value }));
      window.BUX.ACTIONS['approval:approve'] = (el) => openForm({
        title: 'So‘rovni tasdiqlash', description: 'Tasdiqlangandan so‘ng amal darhol bajariladi va audit jurnaliga yoziladi.',
        fields: [{ name: 'note', label: 'Izoh (ixtiyoriy)' }], submitLabel: 'Tasdiqlash',
        onSubmit: async (data) => { const res = await api(`/api/approvals/${el.dataset.id}/approve`, { method: 'POST', body: { note: data.note } }); toast(res.result ? 'Tasdiqlandi va bajarildi.' : 'Tasdiqlandi.', 'success'); window.BUX.refreshBadges(); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['approval:reject'] = (el) => openForm({
        title: 'So‘rovni rad etish', fields: [{ name: 'note', label: 'Sabab', required: true }], submitLabel: 'Rad etish',
        onSubmit: async (data) => { await api(`/api/approvals/${el.dataset.id}/reject`, { method: 'POST', body: { note: data.note } }); toast('So‘rov rad etildi.', 'success'); window.BUX.refreshBadges(); window.BUX.renderPage(); },
      });
    },
  };

  // ══════════════════════════════ Maqsadlar ════════════════════════════════
  VIEWS.goals = {
    async load() {
      const data = await api('/api/dashboard/goals');
      const goals = data.goals || [];
      const metrics = data.metrics || {};
      return `
      ${card({
        title: 'Maqsadlar', subtitle: 'Progress real buxgalteriya ko‘rsatkichlaridan avtomatik hisoblanadi',
        actions: can('goals.manage') ? `<button class="primary" data-action="goal:new">＋ Maqsad qo‘shish</button>` : '',
        body: goals.length ? `<div class="goal-grid">${goals.map(g => `
          <div class="card goal-card">
            <div class="goal-title"><span>${esc(g.title || (metrics[g.metric] && metrics[g.metric].label) || g.metric)}</span><b>${pct(g.percent)}</b></div>
            ${progressBar(g.bar_percent != null ? g.bar_percent : g.percent)}
            <div class="goal-meta">
              <span>Joriy: <b>${money(g.current)}</b></span>
              <span>Maqsad: <b>${money(g.target)}</b></span>
            </div>
            ${g.remaining != null ? `<small>Qoldi: ${money(Math.abs(g.remaining))}${g.message ? ` · ${esc(g.message)}` : ''}</small>` : ''}
            <div class="row-actions">
              ${g.status === 'achieved' ? chip('Bajarildi', 'ok') : chip('Jarayonda', 'info')}
              ${can('goals.manage') ? `<button class="ghost small danger" data-action="goal:archive" data-id="${esc(g.id)}">Arxivlash</button>` : ''}
            </div>
          </div>`).join('')}</div>`
          : emptyState({
            icon: '◎', title: 'Maqsad qo‘yilmagan',
            text: 'Daromad, xarajat limiti, foyda yoki debitorlik undirish bo‘yicha maqsad qo‘ying — progress real raqamlardan hisoblanadi.',
            cta: { label: '＋ Maqsad qo‘shish', action: 'goal:new' },
          }),
      })}
      ${card({
        title: 'Mavjud maqsad ko‘rsatkichlari', subtitle: 'Tizim qo‘llab-quvvatlaydigan metrikalar',
        body: table(['Ko‘rsatkich', 'Tavsif', 'Yo‘nalish'], Object.entries(metrics).map(([k, m]) => [
          esc(m.label || k), esc(m.description || ''), m.direction === 'down' ? chip('Kamaytirish', 'warn') : chip('Oshirish', 'ok'),
        ])),
      })}`;
    },
    async mount() { window.BUX.ACTIONS['goal:new'] = () => openGoalForm(); },
  };

  function openGoalForm() {
    const metrics = ((window.BUX.S.meta && window.BUX.S.meta.goal_metrics) || {});
    openForm({
      title: 'Yangi maqsad', description: 'Maqsad davri uchun real ko‘rsatkich olinadi — hech narsa qo‘lda kiritilmaydi.',
      fields: [
        { name: 'metric', label: 'Ko‘rsatkich', type: 'select', options: Object.entries(metrics).map(([k, m]) => ({ value: k, label: m.label || k })) },
        { name: 'target', label: 'Maqsad summasi (so‘m)', type: 'number', required: true, min: 1 },
        { name: 'period', label: 'Davr', type: 'select', options: [{ value: 'month', label: 'Joriy oy' }, { value: 'quarter', label: 'Joriy chorak' }, { value: 'year', label: 'Joriy yil' }] },
        { name: 'title', label: 'Nomi (ixtiyoriy)', placeholder: 'Masalan: Sentabr sotuv rejasi' },
      ], submitLabel: 'Maqsad qo‘shish',
      onSubmit: async (data) => { await api('/api/dashboard/goals', { method: 'POST', body: data }); toast('Maqsad qo‘shildi.', 'success'); window.BUX.renderPage(); },
    });
  }
  window.BUX.ACTIONS['goal:new'] = openGoalForm;
  window.BUX.ACTIONS['goal:archive'] = (el) => confirmDialog({
    title: 'Maqsadni arxivlash', message: 'Maqsad ro‘yxatdan chiqariladi (tarix saqlanadi).',
    confirmLabel: 'Arxivlash', onConfirm: async () => { await api(`/api/dashboard/goals/${el.dataset.id}`, { method: 'DELETE' }); toast('Maqsad arxivlandi.', 'success'); window.BUX.renderPage(); },
  });

  // ══════════════════════════════ Audit jurnali ════════════════════════════
  VIEWS.audit = {
    async load(params) {
      const data = await api('/api/audit', { query: { ...rangeQs(), search: params.q, entity: params.entity, limit: 200 } });
      const items = data.items || [];
      return `
      ${card({
        title: 'Audit jurnali', subtitle: `${rangeLabel()} · kim, qachon, nimani o‘zgartirdi (eski va yangi qiymatlar)`,
        body: `<div class="filters">
            <input id="audit-search" placeholder="Qidirish: foydalanuvchi, izoh…" value="${esc(params.q || '')}">
            <select id="audit-entity">
              <option value="">Barcha obyektlar</option>
              ${['entry', 'transaction', 'invoice', 'bill', 'payment', 'party', 'product', 'document', 'user', 'settings', 'radar', 'close', 'tax', 'ai', 'company'].map(e => `<option value="${e}" ${params.entity === e ? 'selected' : ''}>${e}</option>`).join('')}
            </select>
          </div>
          ${table(['Vaqt', 'Foydalanuvchi', 'Amal', 'Obyekt', 'Izoh', 'O‘zgarish'], items.map(a => [
            `${shortDate(a.at ? a.at.slice(0, 10) : '')}<br><small>${a.at ? a.at.slice(11, 16) : ''}</small>`,
            esc(a.user_name || '—'),
            chip(a.action, 'neutral'),
            `${esc(a.entity || '')}${a.entity_id ? `<br><small>${esc(String(a.entity_id).slice(0, 14))}</small>` : ''}`,
            esc(a.summary || ''),
            a.before || a.after ? `<button class="ghost small" data-action="audit:diff" data-action-id="${esc(a.id)}">Farqni ko‘rish</button>` : '—',
          ]), { empty: emptyState({ title: 'Audit yozuvi yo‘q', text: 'Bu davrda o‘zgarishlar qayd etilmagan.' }) })}
          <div class="notice subtle">Audit jurnali o‘zgarmas: yozuvlar o‘chirilmaydi va har bir amal kim tomonidan bajarilgani saqlanadi.</div>`,
      })}`;
    },
    async mount() {
      const push = (patch, reset) => go('audit', { ...S.params, ...patch });
      let timer = null;
      const search = document.getElementById('audit-search');
      if (search) search.addEventListener('input', (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => push({ q: v }), 400); });
      const entity = document.getElementById('audit-entity');
      if (entity) entity.addEventListener('change', (e) => push({ entity: e.target.value }));
      window.BUX.ACTIONS['audit:diff'] = async (el) => {
        const data = await api('/api/audit', { query: { limit: 200 } });
        const row = (data.items || []).find(a => a.id === el.dataset.actionId);
        if (!row) { toast('Yozuv topilmadi.', 'warn'); return; }
        openForm({
          title: 'Audit yozuvi', description: `${esc(row.summary || '')}`, wide: true,
          fields: [{ name: 'x', label: 'Amal', value: row.action, readonly: true }],
          extraHtml: `${definitionList([
            ['Foydalanuvchi', esc(row.user_name || '—')],
            ['Vaqt', esc(row.at || '—')],
            ['IP', esc(row.ip || '—')],
          ])}
          <div class="diff-grid">
            <div><b>Eski qiymat</b><pre>${esc(JSON.stringify(row.before || {}, null, 2))}</pre></div>
            <div><b>Yangi qiymat</b><pre>${esc(JSON.stringify(row.after || {}, null, 2))}</pre></div>
          </div>`,
          submitLabel: 'Yopish', onSubmit: async () => {},
        });
      };
    },
  };

  // ══════════════════════════ Tarif va limitlar ════════════════════════════
  VIEWS.subscription = {
    async load() {
      const data = await api('/api/subscription');
      const sub = data.subscription || {};
      const plan = sub.plan_def || {};
      const limits = data.limits || plan.limits || {};
      const usage = data.usage || {};
      const payments = data.payments || [];
      const integration = data.payment_integration || {};
      const rows = Object.entries(limits).map(([key, limit]) => {
        const used = num(usage[key]);
        const isCount = typeof limit === 'number';
        const ratio = isCount && limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : null;
        return [
          labelLimit(key),
          isCount ? `${used} / ${limit}` : (limit === true ? chip('Mavjud', 'ok') : chip('Mavjud emas', 'danger')),
          ratio != null ? progressBar(ratio, ratio >= 90 ? 'orange-progress' : '') : (limit === false ? chip('Starter tarifdan', 'warn') : chip('Cheklovsiz', 'ok')),
        ];
      });
      return `
      <section class="metrics">
        ${metricCard({ label: 'Joriy tarif', value: plan.name || sub.plan || '—', icon: '◇', tone: 'purple', hint: `Holat: ${sub.effective_status || sub.status || '—'}` })}
        ${metricCard({ label: 'Foydalanuvchilar', value: `${num(usage.users)} / ${num(limits.users)}`, icon: '♧', tone: 'blue' })}
        ${metricCard({ label: 'Oylik narx', value: plan.price_monthly ? money(plan.price_monthly) : '—', icon: '◈', tone: 'green-icon', hint: plan.price_note || '' })}
        ${metricCard({ label: 'To‘lov integratsiyasi', value: integration.configured ? 'Ulangan' : 'Sozlanmagan', icon: '⌘', tone: integration.configured ? 'green-icon' : 'orange', hint: integration.configured ? '' : 'To‘lov provayderi ulanmagan — obuna qo‘lda boshqariladi' })}
      </section>
      ${card({
        title: 'Limitlar va foydalanish', subtitle: 'Limitlar server tomonida majburlanadi (chegaradan oshsa so‘rov bloklanadi)',
        body: table(['Ko‘rsatkich', 'Foydalanish', 'Holat'], rows),
      })}
      ${card({
        title: 'Tarifni almashtirish', subtitle: 'Tarif o‘zgarishi darhol kuchga kiradi',
        body: table(['Tarif', 'Narx', 'Kompaniyalar', 'Foydalanuvchilar', 'Tranzaksiyalar/oy', 'Imkoniyatlar', ''], (data.plans || []).map(p => [
          `<b>${esc(p.name)}</b>${p.key === sub.plan ? ' ' + chip('joriy', 'ok') : ''}`,
          p.price_monthly ? money(p.price_monthly) : 'Bepul',
          num(p.limits.companies), num(p.limits.users), num(p.limits.transactions_month),
          Object.entries(p.limits).filter(([k, v]) => v === true).map(([k]) => chip(labelLimit(k), 'ok')).join(' ') || '—',
          p.key !== sub.plan && can('subscription.manage') ? `<button class="primary small" data-action="plan:change" data-plan="${esc(p.key)}">Tanlash</button>` : '',
        ])),
      })}
      ${payments.length ? card({
        title: 'To‘lovlar tarixi', subtitle: 'Platformaga qayd etilgan to‘lovlar',
        body: table(['Sana', 'Tarif', 'Summa', 'Holat'], payments.map(p => [shortDate(p.date), esc(p.plan), money(p.amount), chip(p.status || 'to‘langan', 'ok')])),
      }) : `<div class="notice subtle">Hozircha obuna to‘lovlari qayd etilmagan. Tizim soxta daromad ko‘rsatmaydi — to‘lovlar faqat real qayd etilganda ko‘rinadi.</div>`}`;
    },
    async mount() {
      window.BUX.ACTIONS['plan:change'] = (el) => confirmDialog({
        title: 'Tarifni almashtirish', message: `Yangi tarif: ${el.dataset.plan}. Limitlar darhol o‘zgaradi.`,
        confirmLabel: 'Almashtirish',
        onConfirm: async () => { await api('/api/subscription/change', { method: 'POST', body: { plan: el.dataset.plan } }); toast('Tarif almashtirildi.', 'success'); window.BUX.renderPage(); },
      });
    },
  };
  function labelLimit(key) {
    const map = {
      companies: 'Kompaniyalar', users: 'Foydalanuvchilar', transactions_month: 'Tranzaksiyalar / oy', invoices_month: 'Hisob-fakturalar / oy',
      bills_month: 'Xarid hisoblari / oy', payments_month: 'To‘lovlar / oy', journal_entries_month: 'Jurnal yozuvlari / oy',
      ai_questions_month: 'AI savollar / oy', documents_mb: 'Hujjatlar hajmi (MB)', bank_import: 'Bank ko‘chirmasi importi',
      ocr: 'Hujjatdan ma’lumot ajratish (OCR)', radar: 'Xato Radar', advisor: 'AI maslahatchi', multi_company: 'Ko‘p kompaniya',
      audit_log: 'Audit jurnali', export: 'Eksport', api_access: 'API kirish', support: 'Qo‘llab-quvvatlash', reconciliation: 'Bank solishtirish',
    };
    return map[key] || key.replace(/_/g, ' ');
  }

  // ═══════════════════════════════ Sozlamalar ══════════════════════════════
  VIEWS.settings = {
    async load() {
      const [data] = await Promise.all([api('/api/settings')]);
      const c = data.company || {};
      const s = data.settings || {};
      const usage = data.usage || {};
      const legalForms = (S.meta && S.meta.legal_forms) || [];
      return `
      ${card({
        title: 'Kompaniya ma’lumotlari', subtitle: 'Yuridik shakl, STIR, MFO va bank rekvizitlari hisob-fakturalarda ishlatiladi',
        actions: can('settings.manage') ? `<button class="ghost" data-action="company:edit">Tahrirlash</button>` : '',
        body: definitionList([
          ['Nomi', esc(c.name || '—')],
          ['Yuridik shakl', esc((legalForms.find(f => f.key === c.legal_form) || {}).label || c.legal_form || '—')],
          ['STIR (INN)', esc(c.inn || '—')],
          ['Soliq rejimi', c.tax_mode === 'vat' ? 'QQS to‘lovchisi' : 'Aylanma solig‘i'],
          ['Direktor', esc(c.director_name || '—')],
          ['Bosh buxgalter', esc(c.accountant_name || '—')],
          ['Manzil', esc(c.address || '—')],
          ['Telefon', esc(c.phone || '—')],
          ['Bank', `${esc(c.bank_name || '—')}${c.mfo ? ` · MFO ${esc(c.mfo)}` : ''}`],
          ['Hisob raqami', esc(c.bank_account || '—')],
          ['E-invoice ma’lumotlari', c.e_invoice_id ? esc(c.e_invoice_id) : '— (sozlanmagan)'],
        ]),
      })}
      ${card({
        title: 'Buxgalteriya sozlamalari', subtitle: 'QQS, tasdiqlash chegaralari va davr nazorati',
        actions: can('settings.manage') ? `<button class="ghost" data-action="settings:edit">Tahrirlash</button>` : '',
        body: statRows([
          ['QQS yoqilgan', s.vat_enabled ? chip('Ha', 'ok') : chip('Yo‘q', 'neutral')],
          ['QQS stavkasi', `${num(s.vat_rate)}%`],
          ['Tasdiqlash chegarasi', s.approval_threshold ? `${money(s.approval_threshold)} dan yuqori operatsiyalar tasdiqlanadi` : 'Belgilanmagan'],
          ['Hujjat talab qilinadigan summa', s.document_required_above ? money(s.document_required_above) : '—'],
          ['Yopilgan davrni bloklash', s.lock_after_close ? 'Yoqilgan' : 'O‘chirilgan'],
          ['Moliyaviy yil boshlanishi', esc(s.fiscal_year_start || '01-01')],
        ]),
      })}
      ${card({
        title: 'Hisoblar mosligi (role → account)', subtitle: 'Har bir moliyaviy oqim qaysi hisobga yozilishini belgilaydi',
        body: table(['Rol', 'Hisob'], Object.entries(data.role_accounts || {}).map(([role, code]) => [
          esc({ cash: 'Kassa', bank: 'Bank', ar: 'Debitorlik', ap: 'Kreditorlik', revenue: 'Sotuv daromadi', revenue_service: 'Xizmat daromadi', cos: 'Sotuv tannarxi', salary: 'Ish haqi', tax_payable: 'Soliq majburiyati', vat_out: 'QQS (chiqim)', vat_in: 'QQS (kirim)', inventory: 'Ombor', equity: 'Kapital', retained: 'Taqsimlanmagan foyda', other_expense: 'Boshqa xarajat', returns: 'Qaytarishlar' }[role] || role),
          `<button class="link" data-action="settings:account" data-code="${esc(code)}">${esc(code)}</button>`,
        ])),
      })}
      <section class="grid-bottom">
        <div class="card">
          <div class="card-head"><div><h2>Ma’lumotlar va xavfsizlik</h2><p>Parol, demo ma’lumotlar, kompaniyani arxivlash</p></div></div>
          <div class="row-actions">
            <button class="ghost" data-action="password:change">Parolni o‘zgartirish</button>
            ${can('settings.manage') ? `<button class="ghost" data-action="company:seed">Demo ma’lumotlarni yuklash</button>` : ''}
            ${can('settings.manage') ? `<button class="ghost danger" data-action="company:archive">Kompaniyani arxivlash</button>` : ''}
          </div>
          <div class="notice subtle"><b>Ma’lumotlar:</b> barcha yozuvlar atomic JSON bazada saqlanadi (${esc(usage.plan_name || '')}). Yozuvlar o‘chirilmaydi — faqat teskari yozuv bilan bekor qilinadi.</div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Hisoblar rejasi</h2><p>O‘zbek buxgalteriya hisoblari (${num(data.accounts_count || 0)} ta)</p></div>
            <button class="ghost" data-action="settings:coa">Hisoblar rejasini ko‘rish</button></div>
          <div class="notice"><b>Diqqat:</b> hisoblar rejasini o‘zgartirish buxgalteriya ma’lumotlariga ta’sir qiladi. Mas’ul buxgalter bilan kelishib oling.</div>
          <div class="row-actions"><button class="ghost" data-action="settings:journal">Jurnal (General Ledger)</button></div>
        </div>
      </section>`;
    },
    async mount() {
      window.BUX.ACTIONS['company:edit'] = () => openForm({
        title: 'Kompaniya ma’lumotlarini tahrirlash', wide: true,
        fields: [
          { name: 'name', label: 'Nomi', value: (S.company && S.company.name) || '' },
          { name: 'inn', label: 'STIR (INN)' },
          { name: 'legal_form', label: 'Yuridik shakl', type: 'select', options: ((S.meta && S.meta.legal_forms) || []).map(f => ({ value: f.key, label: f.label })) },
          { name: 'tax_mode', label: 'Soliq rejimi', type: 'select', options: [{ value: 'vat', label: 'QQS to‘lovchisi' }, { value: 'turnover', label: 'Aylanma solig‘i' }] },
          { name: 'director_name', label: 'Direktor F.I.O.' },
          { name: 'accountant_name', label: 'Bosh buxgalter F.I.O.' },
          { name: 'address', label: 'Manzil' },
          { name: 'phone', label: 'Telefon' },
          { name: 'email', label: 'Email' },
          { name: 'bank_name', label: 'Bank nomi' },
          { name: 'mfo', label: 'MFO (5 xonali)' },
          { name: 'bank_account', label: 'Hisob raqami' },
          { name: 'e_invoice_id', label: 'E-invoice identifikatori' },
        ], submitLabel: 'Saqlash',
        onSubmit: async (data) => { await api(`/api/companies/${S.companyId}`, { method: 'PATCH', body: data }); toast('Kompaniya ma’lumotlari saqlandi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['settings:edit'] = async () => {
        const data = await api('/api/settings');
        const s = data.settings || {};
        openForm({
          title: 'Buxgalteriya sozlamalari', wide: true,
          fields: [
            { name: 'vat_enabled', label: 'QQS hisoblansin', type: 'checkbox', value: !!s.vat_enabled },
            { name: 'vat_rate', label: 'QQS stavkasi (%)', type: 'number', min: 0, max: 100, value: num(s.vat_rate) },
            { name: 'approval_threshold', label: 'Tasdiqlash chegarasi (so‘m)', type: 'number', min: 0, value: num(s.approval_threshold) },
            { name: 'document_required_above', label: 'Hujjat talab qilinadigan summa', type: 'number', min: 0, value: num(s.document_required_above) },
            { name: 'lock_after_close', label: 'Yopilgan davrga yozuv kiritishni bloklash', type: 'checkbox', value: s.lock_after_close !== false },
            { name: 'fiscal_year_start', label: 'Moliyaviy yil boshlanishi (MM-DD)', value: s.fiscal_year_start || '01-01' },
          ], submitLabel: 'Saqlash',
          onSubmit: async (data) => {
            await api('/api/settings', { method: 'PATCH', body: data });
            toast('Sozlamalar saqlandi. Har bir o‘zgarish audit jurnalida qayd etildi.', 'success');
            S.settings = { ...(S.settings || {}), ...data };
            window.BUX.renderPage();
          },
        });
      };
      window.BUX.ACTIONS['password:change'] = () => openForm({
        title: 'Parolni o‘zgartirish',
        fields: [
          { name: 'current_password', label: 'Joriy parol', type: 'password', required: true },
          { name: 'new_password', label: 'Yangi parol', type: 'password', required: true, help: 'Kamida 8 belgi, harf va raqam' },
        ], submitLabel: 'O‘zgartirish',
        onSubmit: async (data) => { await api('/api/auth/password', { method: 'POST', body: data }); toast('Parol o‘zgartirildi.', 'success'); },
      });
      window.BUX.ACTIONS['company:archive'] = () => confirmDialog({
        title: 'Kompaniyani arxivlash',
        message: 'Kompaniya ro‘yxatdan chiqariladi (ma’lumotlar o‘chirilmaydi). Keyin SuperAdmin orqali tiklash mumkin.',
        confirmLabel: 'Arxivlash', danger: true,
        onConfirm: async () => { await api(`/api/companies/${S.companyId}`, { method: 'DELETE' }); toast('Kompaniya arxivlandi.', 'success'); S.companyId = null; await window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['settings:coa'] = async () => {
        const data = await api('/api/accounts');
        openForm({
          title: 'Hisoblar rejasi', description: 'Buxgalteriya hisoblari va qoldiqlari',
          wide: true, fields: [{ name: 'x', label: 'Hisoblar', value: `${num((data.items || []).length)} ta`, readonly: true }],
          extraHtml: table(['Kod', 'Nomi', 'Turi', 'Qoldiq'], (data.items || []).map(a => [
            esc(a.code), esc(a.name), esc(a.type), money(a.balance),
          ])),
          submitLabel: 'Yopish', onSubmit: async () => {},
        });
      };
      window.BUX.ACTIONS['settings:journal'] = async () => {
        const data = await api('/api/journal', { query: rangeQs() });
        openForm({
          title: 'General Ledger (jurnal)', description: `${rangeLabel()} · ${num((data.entries || []).length)} yozuv`,
          wide: true, fields: [{ name: 'x', label: 'Davr', value: rangeLabel(), readonly: true }],
          extraHtml: table(['Sana', 'Yozuv', 'Hisob', 'Debet', 'Kredit'], (data.trial_balance && data.trial_balance.rows || []).map(r => [
            '—', '—', `${esc(r.code)} ${esc(r.name)}`, money(r.debit), money(r.credit),
          ])),
          submitLabel: 'Yopish', onSubmit: async () => {},
        });
      };
      window.BUX.ACTIONS['settings:account'] = (el) => go('transactions', { account: el.dataset.code });
    },
  };

  // ══════════════════════════════ SuperAdmin ═══════════════════════════════
  VIEWS.platform = {
    async load(params) {
      if (!S.user.is_platform_admin) return emptyState({ title: 'Ruxsat yo‘q', text: 'Bu bo‘lim faqat platforma administratori uchun.' });
      const tab = params.tab || 'overview';
      if (tab === 'users') {
        const data = await api('/api/platform/users', { query: { page: num(params.page) || 1, page_size: 50, search: params.q } });
        return platformTabs(tab, `${card({
          title: 'Platforma foydalanuvchilari', subtitle: `Jami ${num(data.total)} ta foydalanuvchi`,
          body: table(['Ism', 'Email', 'Rol', 'Holat', 'Kompaniyalar', 'Oxirgi kirish', ''], (data.items || []).map(u => [
            `<b>${esc(u.name)}</b>`, esc(u.email), esc(u.role || '—'), chip(u.status === 'blocked' ? 'Bloklangan' : 'Faol', u.status === 'blocked' ? 'danger' : 'ok'),
            num(u.companies_count), u.last_login_at ? timeAgo(u.last_login_at) : '—',
            `<button class="ghost small" data-action="platform:user" data-id="${esc(u.id)}">Boshqarish</button>`,
          ])),
        })}`);
      }
      if (tab === 'companies') {
        const data = await api('/api/platform/companies', { query: { page: num(params.page) || 1, page_size: 50 } });
        return platformTabs(tab, `${card({
          title: 'Kompaniyalar', subtitle: `Jami ${num(data.total)} ta kompaniya · tarif, foydalanish va faollik`,
          body: table(['Kompaniya', 'Tarif', 'Foydalanuvchilar', 'Yozuvlar', 'Saqlash', 'Holat', 'Yaratilgan'], (data.items || []).map(c => [
            `<b>${esc(c.name)}</b>${c.inn ? `<br><small>STIR ${esc(c.inn)}</small>` : ''}`,
            chip(c.plan_label || c.plan || '—', 'info'), num(c.users), num(c.entries), c.storage_label || '—',
            chip(c.subscription_status || c.status || '—', statusTone(c.subscription_status || c.status)),
            shortDate((c.created_at || '').slice(0, 10)),
          ])),
        })}`);
      }
      if (tab === 'errors') {
        const data = await api('/api/platform/errors');
        return platformTabs(tab, `${card({
          title: 'Xatolar jurnali', subtitle: 'Server xatolari (500) va istisnolar',
          actions: `<button class="ghost danger" data-action="platform:clear-errors">Tozalash</button>`,
          body: table(['Vaqt', 'Kod', 'Xabar', 'Manzil', 'Foydalanuvchi'], (data.items || []).map(e => [
            e.at ? `${shortDate(e.at.slice(0, 10))}<br><small>${e.at.slice(11, 19)}</small>` : '—',
            chip(e.code || 'error', 'danger'), esc(e.message || ''), esc(`${e.method || ''} ${e.path || ''}`), esc(e.user || '—'),
          ]), { empty: emptyState({ title: 'Xatolar yo‘q', text: 'Serverda xatolar qayd etilmagan.' }) }),
        })}`);
      }
      if (tab === 'tickets') {
        const data = await api('/api/platform/tickets');
        return platformTabs(tab, `${card({
          title: 'Qo‘llab-quvvatlash so‘rovlari', subtitle: 'Foydalanuvchilardan kelgan murojaatlar',
          body: table(['Kompaniya', 'Mavzu', 'Muhimlik', 'Holat', 'Yaratilgan', ''], (data.items || []).map(t => [
            esc(t.company_name || '—'), esc(t.subject), chip(t.priority || 'normal', 'info'), chip(t.status === 'closed' ? 'Yopilgan' : 'Ochiq', t.status === 'closed' ? 'neutral' : 'warn'),
            timeAgo(t.created_at), t.status !== 'closed' ? `<button class="ghost small" data-action="platform:reply" data-id="${esc(t.id)}">Javob berish</button>` : '',
          ]), { empty: emptyState({ title: 'So‘rov yo‘q', text: 'Foydalanuvchilar murojaati mavjud emas.' }) }),
        })}`);
      }
      const data = await api('/api/platform/overview');
      const sub = data.subscriptions || {};
      const revenue = data.revenue || {};
      const users = data.users || {};
      const companies = data.companies || {};
      const storage = data.storage || {};
      const activity = data.activity || {};
      const mrrRows = (sub.by_plan || []).filter(p => p.mrr != null);
      const mrrTotal = mrrRows.reduce((acc, p) => acc + num(p.mrr), 0);
      return platformTabs('overview', `
      <section class="metrics">
        ${metricCard({ label: 'Foydalanuvchilar', value: num(users.total), icon: '♧', tone: 'purple', hint: `${num(users.active)} faol · ${num(users.blocked)} bloklangan · ${num(users.new_30d)} yangi (30 kun)` })}
        ${metricCard({ label: 'Kompaniyalar', value: num(companies.total), icon: '◈', tone: 'blue', hint: `${num(companies.new_30d)} ta yangi (30 kun) · ${num(companies.with_activity_30d)} faol` })}
        ${metricCard({ label: 'Faol obunalar', value: num(sub.active), icon: '◇', tone: 'green-icon', hint: `Sinov: ${num(sub.trialing)} · Muddati o‘tgan: ${num(sub.expired)}` })}
        ${metricCard({ label: 'Qayd etilgan to‘lovlar (30 kun)', value: money(revenue.recorded_payments_30d), icon: '₴', tone: 'orange', hint: `${num(revenue.payment_count)} ta to‘lov · jami ${money(revenue.recorded_payments_total)}` })}
      </section>
      <div class="notice subtle">${esc(revenue.note || 'Platforma daromadi faqat qayd etilgan to‘lovlardan hisoblanadi.')}</div>
      <section class="grid-main">
        <div class="card">
          <div class="card-head"><div><h2>Tariflar bo‘yicha</h2><p>MRR — faqat real narxlar bo‘yicha hisoblanadi</p></div></div>
          ${table(['Tarif', 'Kompaniyalar', 'Oylik narx', 'MRR'], (sub.by_plan || []).map(p => [
            esc(p.name || p.plan), num(p.count), p.price_monthly ? money(p.price_monthly) : 'Bepul', p.mrr == null ? '—' : money(p.mrr),
          ]), { empty: `<p class="empty-hint">Tarif ma’lumoti yo‘q.</p>` })}
          ${mrrRows.length ? statRows([['MRR (real tarif narxlaridan)', money(mrrTotal)], ['Narxi belgilanmagan tariflar', `${(sub.by_plan || []).length - mrrRows.length} ta (MRR ga kirmaydi)`]])
            : `<div class="notice warn">${esc(sub.mrr_note || 'MRR hisoblash uchun tarif narxlari sozlanmagan.')}</div>`}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Faollik</h2><p>Jurnal yozuvlari va hujjatlar (real sonlar)</p></div></div>
          ${statRows([
            ['Yozuvlar (30 kun)', num(activity.entries_30d)],
            ['Yozuvlar (jami)', num(activity.entries_total)],
            ['Tranzaksiyalar (30 kun)', num(activity.transactions_30d)],
            ['Hisob-fakturalar (jami)', num(activity.invoices_total)],
            ['Hujjatlar (jami)', num(activity.documents_total)],
            ['Bank ko‘chirma qatorlari', num(activity.bank_rows_total)],
            ['Ochiq Radar topilmalari', num(activity.radar_issues_open)],
            ['AI savollar (30 kun)', num(activity.ai_questions_30d)],
          ])}
          <div class="notice subtle">AI sarfi (token) bo‘yicha aniq hisob yo‘q — taxminiy raqam ko‘rsatilmaydi.</div>
        </div>
      </section>
      <section class="grid-main">
        <div class="card">
          <div class="card-head"><div><h2>Eng faol kompaniyalar</h2><p>Yozuvlar soni bo‘yicha</p></div></div>
          ${table(['Kompaniya', 'Tarif', 'Yozuvlar', 'Kassa/bank', 'Xodimlar', 'Oxirgi yozuv'], (data.top_companies || []).map(c => [
            `<b>${esc(c.name)}</b>${c.inn ? `<br><small>STIR ${esc(c.inn)}</small>` : ''}`,
            chip(labelPlan(c.plan), 'info'), num(c.entries), money(c.cash), num(c.users), c.last_entry ? timeAgo(c.last_entry) : '—',
          ]), { empty: `<p class="empty-hint">Kompaniya yo‘q.</p>` })}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Saqlash hajmi</h2><p>${num(storage.mb).toFixed(2)} MB · ${num(storage.documents)} ta hujjat</p></div></div>
          ${table(['Kompaniya', 'Hajm', 'Hujjatlar'], (storage.by_company || []).map(s => [
            esc(s.name || s.company_name || '—'), `${num(s.mb).toFixed(2)} MB`, num(s.documents),
          ]), { empty: `<p class="empty-hint">Hujjat yuklanmagan — saqlash hajmi 0.</p>` })}
        </div>
      </section>`);
    },
    async mount() {
      window.BUX.ACTIONS['platform:clear-errors'] = () => confirmDialog({
        title: 'Xatolar jurnalini tozalash', message: 'Barcha yozuvlar o‘chiriladi.',
        confirmLabel: 'Tozalash', danger: true,
        onConfirm: async () => { await api('/api/platform/errors', { method: 'DELETE' }); toast('Tozalandi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['platform:user'] = async (el) => {
        const data = await api('/api/platform/users', { query: { page_size: 200 } });
        const u = (data.items || []).find(x => x.id === el.dataset.id);
        if (!u) return;
        openForm({
          title: u.name, description: u.email, wide: true,
          fields: [
            { name: 'status', label: 'Holat', type: 'select', options: [{ value: 'active', label: 'Faol' }, { value: 'blocked', label: 'Bloklangan' }], value: u.status || 'active' },
            { name: 'is_platform_admin', label: 'Platforma administratori', type: 'checkbox', value: !!u.is_platform_admin },
          ],
          extraHtml: statRows([['Kompaniyalar', num(u.companies_count)], ['Rol', esc(u.role || '—')], ['Oxirgi kirish', u.last_login_at ? timeAgo(u.last_login_at) : '—']]),
          submitLabel: 'Saqlash',
          onSubmit: async (data) => { await api(`/api/platform/users/${u.id}`, { method: 'PATCH', body: data }); toast('Foydalanuvchi yangilandi.', 'success'); window.BUX.renderPage(); },
        });
      };
      window.BUX.ACTIONS['platform:reply'] = (el) => openForm({
        title: 'So‘rovga javob', fields: [{ name: 'message', label: 'Javob', type: 'textarea', rows: 4, required: true }], submitLabel: 'Yuborish',
        onSubmit: async (data) => { await api(`/api/platform/tickets/${el.dataset.id}/reply`, { method: 'POST', body: data }); toast('Javob yuborildi.', 'success'); window.BUX.renderPage(); },
      });
    },
  };

  function platformTabs(active, body) {
    const tabs = [['overview', 'Umumiy'], ['users', 'Foydalanuvchilar'], ['companies', 'Kompaniyalar'], ['errors', 'Xatolar'], ['tickets', 'Support']];
    return `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${active === k ? 'active' : ''}" data-action="platform:tab" data-tab="${k}">${l}</button>`).join('')}</div>${body}`;
  }
  window.BUX.ACTIONS['platform:tab'] = (el) => go('platform', { tab: el.dataset.tab });
  function labelActivity(key) {
    const map = { entries_30d: 'Yozuvlar (30 kun)', entries_total: 'Yozuvlar (jami)', invoices_total: 'Hisob-fakturalar', documents_total: 'Hujjatlar', ai_questions_30d: 'AI savollar (30 kun)', ocr_runs_30d: 'OCR ajratishlar', transactions_30d: 'Tranzaksiyalar (30 kun)', bank_rows_total: 'Bank qatorlari', radar_issues_open: 'Ochiq Radar topilmalari' };
    return map[key] || key.replace(/_/g, ' ');
  }
  function labelPlan(key) {
    const map = { trial: 'Sinov', starter: 'Starter', business: 'Business', enterprise: 'Professional', professional: 'Professional' };
    return map[key] || key || '—';
  }

  // ════════════════════════════════ Yordam ═════════════════════════════════
  VIEWS.support = {
    async load() {
      const data = await api('/api/support/tickets');
      return `
      ${card({
        title: 'Qo‘llab-quvvatlash', subtitle: 'Muammo yoki savolingizni yozib qoldiring — javob shu yerda ko‘rinadi',
        actions: `<button class="primary" data-action="support:new">＋ Yangi murojaat</button>`,
        body: table(['Mavzu', 'Muhimlik', 'Holat', 'Yaratilgan', 'Javob'], (data.items || []).map(t => [
          `<b>${esc(t.subject)}</b><br><small>${esc((t.message || '').slice(0, 120))}</small>`,
          chip(t.priority || 'normal', 'info'), chip(t.status === 'closed' ? 'Yopilgan' : 'Ochiq', t.status === 'closed' ? 'neutral' : 'warn'),
          timeAgo(t.created_at), esc(t.reply || '—'),
        ]), { empty: emptyState({ icon: '?', title: 'Murojaat yo‘q', text: 'Savolingiz bo‘lsa murojaat qoldiring — javob tarixi saqlanadi.' }) }),
      })}
      ${card({
        title: 'Tez yordam', subtitle: 'Eng ko‘p so‘raladigan amallar',
        body: `<div class="insight-list">
          <div class="insight-item"><b>Bank ko‘chirmasini qanday yuklayman?</b><p>«Bank va kassa» bo‘limida «Ko‘chirma yuklash» tugmasini bosing. CSV, Excel yoki matnli qatlami bor PDF qabul qilinadi. Har bir qator ishonch foizi bilan solishtiriladi.</p></div>
          <div class="insight-item"><b>Nega foyda raqami boshqa joyda boshqacha?</b><p>Barcha raqamlar bitta jurnaldan olinadi. Farq ko‘rsangiz — «Xato Radar» ni skanerlang yoki murojaat qoldiring: bu nomuvofiqlik xato sifatida qayd etiladi.</p></div>
          <div class="insight-item"><b>AI javobi qanday tekshiriladi?</b><p>Har bir javobda tasnif (fakt/hisob-kitob/prognoz/tavsiya), ishonch darajasi va manbalar ko‘rsatiladi. Prognozlar har doim «prognoz» deb belgilanadi.</p></div>
        </div>`,
      })}`;
    },
    async mount() {
      window.BUX.ACTIONS['support:new'] = () => openForm({
        title: 'Yangi murojaat', fields: [
          { name: 'subject', label: 'Mavzu', required: true },
          { name: 'message', label: 'Tavsif', type: 'textarea', rows: 5, required: true },
          { name: 'priority', label: 'Muhimlik', type: 'select', options: [{ value: 'low', label: 'Past' }, { value: 'normal', label: 'O‘rta' }, { value: 'high', label: 'Yuqori' }, { value: 'critical', label: 'Kritik' }] },
        ], wide: true, submitLabel: 'Yuborish',
        onSubmit: async (data) => { await api('/api/support/tickets', { method: 'POST', body: data }); toast('Murojaat yuborildi.', 'success'); window.BUX.renderPage(); },
      });
    },
  };

  window.VIEWS = VIEWS;
})();
