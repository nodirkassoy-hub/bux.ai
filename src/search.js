'use strict';
/**
 * BUXAI — Global qidiruv: operatsiyalar, hisob-fakturalar, xarid hisoblari,
 * kontragentlar, mahsulotlar, hujjatlar, hisobotlar va bo'limlar.
 * Barcha natijalar kompaniya bilan cheklangan (multi-company izolyatsiya).
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');

const PAGES = [
  { key: 'dashboard', label: 'Bosh sahifa', group: 'Bo‘limlar', route: 'dashboard' },
  { key: 'my-work', label: 'Mening ishim', group: 'Bo‘limlar', route: 'my-work' },
  { key: 'radar', label: 'Xato Radar', group: 'Bo‘limlar', route: 'radar' },
  { key: 'transactions', label: 'Operatsiyalar', group: 'Bo‘limlar', route: 'transactions' },
  { key: 'invoices', label: 'Hisob-fakturalar', group: 'Bo‘limlar', route: 'invoices' },
  { key: 'receivables', label: 'Debitorlik', group: 'Bo‘limlar', route: 'receivables' },
  { key: 'bills', label: 'Xarid hisoblari', group: 'Bo‘limlar', route: 'bills' },
  { key: 'payables', label: 'Kreditorlik', group: 'Bo‘limlar', route: 'payables' },
  { key: 'parties', label: 'Mijozlar va yetkazib beruvchilar', group: 'Bo‘limlar', route: 'parties' },
  { key: 'products', label: 'Mahsulotlar va ombor', group: 'Bo‘limlar', route: 'inventory' },
  { key: 'reconciliation', label: 'Bank solishtirish', group: 'Bo‘limlar', route: 'reconciliation' },
  { key: 'bank', label: 'Kassa va bank', group: 'Bo‘limlar', route: 'bank' },
  { key: 'documents', label: 'Hujjatlar', group: 'Bo‘limlar', route: 'documents' },
  { key: 'reports', label: 'Hisobotlar', group: 'Bo‘limlar', route: 'reports' },
  { key: 'tax', label: 'Soliq markazi', group: 'Bo‘limlar', route: 'tax' },
  { key: 'cashflow', label: 'Pul oqimi va prognoz', group: 'Bo‘limlar', route: 'cashflow' },
  { key: 'advisor', label: 'AI Business Advisor', group: 'Bo‘limlar', route: 'advisor' },
  { key: 'ai', label: 'AI Buxgalter', group: 'Bo‘limlar', route: 'ai' },
  { key: 'approvals', label: 'Tasdiqlash markazi', group: 'Bo‘limlar', route: 'approvals' },
  { key: 'close', label: 'Davrni yopish', group: 'Bo‘limlar', route: 'close' },
  { key: 'audit', label: 'Audit jurnali', group: 'Bo‘limlar', route: 'audit' },
  { key: 'settings', label: 'Sozlamalar', group: 'Bo‘limlar', route: 'settings' },
];

function search(companyId, query, { limit = 6 } = {}) {
  const q = U.norm(query);
  if (!q || q.length < 2) return { query, groups: [], total: 0, hint: 'Kamida 2 belgi kiriting.' };
  const groups = [];
  const amountQuery = U.num(String(query).replace(/[^\d]/g, ''));

  // Bo'limlar
  const pages = PAGES.filter(p => U.norm(`${p.label} ${p.key}`).includes(q)).slice(0, limit);
  if (pages.length) groups.push({ type: 'page', label: 'Bo‘limlar', items: pages.map(p => ({ id: p.key, title: p.label, link: { page: p.route, params: {} } })) });

  // Operatsiyalar
  const txn = require('./transactions').list(companyId, { search: query, pageSize: limit * 2 });
  if (txn.items.length) {
    groups.push({
      type: 'transaction', label: 'Operatsiyalar',
      items: txn.items.slice(0, limit).map(t => ({
        id: t.id, title: `${t.no} — ${t.memo}`, subtitle: `${t.date} • ${t.counterparty_name}`, amount: t.total,
        link: { page: 'transactions', params: { id: t.id } },
      })),
    });
  }

  // Hisob-fakturalar
  const invoices = require('./invoices').list(companyId, { search: query, pageSize: limit });
  if (invoices.items.length) {
    groups.push({
      type: 'invoice', label: 'Hisob-fakturalar',
      items: invoices.items.slice(0, limit).map(i => ({
        id: i.id, title: `${i.no} — ${i.customer_name}`, subtitle: `${i.issue_date} • ${i.status_label}`, amount: i.total,
        link: { page: 'invoices', params: { id: i.id } },
      })),
    });
  }

  // Xarid hisoblari
  const bills = require('./bills').list(companyId, { search: query, pageSize: limit });
  if (bills.items.length) {
    groups.push({
      type: 'bill', label: 'Xarid hisoblari',
      items: bills.items.slice(0, limit).map(b => ({
        id: b.id, title: `${b.no} — ${b.supplier_name}`, subtitle: `${b.issue_date} • ${b.status_label}`, amount: b.total,
        link: { page: 'bills', params: { id: b.id } },
      })),
    });
  }

  // Kontragentlar
  const parties = require('./parties').list(companyId, { search: query }).slice(0, limit);
  if (parties.length) {
    groups.push({
      type: 'party', label: 'Kontragentlar',
      items: parties.map(p => ({
        id: p.id, title: p.name, subtitle: `${p.inn || 'STIR yo‘q'} • ${p.phone || 'telefon yo‘q'}`,
        amount: p.balance || null,
        link: { page: 'parties', params: { party_id: p.id } },
      })),
    });
  }

  // Mahsulotlar
  const products = require('./inventory').list(companyId, { search: query }).slice(0, limit);
  if (products.length) {
    groups.push({
      type: 'product', label: 'Mahsulotlar',
      items: products.map(p => ({
        id: p.id, title: p.name, subtitle: `${p.sku} • ${p.stock} ${p.unit}`, amount: p.sale_price || null,
        link: { page: 'inventory', params: { product_id: p.id } },
      })),
    });
  }

  // Hujjatlar
  const docs = require('./documents').list(companyId, { search: query, pageSize: limit });
  if (docs.items.length) {
    groups.push({
      type: 'document', label: 'Hujjatlar',
      items: docs.items.slice(0, limit).map(d => ({
        id: d.id, title: d.name, subtitle: `${d.type_label} • ${d.size_label}`,
        link: { page: 'documents', params: { id: d.id } },
      })),
    });
  }

  // Summa bo'yicha qidiruv
  if (amountQuery >= 1000) {
    const byAmount = ledger.entries(companyId, { includePending: true })
      .filter(e => e.lines.some(l => Math.abs(l.debit - amountQuery) < 1 || Math.abs(l.credit - amountQuery) < 1))
      .slice(0, limit)
      .map(e => ({
        id: e.id, title: `${e.no} — ${e.memo}`, subtitle: `${e.date} • ${U.fmtMoney(U.sumBy(e.lines, l => l.debit))}`,
        link: { page: 'transactions', params: { id: e.id } },
      }));
    if (byAmount.length) groups.push({ type: 'amount', label: `Summa bo‘yicha (${U.fmtMoney(amountQuery)})`, items: byAmount });
  }

  // Hisobotlar katalogi
  const reports = require('./reports').CATALOG.filter(r => U.norm(`${r.title} ${r.description}`).includes(q)).slice(0, limit);
  if (reports.length) {
    groups.push({
      type: 'report', label: 'Hisobotlar',
      items: reports.map(r => ({ id: r.key, title: r.title, subtitle: r.description, link: { page: 'reports', params: { report: r.key } } })),
    });
  }

  const total = U.sumBy(groups, g => g.items.length);
  return { query, groups, total, hint: total ? null : 'Hech narsa topilmadi. Boshqa kalit so‘z yoki summani sinab ko‘ring.' };
}

function suggestions(companyId) {
  const out = [];
  const ar = require('./invoices').receivablesSummary(companyId);
  const radar = require('./radar').counts(companyId);
  if (radar.total) out.push({ label: `Xato Radar: ${radar.total} ta topilma`, link: { page: 'radar', params: {} } });
  if (ar.overdue > 0) out.push({ label: `Muddati o‘tgan debitorlik: ${U.fmtMoney(ar.overdue)}`, link: { page: 'receivables', params: {} } });
  const pending = ledger.pendingEntries(companyId).length;
  if (pending) out.push({ label: `Tasdiqlash kutilmoqda: ${pending} ta`, link: { page: 'approvals', params: {} } });
  return out;
}

module.exports = { PAGES, search, suggestions };
