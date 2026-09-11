'use strict';
/** BUXAI — sahifalar: bank/kassa, hujjatlar, Xato Radar, ombor, kontragentlar (CRM), hisobotlar, pul oqimi. */
(function () {
  const { S, api, go, toast, money, num, esc, can, chip, card, table, metricCard, statRows, emptyState, pager,
    progressBar, barsChart, openForm, confirmDialog, fmtDate, shortDate, timeAgo, pct, compact, definitionList,
    statusTone, severityTone, download, ApiError } = window.BUX;
  const VIEWS = (window.VIEWS = window.VIEWS || {});
  const rangeQs = () => ({ from: S.range.from, to: S.range.to });
  const rangeLabel = () => S.range.label || 'Bu oy';

  // ═══════════════════════ Bank va kassa + solishtirish ════════════════════
  VIEWS.banking = {
    async load(params) {
      const [accountsRes, recon] = await Promise.all([
        api('/api/bank/accounts'),
        api('/api/reconciliation', { query: { account: params.account, from: S.range.from, to: S.range.to } }).catch(() => null),
      ]);
      const accounts = accountsRes.accounts || [];
      VIEWS.banking._accounts = accounts;
      const cash = accountsRes.cash_position || { rows: [], total: 0 };
      const activeAccount = params.account || (accounts[0] && accounts[0].code);
      const rows = (recon && recon.rows) || [];
      const summary = (recon && recon.summary) || {};
      const groups = [
        ['exact', 'Aniq moslik (85%+)', 'ok'],
        ['possible', 'Ehtimoliy moslik (60–84%)', 'info'],
        ['low', 'Past ishonch (60% dan kam)', 'warn'],
        ['none', 'Mos yozuv topilmadi', 'danger'],
        ['duplicates', 'Dublikat shubhasi', 'warn'],
        ['missing_in_statement', 'Buxgalteriyada bor, ko‘chirmada yo‘q', 'info'],
      ];
      return `
      <section class="metrics">
        ${metricCard({ label: 'Kassa va bank jami', value: money(cash.total), icon: '◈', tone: 'blue', hint: `${accounts.length} ta hisob` })}
        ${metricCard({ label: 'Solishtirilmagan qatorlar', value: num((summary.unmatched || 0)), icon: '⌘', tone: 'orange', hint: recon ? `${num(summary.total_rows)} qator tekshirildi` : 'Ko‘chirma yuklanmagan' })}
        ${metricCard({ label: 'Mos kelgan', value: num((summary.exact || 0) + (summary.possible || 0)), icon: '✓', tone: 'green-icon' })}
        ${metricCard({ label: 'Import qilingan ko‘chirmalar', value: num((accountsRes.imports || []).length), icon: '⇧', tone: 'purple' })}
      </section>
      ${card({
        title: 'Hisoblar (kassa va bank)', subtitle: 'Har bir hisob buxgalteriya jurnaliga bog‘langan',
        actions: `<div class="row-actions">
          ${can('banking.manage') ? `<button class="ghost" data-action="bank:new">＋ Hisob qo‘shish</button>` : ''}
          ${can('banking.manage') ? `<button class="primary" data-action="bank:import">⇧ Ko‘chirma yuklash</button>` : ''}
        </div>`,
        body: table(['Hisob', 'Turi', 'Bank rekvizitlari', 'Qoldiq', ''], accounts.map(a => [
          `<b>${esc(a.code)} — ${esc(a.name)}</b>`, a.is_cash ? chip('Kassa', 'info') : chip('Bank', 'ok'),
          a.is_bank ? `${esc(a.bank_name || '—')}${a.mfo ? ` · MFO ${esc(a.mfo)}` : ''}${a.account_number ? `<br><small>${esc(a.account_number)}</small>` : ''}` : '—',
          `<b>${money(a.balance)}</b>`, `<button class="ghost small" data-action="bank:detail" data-code="${esc(a.code)}">Karta</button>`,
        ]), { empty: emptyState({ title: 'Hisob yo‘q', text: 'Bank yoki kassa hisobini qo‘shing.' }) }),
      })}
      <section class="grid-main">
        <div class="card">
          <div class="card-head"><div><h2>Bank solishtirish (smart reconciliation)</h2><p>Har bir moslik ishonch foizi bilan — hech narsa avtomatik o‘zgartirilmaydi</p></div>
            <select id="recon-account">${accounts.map(a => `<option value="${esc(a.code)}" ${activeAccount === a.code ? 'selected' : ''}>${esc(a.code)} — ${esc(a.name)}</option>`).join('')}</select></div>
          ${recon && recon.summary && recon.summary.total_rows === 0
            ? emptyState({ icon: '⌘', title: 'Ko‘chirma qatori yo‘q', text: 'Bank ko‘chirmasini (CSV, Excel yoki matnli PDF) yuklang — tizim qatorlarni jurnaldagi yozuvlar bilan solishtiradi.', cta: { label: '⇧ Ko‘chirma yuklash', action: 'bank:import' } })
            : `${table(['Sana', 'Tavsif', 'Yo‘nalish', 'Summa', 'Holat', 'Mos nomzod', ''], rows.map(r => [
              shortDate(r.date),
              `<div><b>${esc(r.description || '—')}</b>${r.duplicate_hint ? `<br><small class="warn-text">Dublikat shubhasi</small>` : ''}</div>`,
              r.direction === 'in' ? chip('Kirim', 'ok') : chip('Chiqim', 'warn'),
              money(r.amount),
              chip(r.status_label || r.status, statusTone(r.status === 'unmatched' ? 'unmatched' : r.status)),
              r.candidate_count != null ? `${num(r.candidate_count)} ta nomzod${r.best_confidence ? ` · ${num(r.best_confidence)}%` : ''}` : '—',
              `<div class="row-actions">
                ${r.status === 'unmatched' ? `<button class="ghost small" data-action="recon:candidates" data-id="${esc(r.id)}">Moslik</button>
                <button class="ghost small" data-action="recon:create" data-id="${esc(r.id)}">Operatsiya yaratish</button>
                <button class="ghost small" data-action="recon:ignore" data-id="${esc(r.id)}">E’tiborsiz</button>` : chip('Bajarilgan', 'ok')}
              </div>`,
            ]), { empty: emptyState({ title: 'Solishtirish uchun qator yo‘q', text: 'Bu davrda ko‘chirma qatorlari topilmadi.' }) })}`
          }
          ${recon ? `<div class="recon-summary">${groups.map(([key, label, tone]) => `<div class="recon-item ${tone}"><b>${num(summary[key] || 0)}</b><span>${esc(label)}</span></div>`).join('')}</div>` : ''}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Importlar tarixi</h2><p>Yuklangan ko‘chirmalar</p></div></div>
          ${(accountsRes.imports || []).length ? table(['Fayl', 'Sana', 'Qatorlar', 'Holat', ''], (accountsRes.imports || []).slice(0, 8).map(im => [
            esc(im.filename), shortDate(im.created_at ? im.created_at.slice(0, 10) : ''), num(im.row_count),
            chip(im.status_label || im.status || 'yuklandi', 'info'),
            can('banking.manage') ? `<button class="ghost small danger" data-action="bank:delete-import" data-id="${esc(im.id)}">O‘chirish</button>` : '',
          ])) : `<p class="empty-hint">Import qilinmagan.</p>`}
          <div class="notice subtle"><b>Qo‘llab-quvvatlanadi:</b> CSV (nuqta-vergul yoki vergul), Excel (.xlsx) va matnli qatlami bor PDF. Skanerlangan rasm uchun OCR yo‘q — bu haqda tizim ochiq xabar beradi.</div>
        </div>
      </section>`;
    },
    async mount() {
      const sel = document.getElementById('recon-account');
      if (sel) sel.addEventListener('change', (e) => go('banking', { ...S.params, account: e.target.value }));
      window.BUX.ACTIONS['bank:new'] = () => openForm({
        title: 'Yangi bank hisobi', fields: [
          { name: 'kind', label: 'Turi', type: 'select', options: [{ value: 'bank', label: 'Bank hisobi' }, { value: 'cash', label: 'Kassa' }] },
          { name: 'name', label: 'Nomi', required: true, placeholder: 'Masalan: Asosiy hisob — Tashkent City Bank' },
          { name: 'bank_name', label: 'Bank nomi', placeholder: 'Bank nomi' },
          { name: 'mfo', label: 'MFO (5 xonali)', placeholder: '00401' },
          { name: 'account_number', label: 'Hisob raqami (20 xonali)', placeholder: '20208000904567890123' },
          { name: 'opening_balance', label: 'Boshlang‘ich qoldiq', type: 'number', min: 0, value: 0, help: 'Qoldiq balans hisobiga yozuv sifatida kiritiladi' },
        ], submitLabel: 'Hisobni qo‘shish',
        onSubmit: async (data) => { await api('/api/bank/accounts', { method: 'POST', body: data }); toast('Hisob qo‘shildi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['bank:import'] = () => openForm({
        title: 'Bank ko‘chirmasini yuklash',
        description: 'Fayl qatorlari jurnaldagi yozuvlar bilan solishtiriladi (avtomatik o‘zgartirish yo‘q).',
        fields: [
          { name: 'account', label: 'Hisob', type: 'select', options: (VIEWS.banking._accounts || []).map(a => ({ value: a.code, label: `${a.code} — ${a.name}` })), required: true },
          { name: 'file', label: 'Fayl (CSV, XLSX, PDF)', type: 'file', accept: '.csv,.xlsx,.xls,.pdf,.txt', required: true },
          { name: 'period_start', label: 'Davr boshlanishi', type: 'date', value: S.range.from },
          { name: 'period_end', label: 'Davr tugashi', type: 'date', value: S.range.to },
        ], submitLabel: 'Yuklash',
        onSubmit: async (data, { files }) => {
          const file = files.get('file');
          if (!file || !file.size) throw ApiError('Faylni tanlang.');
          const form = new FormData();
          form.append('file', file);
          form.append('account', data.account);
          if (data.period_start) form.append('period_start', data.period_start);
          if (data.period_end) form.append('period_end', data.period_end);
          const res = await api('/api/bank/import', { method: 'POST', form });
          toast(`Ko‘chirma yuklandi: ${num(res.rows)} qator (${num(res.duplicates || 0)} dublikat o‘tkazildi).`, 'success', 8000);
          window.BUX.renderPage();
        },
      });
      window.BUX.ACTIONS['bank:delete-import'] = (el) => confirmDialog({
        title: 'Importni o‘chirish', message: 'Import va uning solishtirilmagan qatorlari o‘chiriladi. Jurnal yozuvlari o‘zgarmaydi.',
        confirmLabel: 'O‘chirish', danger: true,
        onConfirm: async () => { await api(`/api/bank/imports/${el.dataset.id}`, { method: 'DELETE' }); toast('Import o‘chirildi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['bank:detail'] = async (el) => {
        const data = await api(`/api/bank/accounts/${el.dataset.code}`, { query: rangeQs() });
        openForm({
          title: `${data.account ? data.account.code : el.dataset.code} — ${data.account ? data.account.name : ''}`,
          description: `${rangeLabel()} · qoldiq ${money(data.closing)}`,
          wide: true, fields: [{ name: 'x', label: 'Filtr', value: `${rangeLabel()}`, readonly: true }],
          extraHtml: `${statRows([
            ['Boshlang‘ich qoldiq', money(data.opening)],
            ['Kirim', money(data.debit)],
            ['Chiqim', money(data.credit)],
            ['Yakuniy qoldiq', `<b>${money(data.closing)}</b>`],
          ])}
          ${table(['Sana', 'Izoh', 'Debet', 'Kredit', 'Qoldiq'], (data.rows || []).map(r => [
            shortDate(r.date), esc(r.memo || r.description || ''), r.debit ? money(r.debit) : '—', r.credit ? money(r.credit) : '—', money(r.balance),
          ]), { empty: emptyState({ title: 'Harakat yo‘q', text: 'Bu davrda hisob bo‘yicha harakat topilmadi.' }) })}`,
          submitLabel: 'Yopish', onSubmit: async () => {},
        });
      };
      window.BUX.ACTIONS['recon:candidates'] = async (el) => {
        const data = await api(`/api/reconciliation/rows/${el.dataset.id}`);
        const row = data.row || data;
        const candidates = data.candidates || [];
        openForm({
          title: 'Moslik nomzodlari', description: `${shortDate(row.date)} · ${row.description || ''} · ${money(row.amount)}`,
          wide: true, fields: [{ name: 'x', label: 'Qator', value: `${money(row.amount)}`, readonly: true }],
          extraHtml: candidates.length ? table(['Yozuv', 'Sana', 'Summa', 'Ishonch', ''], candidates.map(c => [
            `${esc(c.entry_no || '')} ${esc(c.memo || '')}`, shortDate(c.date), money(c.amount),
            `<div class="conf-bar"><i style="width:${num(c.confidence)}%"></i><span>${num(c.confidence)}%</span></div>`,
            `<button class="primary small" data-action="recon:accept" data-row="${esc(row.id)}" data-entry="${esc(c.entry_id)}">Qabul qilish</button>`,
          ])) : `<p class="empty-hint">Mos keladigan jurnal yozuvi topilmadi. «Operatsiya yaratish» orqali yangi yozuv kiritishingiz mumkin.</p>`,
          submitLabel: 'Yopish', onSubmit: async () => {},
        });
      };
      window.BUX.ACTIONS['recon:accept'] = (el) => confirmDialog({
        title: 'Moslikni qabul qilish',
        message: 'Qator «solishtirilgan» deb belgilanadi va jurnal yozuviga bog‘lanadi. Yozuvning o‘zi o‘zgarmaydi.',
        confirmLabel: 'Qabul qilish',
        onConfirm: async () => { await api(`/api/reconciliation/rows/${el.dataset.row}/accept`, { method: 'POST', body: { entry_id: el.dataset.entry } }); toast('Moslik qabul qilindi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['recon:create'] = async (el) => {
        const row = await api(`/api/reconciliation/rows/${el.dataset.id}`);
        const r = row.row || row;
        openForm({
          title: 'Bank qatoridan operatsiya yaratish',
          description: `${shortDate(r.date)} · ${r.description || ''} · ${money(r.amount)}. Yozuv jurnalga tushadi va qator bilan bog‘lanadi.`,
          fields: [
            { name: 'type', label: 'Turi', type: 'select', options: [{ value: r.direction === 'in' ? 'income' : 'expense', label: r.direction === 'in' ? 'Kirim (daromad)' : 'Chiqim (xarajat)' }, { value: 'transfer', label: 'O‘tkazma' }] },
            { name: 'category', label: 'Kategoriya', type: 'select', options: ((S.meta && S.meta.categories && (r.direction === 'in' ? S.meta.categories.income : S.meta.categories.expense)) || []).map(c => ({ value: c.key, label: c.label })) },
            { name: 'description', label: 'Izoh', value: r.description || '', required: true },
            { name: 'amount', label: 'Summa', type: 'number', value: num(r.amount), readonly: true },
            { name: 'vat_rate', label: 'QQS %', type: 'number', min: 0, max: 100, value: 0 },
          ],
          submitLabel: 'Yozuv yaratish',
          onSubmit: async (data) => { const res = await api(`/api/reconciliation/rows/${el.dataset.id}/create`, { method: 'POST', body: data }); toast(`Yozuv yaratildi: ${(res.transaction || {}).no || ''}`, 'success'); window.BUX.renderPage(); },
        });
      };
      window.BUX.ACTIONS['recon:ignore'] = (el) => confirmDialog({
        title: 'Qatorni e’tiborsiz qoldirish', message: 'Qator ro‘yxatdan chiqariladi (jurnalga ta’sir qilmaydi).',
        confirmLabel: 'E’tiborsiz qoldirish', extraField: { label: 'Sabab' },
        onConfirm: async (reason) => { await api(`/api/reconciliation/rows/${el.dataset.id}/ignore`, { method: 'POST', body: { reason } }); toast('Qator e’tiborsiz qoldirildi.', 'success'); window.BUX.renderPage(); },
      });
      if (VIEWS.banking._accounts && VIEWS.banking._accounts.length === 0) { /* bo'sh */ }
    },
  };

  // ═════════════════════════════════ Hujjatlar ═════════════════════════════
  VIEWS.documents = {
    async load(params) {
      const data = await api('/api/documents', { query: { ...rangeQs(), type: params.type, search: params.q, status: params.status, page: num(params.page) || 1, page_size: 25 } });
      const items = data.items || [];
      const docTypes = (S.meta && S.meta.document_types) || {};
      return `
      ${card({
        title: 'Hujjat markazi', subtitle: `${rangeLabel()} · hujjatlar tranzaksiya, hisob-faktura, kontragent va mahsulot bilan bog‘lanadi`,
        actions: `<div class="row-actions">
          <div class="filters" style="margin:0">
            <input id="doc-search" placeholder="Qidirish…" value="${esc(params.q || '')}">
            <select id="doc-type"><option value="">Barcha turlar</option>${Object.entries(docTypes).map(([k, v]) => `<option value="${esc(k)}" ${params.type === k ? 'selected' : ''}>${esc(v.label || v)}</option>`).join('')}</select>
            <select id="doc-status"><option value="">Barcha holatlar</option>
              <option value="pending_review" ${params.status === 'pending_review' ? 'selected' : ''}>Ko‘rib chiqilishi kerak</option>
              <option value="approved" ${params.status === 'approved' ? 'selected' : ''}>Tasdiqlangan</option>
            </select>
          </div>
          ${can('documents.manage') ? `<button class="primary" data-action="doc:upload">⇧ Hujjat yuklash</button>` : ''}
        </div>`,
        body: table(['Fayl', 'Turi', 'Hajm', 'Yuklangan', 'AI tahlili', 'Holat', ''], items.map(d => [
          `<div><b>${esc(d.name)}</b>${d.party_name ? `<br><small>${esc(d.party_name)}</small>` : ''}</div>`,
          esc((d.type_label || (docTypes[d.type] && docTypes[d.type].label) || d.type || '—')),
          d.size ? `${(num(d.size) / 1024).toFixed(0)} KB` : '—',
          shortDate(d.created_at ? d.created_at.slice(0, 10) : ''),
          d.extraction ? chip(d.extraction.status === 'approved' ? 'Tasdiqlangan' : 'Tekshirish kerak', d.extraction.status === 'approved' ? 'ok' : 'warn') : chip('Tahlil qilinmagan', 'neutral'),
          chip(d.status === 'approved' ? 'Tasdiqlangan' : 'Faol', 'info'),
          `<div class="row-actions">
            <button class="ghost small" data-action="doc:view" data-id="${esc(d.id)}">Ochish</button>
            <a class="ghost small" href="/api/documents/${esc(d.id)}/file" target="_blank" rel="noopener">Fayl</a>
            ${can('documents.manage') ? `<button class="ghost small" data-action="doc:extract" data-id="${esc(d.id)}">AI tahlil</button>` : ''}
            ${can('documents.manage') ? `<button class="ghost small danger" data-action="doc:delete" data-id="${esc(d.id)}">O‘chirish</button>` : ''}
          </div>`,
        ]), { empty: emptyState({ icon: '⌸', title: 'Hujjat yo‘q', text: 'Shartnoma, hisob-faktura, akt yoki bank ko‘chirmasini yuklang. Tizim ma’lumotlarni ajratib, tasdiqlashingizni so‘raydi.', cta: { label: '⇧ Hujjat yuklash', action: 'doc:upload' } }) }),
      })}
      <div class="notice subtle"><b>Muhim:</b> hujjatdan ajratilgan ma’lumotlar («AI extracted information») avtomatik yozuv yaratmaydi — siz tasdiqlaganingizdan keyingina buxgalteriya yozuvi kiritiladi.</div>`;
    },
    async mount() {
      const push = (patch) => go('documents', { ...S.params, ...patch, page: 1 });
      let timer = null;
      const search = document.getElementById('doc-search');
      if (search) search.addEventListener('input', (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => push({ q: v }), 400); });
      const bind = (id, key) => { const el = document.getElementById(id); if (el) el.addEventListener('change', (e) => push({ [key]: e.target.value })); };
      bind('doc-type', 'type'); bind('doc-status', 'status');
      window.BUX.ACTIONS['doc:upload'] = () => openForm({
        title: 'Hujjat yuklash', description: 'Maksimal hajm 15 MB. Ruxsat etilgan: PDF, rasm, Excel, Word, matn.',
        fields: [
          { name: 'file', label: 'Fayl', type: 'file', required: true },
          { name: 'type', label: 'Hujjat turi', type: 'select', options: Object.entries((S.meta && S.meta.document_types) || {}).map(([k, v]) => ({ value: k, label: v.label || v })) },
          { name: 'note', label: 'Izoh', placeholder: 'Masalan: yetkazib beruvchi hisobi' },
          { name: 'tags', label: 'Teglar (vergul bilan)', placeholder: 'sentabr, ijara' },
        ], submitLabel: 'Yuklash',
        onSubmit: async (data, { files }) => {
          const file = files.get('file');
          if (!file || !file.size) throw ApiError('Faylni tanlang.');
          const form = new FormData();
          form.append('file', file);
          form.append('type', data.type || 'other');
          if (data.note) form.append('note', data.note);
          if (data.tags) form.append('tags', data.tags);
          await api('/api/documents', { method: 'POST', form });
          toast('Hujjat yuklandi.', 'success');
          window.BUX.renderPage();
        },
      });
      window.BUX.ACTIONS['doc:extract'] = async (el) => {
        const res = await api(`/api/documents/${el.dataset.id}/extract`, { method: 'POST' });
        if (!res.available) toast('Bu fayldan matn ajratib bo‘lmadi (skanerlangan rasm uchun OCR mavjud emas).', 'warn', 8000);
        else toast('Ma’lumotlar ajratildi — tekshirib tasdiqlang.', 'success');
        go('documents', { ...S.params, id: el.dataset.id });
      };
      window.BUX.ACTIONS['doc:delete'] = (el) => confirmDialog({
        title: 'Hujjatni o‘chirish', message: 'Hujjat arxivlanadi (soft delete). Buxgalteriya yozuvlari o‘zgarmaydi.',
        confirmLabel: 'O‘chirish', danger: true,
        onConfirm: async () => { await api(`/api/documents/${el.dataset.id}`, { method: 'DELETE' }); toast('Hujjat o‘chirildi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['doc:view'] = async (el) => {
        const doc = await api(`/api/documents/${el.dataset.id}`);
        const ex = doc.extraction;
        openForm({
          title: doc.name, description: `${fmtDate(doc.created_at ? doc.created_at.slice(0, 10) : '')} · ${doc.type} · ${doc.size ? (num(doc.size) / 1024).toFixed(0) + ' KB' : ''}`,
          wide: true, fields: [{ name: 'x', label: 'Fayl', value: doc.name, readonly: true }],
          extraHtml: `
            ${ex && ex.fields ? `<div class="notice"><b>✦ AI extracted information</b> (tasdiqlashdan oldin tekshiring)
              ${statRows([
                ['Yetkazib beruvchi', esc(ex.fields.supplier_name || ex.fields.customer_name || '—')],
                ['STIR', esc(ex.fields.inn || '—')],
                ['Hujjat raqami', esc(ex.fields.doc_no || '—')],
                ['Sana', esc(ex.fields.date || '—')],
                ['Jami summa', ex.fields.total ? money(ex.fields.total) : '—'],
                ['QQS', ex.fields.tax ? money(ex.fields.tax) : '—'],
                ['Ishonch', esc(ex.fields.confidence || '—')],
              ])}
              <div class="row-actions">
                ${ex.status === 'pending_review' && can('documents.manage') ? `<button class="primary small" data-action="doc:approve" data-id="${esc(doc.id)}">Tasdiqlash va yozuv yaratish</button>` : ''}
                ${ex.raw_text ? `<button class="ghost small" data-action="doc:raw" data-id="${esc(doc.id)}">Matnni ko‘rish</button>` : ''}
              </div></div>` : `<div class="notice subtle">Bu hujjat uchun AI tahlili hali bajarilmagan. «AI tahlil» tugmasini bosing.</div>`}
            ${definitionList([
              ['Bog‘langan kontragent', esc(doc.party_name || (doc.linked && doc.linked.party ? doc.linked.party.name : '—'))],
              ['Bog‘langan hisob-faktura', esc(doc.linked && doc.linked.invoice ? doc.linked.invoice.no : '—')],
              ['Bog‘langan yozuv', esc(doc.linked && doc.linked.entry ? doc.linked.entry.no : '—')],
              ['Teglar', esc((doc.tags || []).join(', ') || '—')],
            ])}`,
          submitLabel: 'Yopish', onSubmit: async () => {},
        });
      };
      window.BUX.ACTIONS['doc:raw'] = async (el) => {
        const doc = await api(`/api/documents/${el.dataset.id}`);
        openForm({
          title: 'Ajratilgan matn', wide: true,
          fields: [{ name: 'text', label: 'Matn', type: 'textarea', rows: 14, value: (doc.extraction && doc.extraction.raw_text) || '', readonly: true }],
          submitLabel: 'Yopish', onSubmit: async () => {},
        });
      };
      window.BUX.ACTIONS['doc:approve'] = async (el) => {
        const doc = await api(`/api/documents/${el.dataset.id}`);
        const accountsRes = await api('/api/accounts').catch(() => ({ items: [] }));
        const moneyAccounts = (accountsRes.items || accountsRes.accounts || []).filter(a => a.is_cash || a.is_bank);
        const f = (doc.extraction && doc.extraction.fields) || {};
        openForm({
          title: 'Ajratilgan ma’lumotni tasdiqlash',
          description: 'Tasdiqlaganingizdan so‘ng xarajat (yoki xarid hisobi) yozuvi yaratiladi. Raqamlarni tekshirib chiqing.',
          fields: [
            { name: 'action', label: 'Amal', type: 'select', options: [{ value: 'create_expense', label: 'Xarajat yozuvi yaratish' }, { value: 'link_only', label: 'Faqat bog‘lash (yozuv yaratsiz)' }] },
            { name: 'date', label: 'Sana', type: 'date', value: (f.date && /^\d{4}-\d{2}-\d{2}$/.test(f.date)) ? f.date : new Date().toISOString().slice(0, 10) },
            { name: 'amount', label: 'Summa', type: 'number', value: num(f.total), help: 'Ajratilgan summa — kerak bo‘lsa tuzatib yozing' },
            { name: 'category', label: 'Kategoriya', type: 'select', options: ((S.meta && S.meta.categories && S.meta.categories.expense) || []).map(c => ({ value: c.key, label: c.label })) },
            { name: 'account', label: 'Kassa/bank hisobi', type: 'select', options: moneyAccounts.map(a => ({ value: a.code, label: `${a.code} — ${a.name}` })) },
          ],
          submitLabel: 'Tasdiqlash va yozuv yaratish',
          onSubmit: async (data) => {
            await api(`/api/documents/${el.dataset.id}/approve-extraction`, { method: 'POST', body: { action: data.action, account: data.account, fields: { date: data.date, amount: num(data.amount), category: data.category, account: data.account } } });
            toast('Tasdiqlandi va buxgalteriya yozuvi yaratildi.', 'success');
            window.BUX.renderPage();
          },
        });
      };
    },
  };

  // ═══════════════════════════════ Xato Radar ══════════════════════════════
  VIEWS.radar = {
    async load(params) {
      const data = await api('/api/radar', { query: { ...rangeQs(), severity: params.severity, category: params.category, search: params.q, status: params.status || 'open' } });
      const summary = data.summary || {};
      const issues = data.issues || [];
      const cats = (S.meta && S.meta.radar_categories) || {};
      return `
      <section class="metrics">
        ${metricCard({ label: 'Jami topilmalar', value: num(summary.total), icon: '◬', tone: 'purple' })}
        ${metricCard({ label: 'Kritik', value: num(summary.critical), icon: '⚠', tone: 'orange' })}
        ${metricCard({ label: 'Yuqori jiddiylik', value: num(summary.high), icon: '!', tone: 'orange' })}
        ${metricCard({ label: 'Moliyaviy ta’sir', value: money(summary.financial_impact), icon: '◈', tone: 'blue', hint: 'Hisoblangan xatarlar yig‘indisi' })}
      </section>
      ${card({
        title: 'Xato Radar', subtitle: `${rangeLabel()} · skanerlandi ${summary.scanned_at ? timeAgo(summary.scanned_at) : '—'}`,
        actions: `<div class="row-actions">
          <div class="filters" style="margin:0">
            <input id="radar-search" placeholder="Qidirish…" value="${esc(params.q || '')}">
            <select id="radar-sev"><option value="">Barcha jiddiylik</option>${['critical', 'high', 'medium', 'low'].map(s => `<option value="${s}" ${params.severity === s ? 'selected' : ''}>${{ critical: 'Kritik', high: 'Yuqori', medium: 'O‘rta', low: 'Past' }[s]}</option>`).join('')}</select>
            <select id="radar-cat"><option value="">Barcha toifalar</option>${Object.entries(cats).map(([k, v]) => `<option value="${k}" ${params.category === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
          </div>
          <button class="primary" data-action="radar:scan">⟳ Qayta skanerlash</button>
        </div>`,
        body: issues.length ? issues.map(i => `
          <div class="issue-row">
            <span class="sev-bar ${severityTone(i.severity)}"></span>
            <div class="issue-body">
              <div class="issue-head">
                <b>${esc(i.title)}</b>
                ${chip(i.severity_label || i.severity, severityTone(i.severity))}
                ${chip(`Ishonch: ${num(i.confidence)}% (${i.confidence_label || ''})`, 'neutral')}
                ${chip(cats[i.category] || i.category, 'neutral')}
                ${i.impact ? chip(`Ta’sir: ${money(i.impact)}`, 'info') : ''}
              </div>
              <p><b>Nima bo‘ldi:</b> ${esc(i.what)}</p>
              <p><b>Nega shunday:</b> ${esc(i.why)}</p>
              ${i.impact_note ? `<p><b>Moliyaviy ta’sir:</b> ${esc(i.impact_note)}</p>` : ''}
              <p><b>Qanday tuzatish:</b> ${esc(i.recommendation)}</p>
              <div class="row-actions">
                <button class="ghost small" data-action="radar:detail" data-id="${esc(i.id)}">Batafsil</button>
                <button class="primary small" data-action="radar:fix" data-id="${esc(i.id)}">${esc(i.fix ? i.fix.label : 'Tuzatish')}</button>
                <button class="ghost small" data-action="radar:ignore" data-id="${esc(i.id)}">E’tiborsiz (30 kun)</button>
                <button class="ghost small" data-action="radar:resolve" data-id="${esc(i.id)}">Hal qilindi</button>
              </div>
            </div>
          </div>`).join('')
          : emptyState({ icon: '✓', title: 'Xatolar aniqlanmadi', text: 'Tizim dublikat, noto‘g‘ri tasniflash, muddati o‘tgan hisoblar, ombor va soliq bo‘yicha anomaliyalarni tekshirdi — muammo topilmadi.', hint: summary.no_data ? 'Kompaniyada hali ma’lumot yo‘q.' : `Tekshirilgan yozuvlar: ${rangeLabel()}` }),
      })}
      ${(summary.by_category || []).length ? card({
        title: 'Toifalar bo‘yicha', subtitle: 'Qaysi sohada ko‘proq muammo bor',
        body: table(['Toifa', 'Topilmalar', 'Yuqori jiddiylik', 'Moliyaviy ta’sir'], summary.by_category.map(c => [
          esc(c.label || c.category), num(c.count), num(c.high), money(c.impact),
        ])),
      }) : ''}
      ${(data.ignored || []).length ? card({
        title: 'E’tiborsiz qoldirilganlar', subtitle: 'Belgilangan muddatgacha ko‘rsatilmaydi',
        body: table(['Topilma', 'Muddat', 'Sabab', 'Ta’sir'], (data.ignored || []).map(i => [
          esc(i.title), i.ignored_until ? shortDate(i.ignored_until.slice(0, 10)) : '—', esc(i.ignored_reason || '—'), money(i.impact),
        ])),
      }) : ''}`;
    },
    async mount() {
      const push = (patch) => go('radar', { ...S.params, ...patch });
      let timer = null;
      const search = document.getElementById('radar-search');
      if (search) search.addEventListener('input', (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => push({ q: v }), 400); });
      const bind = (id, key) => { const el = document.getElementById(id); if (el) el.addEventListener('change', (e) => push({ [key]: e.target.value })); };
      bind('radar-sev', 'severity'); bind('radar-cat', 'category');
      window.BUX.ACTIONS['radar:scan'] = async () => {
        await api('/api/radar/scan', { method: 'POST', body: rangeQs() });
        toast('Skanerlash yakunlandi.', 'success');
        window.BUX.renderPage();
      };
      window.BUX.ACTIONS['radar:detail'] = async (el) => {
        const i = await api(`/api/radar/${encodeURIComponent(el.dataset.id)}`);
        openForm({
          title: i.title, description: `${i.severity_label || i.severity} · ishonch ${num(i.confidence)}% (${i.confidence_label || ''})`,
          wide: true, fields: [{ name: 'x', label: 'Topilma', value: i.code, readonly: true }],
          extraHtml: `${statRows([
            ['Kategoriya', esc(i.category_label || i.category)],
            ['Moliyaviy ta’sir', money(i.impact)],
            ['Aniqlangan', `${esc(shortDate((i.detected_at || '').slice(0, 10)))} (${num(i.seen_count)} marta)`],
          ])}
          <div class="notice"><b>Nima bo‘ldi:</b> ${esc(i.what)}<br><b>Nega:</b> ${esc(i.why)}<br><b>Ta’sir:</b> ${esc(i.impact_note || '')}<br><b>Tavsiya:</b> ${esc(i.recommendation)}</div>
          ${table(['Dalil', 'Qiymat', 'Izoh'], (i.evidence || []).map(e => [esc(e.label), esc(e.value), esc(e.hint || '')]))}
          <div class="row-actions"><button class="primary small" data-action="radar:fix" data-id="${esc(i.id)}">${esc(i.fix ? i.fix.label : 'Tuzatish')}</button></div>`,
          submitLabel: 'Yopish', onSubmit: async () => {},
        });
      };
      window.BUX.ACTIONS['radar:fix'] = async (el) => {
        const preview = await api(`/api/radar/${encodeURIComponent(el.dataset.id)}/fix`, { method: 'POST', body: {} });
        if (preview.navigation || (preview.fix && (preview.fix.type === 'review' || String(preview.fix.type).startsWith('open_')))) {
          const link = preview.link || (preview.fix && preview.fix.params);
          if (link && link.page) { go(link.page, link.params || {}); return; }
        }
        confirmDialog({
          title: 'Tuzatishni qo‘llash',
          message: preview.message || 'Amalni bajarish uchun tasdiqlash kerak.',
          note: (preview.what_will_change || []).join(' · '),
          confirmLabel: 'Tasdiqlash va bajarish',
          onConfirm: async () => {
            const res = await api(`/api/radar/${encodeURIComponent(el.dataset.id)}/fix`, { method: 'POST', body: { confirm: true } });
            if (res.approval_required) toast('So‘rov tasdiqlash markaziga yuborildi (direktor tasdiqlashi kerak).', 'warn', 8000);
            else if (res.executed) toast(res.message || 'Tuzatish bajarildi.', 'success');
            else toast(res.message || 'Amal bajarildi.', 'info');
            window.BUX.refreshBadges();
            window.BUX.renderPage();
          },
        });
      };
      window.BUX.ACTIONS['radar:ignore'] = (el) => openForm({
        title: 'E’tiborsiz qoldirish', fields: [
          { name: 'reason', label: 'Sabab', required: true, placeholder: 'Masalan: bank komissiyasi, xato emas' },
          { name: 'days', label: 'Necha kun ko‘rsatilmasin', type: 'number', value: 30, min: 1 },
        ], submitLabel: 'E’tiborsiz qoldirish',
        onSubmit: async (data) => { await api(`/api/radar/${encodeURIComponent(el.dataset.id)}/ignore`, { method: 'POST', body: data }); toast('Topilma e’tiborsiz qoldirildi.', 'success'); window.BUX.renderPage(); },
      });
      window.BUX.ACTIONS['radar:resolve'] = (el) => openForm({
        title: 'Topilmani hal qilindi deb belgilash', fields: [{ name: 'note', label: 'Izoh', placeholder: 'Nima qilindi?' }],
        submitLabel: 'Belgilash',
        onSubmit: async (data) => { await api(`/api/radar/${encodeURIComponent(el.dataset.id)}/resolve`, { method: 'POST', body: data }); toast('Topilma hal qilindi.', 'success'); window.BUX.renderPage(); },
      });
    },
  };

  // ════════════════════════════ Mahsulotlar / ombor ════════════════════════
  VIEWS.inventory = {
    async load(params) {
      const data = await api('/api/products', { query: { search: params.q, category: params.category, low_stock: params.low === '1' ? '1' : undefined } });
      const items = data.items || [];
      const v = data.valuation || {};
      const recon = await api('/api/inventory/valuation').catch(() => null);
      return `
      <section class="metrics">
        ${metricCard({ label: 'Ombor qiymati', value: money(v.total_value), icon: '▣', tone: 'purple', hint: `${num(v.total_skus)} ta pozitsiya` })}
        ${metricCard({ label: 'Kam qolgan mahsulotlar', value: num((v.low_stock || []).length), icon: '⚠', tone: 'orange' })}
        ${metricCard({ label: 'Manfiy qoldiq', value: num((v.negative_stock || []).length), icon: '!', tone: 'orange' })}
        ${metricCard({ label: 'Jurnal bilan moslik', value: recon && recon.consistent ? 'Mos ✓' : 'Farq bor', icon: '≡', tone: 'green-icon', hint: recon ? `Jurnal: ${money(recon.ledger_value)}` : '' })}
      </section>
      ${card({
        title: 'Mahsulotlar va qoldiqlar', subtitle: 'O‘rtacha tortilgan tannarx usulida avtomatik baholanadi',
        actions: `<div class="row-actions">
          <div class="filters" style="margin:0">
            <input id="prod-search" placeholder="Nomi, SKU yoki shtrix-kod…" value="${esc(params.q || '')}">
            <select id="prod-cat"><option value="">Barcha kategoriyalar</option>${(data.categories || []).map(c => `<option value="${esc(c)}" ${params.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
            <label class="inline-check"><input type="checkbox" id="prod-low" ${params.low === '1' ? 'checked' : ''}> Faqat kam qolganlar</label>
          </div>
          ${can('inventory.manage') ? `<button class="primary" data-action="product:new">＋ Mahsulot</button>` : ''}
        </div>`,
        body: table(['Mahsulot', 'SKU', 'Kategoriya', 'Qoldiq', 'Tannarx', 'Sotuv narxi', 'Qiymat', 'Holat', ''], items.map(p => [
          `<b>${esc(p.name)}</b>${p.barcode ? `<br><small>${esc(p.barcode)}</small>` : ''}`,
          esc(p.sku || '—'), esc(p.category || '—'),
          p.is_service ? chip('xizmat', 'info') : `${num(p.stock)} ${esc(p.unit || '')}`,
          p.avg_cost ? money(p.avg_cost) : '—', p.sale_price ? money(p.sale_price) : '—',
          money(p.stock_value),
          p.is_service ? '—' : (p.is_negative ? chip('Manfiy', 'danger') : p.is_low ? chip('Kam qoldi', 'warn') : chip('Yetarli', 'ok')),
          `<div class="row-actions">
            <button class="ghost small" data-action="product:view" data-id="${esc(p.id)}">Karta</button>
            ${can('inventory.manage') && !p.is_service ? `<button class="ghost small" data-action="stock:in" data-id="${esc(p.id)}">Kirim</button>
            <button class="ghost small" data-action="stock:out" data-id="${esc(p.id)}">Chiqim</button>
            <button class="ghost small" data-action="stock:adjust" data-id="${esc(p.id)}">Inventarizatsiya</button>` : ''}
          </div>`,
        ]), { empty: emptyState({ icon: '▣', title: 'Mahsulot yo‘q', text: 'Mahsulot yoki xizmat qo‘shsangiz, sotuv va ombor harakatlari avtomatik baholanadi.', cta: { label: '＋ Mahsulot qo‘shish', action: 'product:new' } }) }),
      })}`;
    },
    async mount() {
      const push = (patch) => go('inventory', { ...S.params, ...patch });
      let timer = null;
      const search = document.getElementById('prod-search');
      if (search) search.addEventListener('input', (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => push({ q: v }), 400); });
      const cat = document.getElementById('prod-cat');
      if (cat) cat.addEventListener('change', (e) => push({ category: e.target.value }));
      const low = document.getElementById('prod-low');
      if (low) low.addEventListener('change', (e) => push({ low: e.target.checked ? '1' : '' }));
      window.BUX.ACTIONS['product:new'] = () => openForm({
        title: 'Yangi mahsulot yoki xizmat',
        fields: [
          { name: 'name', label: 'Nomi', required: true },
          { name: 'sku', label: 'SKU (kod)', placeholder: 'Masalan: MT-1010' },
          { name: 'barcode', label: 'Shtrix-kod' },
          { name: 'category', label: 'Kategoriya', placeholder: 'Masalan: Xom ashyo' },
          { name: 'unit', label: 'O‘lchov birligi', type: 'select', options: ((S.meta && S.meta.units) || ['dona']).map(u => ({ value: u, label: u })) },
          { name: 'purchase_price', label: 'Tannarx (kelish narxi)', type: 'number', min: 0, value: 0 },
          { name: 'sale_price', label: 'Sotuv narxi', type: 'number', min: 0, value: 0 },
          { name: 'min_stock', label: 'Minimal qoldiq (ogohlantirish)', type: 'number', min: 0, value: 0 },
          { name: 'warehouse', label: 'Ombor', value: 'Asosiy ombor' },
          { name: 'is_service', label: 'Bu xizmat (ombor yuritilmaydi)', type: 'checkbox', value: false },
          { name: 'opening_stock', label: 'Boshlang‘ich qoldiq (kirim sifatida yoziladi)', type: 'number', min: 0, value: 0 },
        ], wide: true, submitLabel: 'Saqlash',
        onSubmit: async (data) => {
          await api('/api/products', { method: 'POST', body: { ...data, opening_account: undefined } });
          toast('Mahsulot qo‘shildi.', 'success');
          window.BUX.renderPage();
        },
      });
      window.BUX.ACTIONS['product:view'] = async (el) => {
        const data = await api(`/api/products/${el.dataset.id}/moves`, { query: rangeQs() });
        const p = data.product || {};
        const ev = data.evaluation || {};
        openForm({
          title: `${p.name} · ${p.sku || ''}`,
          description: `${num(ev.qty)} ${p.unit || ''} · tannarx ${money(ev.avg_cost)} · qiymat ${money(ev.value)}`,
          wide: true, fields: [{ name: 'x', label: 'Holat', value: p.is_low ? 'Kam qoldi' : 'Yetarli', readonly: true }],
          extraHtml: `${table(['Sana', 'Turi', 'Miqdor', 'Birlik narx', 'Qiymat o‘zgarishi', 'Qoldiq'], (data.moves || []).map(m => [
            shortDate(m.date), esc((S.meta && S.meta.stock_move_types && S.meta.stock_move_types[m.type] && S.meta.stock_move_types[m.type].label) || m.type),
            `${m.direction === 'out' ? '−' : '+'}${num(m.qty)}`, money(m.unit_cost), money(m.value_delta), `${num(m.balance_qty)} · ${money(m.balance_value)}`,
          ]), { empty: emptyState({ title: 'Harakat yo‘q', text: 'Bu davrda ombor harakati topilmadi.' }) })}`,
          submitLabel: 'Yopish', onSubmit: async () => {},
        });
      };
      const stockForm = (type) => (el) => {
        const labels = { in: 'Omborga kirim', out: 'Ombordan chiqim', adjust: 'Inventarizatsiya (haqiqiy qoldiq)' };
        openForm({
          title: labels[type], fields: [
            { name: 'date', label: 'Sana', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
            ...(type === 'adjust'
              ? [{ name: 'actual_qty', label: 'Haqiqiy qoldiq', type: 'number', required: true, min: 0 }]
              : [{ name: 'qty', label: 'Miqdor', type: 'number', required: true, min: 1 }]),
            ...(type === 'in' ? [{ name: 'unit_cost', label: 'Birlik narxi', type: 'number', min: 1, required: true }] : []),
            { name: 'memo', label: 'Izoh', placeholder: 'Masalan: yetkazib beruvchidan qabul qilindi' },
          ], submitLabel: 'Saqlash',
          onSubmit: async (data) => {
            const body = { ...data, product_id: el.dataset.id };
            const url = type === 'in' ? '/api/inventory/receive' : type === 'out' ? '/api/inventory/issue' : '/api/inventory/adjust';
            await api(url, { method: 'POST', body });
            toast('Ombor harakati saqlandi va jurnalga bog‘landi.', 'success');
            window.BUX.renderPage();
          },
        });
      };
      window.BUX.ACTIONS['stock:in'] = stockForm('in');
      window.BUX.ACTIONS['stock:out'] = stockForm('out');
      window.BUX.ACTIONS['stock:adjust'] = stockForm('adjust');
    },
  };

  // ═══════════════════════════ Kontragentlar (CRM) ═════════════════════════
  VIEWS.parties = {
    async load(params) {
      const [data, aging] = await Promise.all([
        api('/api/parties', { query: { kind: params.kind, search: params.q, status: params.status } }),
        api('/api/parties-aging').catch(() => null),
      ]);
      const items = data.items || [];
      return `
      ${card({
        title: 'Kontragentlar (CRM)', subtitle: 'Har bir mijoz/yetkazib beruvchi bo‘yicha to‘liq moliyaviy profil',
        actions: `<div class="row-actions">
          <div class="filters" style="margin:0">
            <input id="party-search" placeholder="Nomi, STIR yoki telefon…" value="${esc(params.q || '')}">
            <select id="party-kind">
              <option value="">Barcha turlar</option>
              <option value="customer" ${params.kind === 'customer' ? 'selected' : ''}>Mijozlar</option>
              <option value="supplier" ${params.kind === 'supplier' ? 'selected' : ''}>Yetkazib beruvchilar</option>
              <option value="both" ${params.kind === 'both' ? 'selected' : ''}>Ikkalasi</option>
            </select>
          </div>
          ${can('parties.manage') ? `<button class="primary" data-action="party:new">＋ Kontragent</button>` : ''}
        </div>`,
        body: table(['Nomi', 'Turi', 'STIR', 'Telefon', 'Debitorlik', 'Kreditorlik', 'To‘lov muddati', ''], items.map(p => [
          `<b>${esc(p.name)}</b>`, { customer: 'Mijoz', supplier: 'Yetkazib beruvchi', both: 'Ikkalasi' }[p.kind] || p.kind,
          esc(p.inn || '—'), esc(p.phone || '—'),
          p.receivable ? money(p.receivable) : '—', p.payable ? money(p.payable) : '—',
          p.payment_terms_days != null ? `${num(p.payment_terms_days)} kun` : '—',
          `<div class="row-actions"><button class="ghost small" data-action="party:view" data-id="${esc(p.id)}">Profil</button></div>`,
        ]), { empty: emptyState({ icon: '♙', title: 'Kontragent yo‘q', text: 'Mijoz yoki yetkazib beruvchi qo‘shsangiz, ular bo‘yicha balans, aging va xarid/sotuv tarixi avtomatik yig‘iladi.', cta: { label: '＋ Kontragent qo‘shish', action: 'party:new' } }) }),
      })}
      ${aging ? card({
        title: 'Aging (muddat bo‘yicha taqsimot)', subtitle: 'Debitorlik va kreditorlik uchun 0–30 / 31–60 / 61–90 / 90+',
        body: table(['Kontragent', 'Turi', 'Muddati kelmagan', '0–30', '31–60', '61–90', '90+', 'Jami'], [
          ...((aging.receivables && aging.receivables.rows) || []).map(r => [
            `<b>${esc(r.name)}</b>`, chip('Debitorlik', 'info'), money(r.buckets && r.buckets.not_due), money(r.buckets && r.buckets['0-30']),
            money(r.buckets && r.buckets['31-60']), money(r.buckets && r.buckets['61-90']), money(r.buckets && r.buckets['90+']), `<b>${money(r.total)}</b>`,
          ]),
          ...((aging.payables && aging.payables.rows) || []).map(r => [
            `<b>${esc(r.name)}</b>`, chip('Kreditorlik', 'warn'), money(r.buckets && r.buckets.not_due), money(r.buckets && r.buckets['0-30']),
            money(r.buckets && r.buckets['31-60']), money(r.buckets && r.buckets['61-90']), money(r.buckets && r.buckets['90+']), `<b>${money(r.total)}</b>`,
          ]),
        ], { empty: `<p class="empty-hint">Aging uchun ochiq hisob-fakturalar yo‘q.</p>` }),
      }) : ''}`;
    },
    async mount() {
      const push = (patch) => go('parties', { ...S.params, ...patch });
      let timer = null;
      const search = document.getElementById('party-search');
      if (search) search.addEventListener('input', (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => push({ q: v }), 400); });
      const kind = document.getElementById('party-kind');
      if (kind) kind.addEventListener('change', (e) => push({ kind: e.target.value }));
      window.BUX.ACTIONS['party:new'] = () => openPartyForm();
    },
  };

  function openPartyForm(p = {}) {
    openForm({
      title: p.id ? 'Kontragentni tahrirlash' : 'Yangi kontragent',
      description: 'STIR (INN), MFO va bank rekvizitlari hisob-fakturalarda ishlatiladi.',
      wide: true,
      fields: [
        { name: 'name', label: 'Nomi', required: true, value: p.name || '' },
        { name: 'kind', label: 'Turi', type: 'select', options: [{ value: 'customer', label: 'Mijoz' }, { value: 'supplier', label: 'Yetkazib beruvchi' }, { value: 'both', label: 'Ikkalasi' }], value: p.kind || 'customer' },
        { name: 'inn', label: 'STIR (INN, 9 xonali)', value: p.inn || '', placeholder: '301234567' },
        { name: 'phone', label: 'Telefon', value: p.phone || '', placeholder: '+998 90 123 45 67' },
        { name: 'email', label: 'Email', value: p.email || '' },
        { name: 'address', label: 'Manzil', value: p.address || '' },
        { name: 'contact_person', label: 'Aloqa shaxsi', value: p.contact_person || '' },
        { name: 'payment_terms_days', label: 'To‘lov muddati (kun)', type: 'number', min: 0, value: p.payment_terms_days != null ? p.payment_terms_days : 14 },
        { name: 'credit_limit', label: 'Kredit limiti', type: 'number', min: 0, value: p.credit_limit || 0 },
        { name: 'vat_payer', label: 'QQS to‘lovchisi', type: 'checkbox', value: p.vat_payer !== false },
        { name: 'bank_name', label: 'Bank nomi', value: p.bank_name || '' },
        { name: 'mfo', label: 'MFO', value: p.mfo || '' },
        { name: 'bank_account', label: 'Hisob raqami', value: p.bank_account || '' },
        { name: 'note', label: 'Izoh', type: 'textarea', rows: 2, value: p.note || '' },
      ],
      submitLabel: p.id ? 'Saqlash' : 'Qo‘shish',
      onSubmit: async (data) => {
        if (p.id) await api(`/api/parties/${p.id}`, { method: 'PATCH', body: data });
        else await api('/api/parties', { method: 'POST', body: data });
        toast('Kontragent saqlandi.', 'success');
        window.BUX.renderPage();
      },
    });
  }

  async function openPartyProfile(id) {
    const data = await api(`/api/parties/${id}`);
    const p = data.party || data;
    const aging = data.aging || {};
    const totals = data.totals || {};
    openForm({
      title: p.name, description: `${p.kind === 'customer' ? 'Mijoz' : p.kind === 'supplier' ? 'Yetkazib beruvchi' : 'Mijoz va yetkazib beruvchi'}${p.inn ? ` · STIR ${p.inn}` : ''}`,
      wide: true, fields: [{ name: 'x', label: 'Balans', value: money((p.receivable || 0) - (p.payable || 0)), readonly: true }],
      extraHtml: `
        ${statRows([
          ['Debitorlik (bizga qarz)', money(p.receivable || totals.receivable)],
          ['Kreditorlik (biz qarzmiz)', money(p.payable || totals.payable)],
          ['Jami sotuv (davr)', money(totals.sales || 0)],
          ['Jami xarid (davr)', money(totals.purchases || 0)],
          ['To‘lov muddati', `${num(p.payment_terms_days || 0)} kun`],
          ['Kredit limiti', p.credit_limit ? money(p.credit_limit) : '—'],
          ['Xatar darajasi', (data.risk && (data.risk.label || data.risk.level)) ? esc(data.risk.label || data.risk.level) : '—'],
        ])}
        ${Object.keys(aging).length ? table(['Muddat', 'Summa', 'Hujjatlar'], Object.entries(aging).map(([k, v]) => [esc(k), money(v.amount != null ? v.amount : v), num(v.count)])) : ''}
        <div class="row-actions">
          ${can('parties.manage') ? `<button class="ghost small" data-action="party:edit" data-id="${esc(p.id)}">Tahrirlash</button>` : ''}
          <button class="ghost small" data-action="party:statement" data-id="${esc(p.id)}">Hisob-kitob akti (CSV)</button>
        </div>`,
      submitLabel: 'Yopish', onSubmit: async () => {},
    });
    window.BUX.ACTIONS['party:edit'] = () => openPartyForm(p);
    window.BUX.ACTIONS['party:statement'] = () => download(`/api/reports/general-ledger/export?party_id=${encodeURIComponent(p.id)}&from=${S.range.from}&to=${S.range.to}`, `akt-${p.name}.csv`);
  }

  // ══════════════════════════════ Hisobotlar ═══════════════════════════════
  VIEWS.reports = {
    async load(params) {
      const catalog = await api('/api/reports');
      const groups = {};
      (catalog.catalog || []).forEach(r => { (groups[r.group || 'Boshqa'] = groups[r.group || 'Boshqa'] || []).push(r); });
      const key = params.report;
      let reportHtml = '';
      if (key) {
        const report = await api(`/api/reports/${key}`, { query: { ...rangeQs(), account: params.account } });
        reportHtml = renderReport(report, key);
      }
      return `
      ${card({
        title: 'Hisobot markazi', subtitle: 'Bitta buxgalteriya dvigateli — har bir raqamdan yozuvgacha ochish mumkin (drill-down)',
        body: `<div class="report-grid">
          ${Object.entries(groups).map(([group, list]) => `
            <div class="report-group"><b>${esc(group)}</b>
              ${list.map(r => `<button class="report-btn ${params.report === r.key ? 'active' : ''}" data-action="report:open" data-key="${esc(r.key)}">${esc(r.title)}</button>`).join('')}
            </div>`).join('')}
        </div>`,
      })}
      ${key ? `<div class="card">
        <div class="card-head"><div><h2>${esc(params.report_title || 'Hisobot')}</h2><p>${esc(rangeLabel())} · barcha summalar jurnal bilan mos</p></div>
          <div class="row-actions">
            <button class="ghost" data-action="report:export" data-key="${esc(key)}">CSV yuklab olish</button>
            <button class="ghost" data-action="report:print">Chop etish</button>
          </div></div>
        ${reportHtml}
      </div>` : ''}`;
    },
    async mount() {
      window.BUX.ACTIONS['report:open'] = (el) => go('reports', { report: el.dataset.key });
      window.BUX.ACTIONS['report:export'] = (el) => download(`/api/reports/${el.dataset.key}/export?from=${S.range.from}&to=${S.range.to}`, `${el.dataset.key}-${S.range.from}.csv`);
      window.BUX.ACTIONS['report:print'] = () => window.print();
    },
  };

  function renderReport(report, key) {
    if (!report || !report.title) return `<p class="empty-hint">Hisobot ma’lumotlari mavjud emas.</p>`;
    const out = [];
    if (report.notes && report.notes.length) out.push(`<div class="notice subtle">${report.notes.map(esc).join(' · ')}</div>`);
    if (report.check) out.push(`<div class="notice ${report.check.balanced ? '' : 'warn'}">${esc(report.check.message || (report.check.balanced ? 'Muvozanat saqlangan.' : 'Muvozanat buzilgan!'))}</div>`);
    if (report.summary && typeof report.summary === 'object') {
      out.push(statRows(Object.entries(report.summary).filter(([k, v]) => typeof v !== 'object').map(([k, v]) => [labelize(k), typeof v === 'number' ? money(v) : esc(String(v))])));
    }
    if (report.totals && typeof report.totals === 'object') {
      out.push(statRows(Object.entries(report.totals).filter(([k, v]) => typeof v !== 'object' && v != null).map(([k, v]) => [labelize(k), typeof v === 'number' ? money(v) : esc(String(v))])));
    }
    // Asosiy jadvallar
    const tableKeys = ['rows', 'sections', 'accounts', 'items', 'lines'];
    for (const tk of tableKeys) {
      const rows = report[tk];
      if (!Array.isArray(rows) || !rows.length) continue;
      if (tk === 'sections') {
        out.push(rows.map(section => `<div class="report-section">
          <div class="report-section-head"><b>${esc(section.title || section.label || '')}</b><span>${money(section.total || 0)}</span></div>
          ${table(['Hisob', 'Nomi', 'Summa', 'Ulush'], (section.rows || []).map(r => [
            r.drill ? `<button class="link" data-link='${esc(JSON.stringify(r.drill))}' data-action="drill:open">${esc(r.code || '')}</button>` : esc(r.code || ''),
            esc(r.name || r.label || ''), money(r.amount != null ? r.amount : r.value), r.share != null ? `${num(r.share)}%` : '—',
          ]))}
        </div>`).join(''));
        continue;
      }
      const headers = Object.keys(rows[0]).filter(h => typeof rows[0][h] !== 'object' || h === 'drill').map(labelize);
      const cols = Object.keys(rows[0]).filter(h => typeof rows[0][h] !== 'object');
      out.push(table(cols.map(labelize), rows.slice(0, 400).map(r => cols.map(c => {
        const v = r[c];
        const numeric = typeof v === 'number';
        const text = numeric ? (/(margin|rate|share|pct|percent|kun|qty|count|son|days)/i.test(c) ? num(v) : money(v)) : esc(String(v == null ? '—' : v));
        if (r.drill && (c === 'code' || c === 'name' || c === 'amount' || c === 'label')) {
          return `<button class="link" data-link='${esc(JSON.stringify(r.drill))}' data-action="drill:open">${text}</button>`;
        }
        return text;
      }))));
    }
    if (!out.length) return emptyState({ title: 'Bu davr uchun ma’lumot yo‘q', text: 'Tanlangan davrda hisobot ma’lumotlari mavjud emas. Boshqa davrni tanlab ko‘ring.' });
    return out.join('');
  }
  function labelize(k) {
    const map = { netProfit: 'Sof foyda', totalExpense: 'Jami xarajat', grossProfit: 'Yalpi foyda', grossMargin: 'Yalpi marja %', netMargin: 'Sof marja %', revenue: 'Daromad', cost: 'Tannarx', cos: 'Sotuv tannarxi', opex: 'Operatsion xarajat', total: 'Jami', open: 'Ochiq qoldiq', paid: 'To‘langan', overdue: 'Muddati o‘tgan', count: 'Soni', code: 'Kod', name: 'Nomi', amount: 'Summa', share: 'Ulush %', balance: 'Qoldiq', debit: 'Debet', credit: 'Kredit', closing: 'Yakuniy qoldiq', opening: 'Boshlang‘ich qoldiq', movement: 'Harakat', type: 'Turi', limit: 'Limit' };
    return map[k] || String(k).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // ═══════════════════════════════ Pul oqimi ═══════════════════════════════
  VIEWS.cashflow = {
    async load() {
      const [statement, forecast, cash, health] = await Promise.all([
        api('/api/reports/cash_flow', { query: rangeQs() }),
        api('/api/ai/forecast', { query: { days: 30 } }).catch(() => null),
        api('/api/bank/accounts').catch(() => null),
        api('/api/ai/health', { query: rangeQs() }).catch(() => null),
      ]);
      const f = forecast || {};
      const totals = f.totals || {};
      const series = (f.series || []).map(s => ({ label: s.label || s.date, short: (s.date || '').slice(8), in: s.inflow, out: s.outflow }));
      return `
      <section class="metrics">
        ${metricCard({ label: 'Joriy kassa va bank', value: money(cash ? cash.cash_position.total : 0), icon: '◈', tone: 'blue' })}
        ${metricCard({ label: 'Davr sof oqimi', value: money(statement.net != null ? statement.net : (statement.totals && statement.totals.net)), icon: '⌁', tone: 'purple' })}
        ${metricCard({ label: '30 kunlik prognoz (yakuniy qoldiq)', value: f.available ? money(totals.closing) : '—', icon: '◔', tone: 'green-icon', hint: f.available ? `Minimal qoldiq: ${money(totals.min_balance)}` : 'Prognoz uchun ma’lumot yetarli emas' })}
        ${metricCard({ label: 'Xatar darajasi', value: f.available && f.risk ? (f.risk.label || f.risk.level || '—') : '—', icon: '⚠', tone: 'orange', hint: f.available ? `Ma’lumot sifati: ${f.data_quality}` : '' })}
      </section>
      <section class="grid-main">
        <div class="card">
          <div class="card-head"><div><h2>Pul oqimi tarkibi</h2><p>${esc(rangeLabel())} · operatsion, investitsion va moliyaviy oqimlar</p></div></div>
          ${statement.sections ? statement.sections.map(s => `
            <div class="report-section">
              <div class="report-section-head"><b>${esc(s.title || s.label || '')}</b><span>${money(s.total || 0)}</span></div>
              ${table(['Ko‘rsatkich', 'Summa'], (s.rows || []).map(r => [esc(r.label || r.name), money(r.amount != null ? r.amount : r.value)]))}
            </div>`).join('')
            : (Number.isFinite(num(statement.net)) ? statRows([['Sof oqim', money(statement.net)]]) : `<p class="empty-hint">Bu davr uchun pul oqimi ma’lumoti yo‘q.</p>`)}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Prognoz (30 kun)</h2><p>Joriy qoldiq + kutilayotgan kirim/chiqim asosida</p></div>
            <select id="forecast-days">
              <option value="7" ${f.days === 7 ? 'selected' : ''}>7 kun</option>
              <option value="30" ${f.days === 30 ? 'selected' : ''}>30 kun</option>
              <option value="60" ${f.days === 60 ? 'selected' : ''}>60 kun</option>
              <option value="90" ${f.days === 90 ? 'selected' : ''}>90 kun</option>
            </select></div>
          ${f.available ? `
            ${statRows([
              ['Joriy qoldiq', money(totals.opening)],
              ['Kutilayotgan kirim', money(totals.inflow)],
              ['Kutilayotgan chiqim', money(totals.outflow)],
              ['Yakuniy qoldiq (prognoz)', `<b>${money(totals.closing)}</b>`],
              ['Minimal qoldiq (prognoz)', money(totals.min_balance)],
            ])}
            <div class="notice"><b>Bu prognoz, fakt emas.</b> Farazlar:</div>
            ${statRows((f.assumptions || []).map(a => ['• ' + a, '']))}
            ${f.risk && f.risk.message ? `<div class="notice ${f.risk.level === 'high' ? 'warn' : ''}">${esc(f.risk.message)}</div>` : ''}
            <div class="answer-meta">Ma’lumot sifati: ${esc(f.data_quality)} · ishonch: ${esc(f.confidence_label || f.confidence || '—')}</div>`
            : `<p class="empty-hint">${esc(f.message || 'Prognoz uchun yetarli ma’lumot yo‘q.')} Kamida bir necha oylik real harakatlar kerak.</p>`}
        </div>
      </section>
      ${series.length ? card({ title: 'Kunlik prognoz oqimi', subtitle: 'Prognoz — bugungi ma’lumotlarga asoslangan taxmin', body: barsChart(series, { height: 140 }) }) : ''}
      ${health && health.available ? card({
        title: 'Pul oqimi barqarorligi', subtitle: 'Moliyaviy salomatlik hisobining bir qismi',
        body: statRows([['Salomatlik skori', `${num(health.score)}%`], ['Baholash', esc(health.rating || '')]])
          + statRows((health.components || []).map(c => [c.label, c.score == null ? 'Ma’lumot yo‘q' : `${Math.round(num(c.score))}%`, esc(c.reason || '')])),
      }) : ''}`;
    },
    async mount() {
      const sel = document.getElementById('forecast-days');
      if (sel) sel.addEventListener('change', async (e) => {
        toast('Prognoz davri yangilanmoqda…', 'info', 2000);
        S.params.forecastDays = e.target.value;
        const f = await api('/api/ai/forecast', { query: { days: e.target.value } });
        const host = sel.closest('.card');
        if (host) host.outerHTML = card({
          title: `Prognoz (${num(f.days)} kun)`, subtitle: 'Joriy qoldiq + kutilayotgan kirim/chiqim asosida',
          body: f.available ? statRows([
            ['Joriy qoldiq', money(f.totals.opening)],
            ['Kutilayotgan kirim', money(f.totals.inflow)],
            ['Kutilayotgan chiqim', money(f.totals.outflow)],
            ['Yakuniy qoldiq (prognoz)', `<b>${money(f.totals.closing)}</b>`],
            ['Minimal qoldiq (prognoz)', money(f.totals.min_balance)],
          ]) + statRows((f.assumptions || []).map(a => ['• ' + a, ''])) : `<p class="empty-hint">${esc(f.message || 'Prognoz uchun yetarli ma’lumot yo‘q.')}</p>`,
        });
        window.BUX.renderPage();
      });
    },
  };

  // ═══════ Sahifalararo umumiy amallar / eksport ═══════
  window.BUX_SHARED = window.BUX_SHARED || {};
  window.BUX_SHARED.openPartyProfile = openPartyProfile;
  window.BUX_SHARED.renderReport = renderReport;
  if (!window.BUX.ACTIONS['party:view']) window.BUX.ACTIONS['party:view'] = (el) => openPartyProfile(el.dataset.id);

  window.VIEWS = VIEWS;
})();
