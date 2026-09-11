'use strict';
/**
 * BUXAI — Demo ma'lumotlar generatori.
 * MUHIM: bu yerda hech qanday "soxta ko'rsatkich" yo'q — barcha yozuvlar haqiqiy
 * buxgalteriya dvigateli orqali kiritiladi. Hisobotlar, AI va Xato Radar shu
 * yozuvlardan xuddi foydalanuvchi kiritgan ma'lumot kabi ishlaydi.
 *
 * Demo kompaniya: O'zbekiston sharoitiga mos ishlab chiqarish/savdo korxonasi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');

function pick(arr, i) { return arr[i % arr.length]; }
function rand(seed, min, max) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  const f = x - Math.floor(x);
  return Math.round(min + f * (max - min));
}
function monthDate(period, day) {
  const [y, m] = period.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${period}-${U.pad(Math.min(day, last))}`;
}

const CUSTOMERS = [
  { name: 'Toshkent Coffee House MChJ', inn: '301456789', phone: '+998 71 200 45 12', address: 'Toshkent sh., Yunusobod tumani, Amir Temur shoh ko‘chasi 108', terms: 14, limit: 120000000, kind: 'customer' },
  { name: 'Navoiy Logistics Group MChJ', inn: '302987654', phone: '+998 79 220 11 08', address: 'Navoiy sh., Karmana tumani, 12-mavze', terms: 30, limit: 250000000, kind: 'customer' },
  { name: 'Digital Solutions LLC', inn: '304556677', phone: '+998 71 233 77 90', address: 'Toshkent sh., Mirzo Ulug‘bek tumani, Buyuk Ipak Yo‘li 45', terms: 7, limit: 60000000, kind: 'customer' },
  { name: 'Samarqand Retail Trade MChJ', inn: '305123456', phone: '+998 66 233 45 67', address: 'Samarqand sh., Registon ko‘chasi 21', terms: 21, limit: 150000000, kind: 'customer' },
  { name: 'Andijon Textile Production MChJ', inn: '306778899', phone: '+998 74 223 09 11', address: 'Andijon sh., Boburshoh ko‘chasi 4', terms: 14, limit: 90000000, kind: 'customer' },
  { name: 'Buxoro Agro Service MChJ', inn: '307334455', phone: '+998 65 221 33 44', address: 'Buxoro sh., Mustaqillik maydoni 7', terms: 21, limit: 70000000, kind: 'customer' },
];

const SUPPLIERS = [
  { name: 'Ipak Yo‘li Logistics MChJ', inn: '308112233', phone: '+998 71 289 12 34', address: 'Toshkent sh., Sergeli tumani, Yangi Sergeli 15', terms: 15, kind: 'supplier', category: 'Transport' },
  { name: 'UzCloud Hosting MChJ', inn: '309445566', phone: '+998 71 202 30 40', address: 'Toshkent sh., Shayxontohur tumani, Navoiy 30', terms: 10, kind: 'supplier', category: 'Aloqa va IT' },
  { name: 'Marketing Pro Agency MChJ', inn: '310998877', phone: '+998 71 281 55 66', address: 'Toshkent sh., Chilonzor tumani, Bunyodkor 56', terms: 14, kind: 'supplier', category: 'Marketing' },
  { name: 'Toshkent Ofis Mebel MChJ', inn: '311223344', phone: '+998 71 244 77 88', address: 'Toshkent sh., Olmazor tumani, Qorasaroy 18', terms: 20, kind: 'supplier', category: 'Ofis' },
  { name: 'Xom Ashyo Savdo MChJ', inn: '312667788', phone: '+998 70 312 22 33', address: 'Toshkent sh., Yashnobod tumani, Ohangaron yo‘li 100', terms: 25, kind: 'supplier', category: 'Xom ashyo' },
  { name: 'Energo Resurs MChJ', inn: '313556699', phone: '+998 71 255 88 99', address: 'Toshkent sh., Uchtepa tumani, Beshyog‘och 41', terms: 10, kind: 'supplier', category: 'Kommunal' },
];

const PRODUCTS = [
  { name: 'Paxta ip 100% (30/1)', sku: 'IP-3001', unit: 'kg', purchase: 42000, sale: 58000, min: 400, category: 'Xom ashyo', opening: 1800, warehouse: 'Asosiy ombor' },
  { name: 'Trikotaj mato (oq)', sku: 'MT-1010', unit: 'metr', purchase: 26000, sale: 36000, min: 600, category: 'Matolar', opening: 2400, warehouse: 'Asosiy ombor' },
  { name: 'Tayyor erkaklar futbolkasi (L)', sku: 'FUT-2001', unit: 'dona', purchase: 38000, sale: 62000, min: 150, category: 'Tayyor mahsulot', opening: 520, warehouse: 'Asosiy ombor' },
  { name: 'Tayyor ayollar bluzkasi (M)', sku: 'BLZ-2002', unit: 'dona', purchase: 45000, sale: 78000, min: 120, category: 'Tayyor mahsulot', opening: 380, warehouse: 'Asosiy ombor' },
  { name: 'Qadoqlash paketi (50x70)', sku: 'PKT-3005', unit: 'paket', purchase: 3200, sale: 5500, min: 500, category: 'Qadoqlash', opening: 2400, warehouse: 'Asosiy ombor' },
  { name: 'Logistika xizmati (Toshkent–Navoiy)', sku: 'SRV-LOG', unit: 'xizmat', purchase: 0, sale: 2800000, min: 0, category: 'Xizmatlar', opening: 0, warehouse: '—', service: true, sale_only: true },
  { name: 'IT konsalting (soat)', sku: 'SRV-IT', unit: 'soat', purchase: 0, sale: 350000, min: 0, category: 'Xizmatlar', opening: 0, warehouse: '—', service: true },
];

/**
 * @param {string} companyId
 * @param {Object} owner  — foydalanuvchi
 * @param {string} profile — 'demo' | 'minimal'
 */
function seedCompany(companyId, owner, profile = 'demo') {
  const existing = store.collection('entries').filter(e => e.company_id === companyId).length;
  if (existing) return { skipped: true, reason: 'Kompaniyada allaqachon buxgalteriya yozuvlari mavjud.' };

  const tx = require('./transactions');
  const inv = require('./invoices');
  const billsMod = require('./bills');
  const pay = require('./payments');
  const invtry = require('./inventory');
  const parties = require('./parties');
  const companiesMod = require('./companies');
  const user = owner || null;
  const created = { parties: [], products: [], invoices: [], bills: [], payments: [], transactions: [], stock_moves: 0, bank_rows: 0 };

  // Reja: demo kompaniyaga kengroq limitlar
  companiesMod.changePlan(companyId, profile === 'minimal' ? 'starter' : 'business', { id: null, name: 'Tizim (demo)' }, { period: 'yearly' });

  // ── Kassa va hisoblar ────────────────────────────────────────────────────
  const bankCode = '0520';
  const cashCode = '0510';
  const today = U.today();

  // ── Kontragentlar ────────────────────────────────────────────────────────
  const customers = CUSTOMERS.map(c => {
    const p = parties.create(companyId, { ...c, payment_terms_days: c.terms, credit_limit: c.limit }, user);
    created.parties.push(p.name);
    return p;
  });
  const suppliers = SUPPLIERS.map(s => {
    const p = parties.create(companyId, { ...s, payment_terms_days: s.terms, category: s.category }, user);
    created.parties.push(p.name);
    return p;
  });

  // ── Mahsulotlar va boshlang‘ich zaxira ───────────────────────────────────
  const products = PRODUCTS.map((p, idx) => {
    const prod = invtry.create(companyId, {
      name: p.name, sku: p.sku, unit: p.unit, category: p.category,
      purchase_price: p.purchase, sale_price: p.sale, min_stock: p.min, warehouse: p.warehouse,
      is_service: !!p.service, opening_stock: p.opening, opening_date: U.addDays(today, -190),
      opening_account: ledger.roleCode(companyId, 'equity'),
    }, user);
    created.products.push(prod.name);
    return prod;
  });
  const physical = products.filter(p => !p.is_service && p.sale_price > 0);
  const serviceProducts = products.filter(p => p.is_service && p.sale_price > 0);

  // ── Boshlang‘ich kapital (kassa/bank) ───────────────────────────────────
  ledger.postEntry(companyId, {
    date: U.addDays(today, -190),
    memo: 'Boshlang‘ich kapital — ustav fondi va bank hisobi',
    ref: 'OPENING',
    lines: [
      { account: bankCode, debit: 320000000, description: 'Ustav kapitali (bank hisobi)' },
      { account: cashCode, debit: 25000000, description: 'Kassa uchun boshlang‘ich mablag‘' },
      { account: '0100', debit: 145000000, description: 'Ishlab chiqarish uskunasi' },
      { account: '8300', credit: 400000000, description: 'Ustav kapitali' },
      { account: '6810', credit: 90000000, description: 'Uzoq muddatli bank krediti' },
    ],
    source: { type: 'opening_balance', id: null }, user,
  });

  const months = U.lastNPeriods(6);
  let seq = 1;

  for (let mi = 0; mi < months.length; mi++) {
    const period = months[mi];
    const isCurrent = period === U.currentPeriod();
    const maxDay = isCurrent ? Number(today.slice(8, 10)) : Number(U.periodEnd(period).slice(8, 10));
    const growth = 1 + mi * 0.06; // biznes asta o‘sib boradi

    // ── Ish haqi ───────────────────────────────────────────────────────────
    const payroll = U.round(rand(seq++, 52000000, 59000000) * (1 + mi * 0.02), -4);
    tx.create(companyId, {
      type: 'expense', amount: payroll, date: monthDate(period, Math.min(5, maxDay)),
      description: `Xodimlar ish haqi — ${U.periodLabel(period)}`, category: 'payroll',
      account: bankCode, method: 'bank', vat_rate: 0,
    }, user);
    created.transactions.push(`Ish haqi ${period}`);

    tx.create(companyId, {
      type: 'expense', amount: U.round(payroll * 0.12, -3), date: monthDate(period, Math.min(5, maxDay)),
      description: `Ijtimoiy to‘lovlar (12%) — ${U.periodLabel(period)}`, category: 'social',
      account: bankCode, method: 'bank', vat_rate: 0,
    }, user);

    // ── Ijara va kommunal ──────────────────────────────────────────────────
    tx.create(companyId, {
      type: 'expense', amount: 24000000, date: monthDate(period, Math.min(3, maxDay)),
      description: `Ishlab chiqarish binosi ijarasi — ${U.periodLabel(period)}`, category: 'rent',
      account: bankCode, method: 'bank', vat_rate: 12,
    }, user);
    tx.create(companyId, {
      type: 'expense', amount: U.round(rand(seq++, 7800000, 9600000), -4), date: monthDate(period, Math.min(12, maxDay)),
      description: `Elektr va kommunal xizmatlar — ${U.periodLabel(period)}`, category: 'utilities',
      account: bankCode, method: 'bank', vat_rate: 12,
    }, user);
    tx.create(companyId, {
      type: 'expense', amount: 1850000, date: monthDate(period, Math.min(8, maxDay)),
      description: `Aloqa va internet — ${U.periodLabel(period)}`, category: 'telecom',
      account: bankCode, method: 'bank', vat_rate: 12,
    }, user);

    // ── Marketing (o‘sib boradi, oxirgi oyda takroriy yozuv — dublikat signal) ──
    const marketing = U.round(rand(seq++, 12000000, 16000000) * growth, -4);
    tx.create(companyId, {
      type: 'expense', amount: marketing, date: monthDate(period, Math.min(15, maxDay)),
      description: `Reklama kampaniyasi — ${U.periodLabel(period)}`, category: 'marketing',
      account: bankCode, method: 'bank', vat_rate: 12, party_id: suppliers[2].id,
    }, user);
    if (isCurrent && maxDay >= 8) {
      // Real hayotda uchraydigan holat: bir xil to‘lov ikki marta kiritilgan (Xato Radar fixture).
      // Xato Radar buni aniqlashi kerak (dublikat aniqlovchi real ishlaydi).
      tx.create(companyId, {
        type: 'expense', amount: marketing, date: monthDate(period, Math.min(16, maxDay)),
        description: `Reklama kampaniyasi — ${U.periodLabel(period)} (bank ko‘chirmasi bo‘yicha)`, category: 'marketing',
        account: bankCode, method: 'bank', vat_rate: 12, party_id: suppliers[2].id,
      }, user);
    }

    // ── Logistika xarajati ─────────────────────────────────────────────────
    tx.create(companyId, {
      type: 'expense', amount: U.round(rand(seq++, 9000000, 13500000), -4), date: monthDate(period, Math.min(18, maxDay)),
      description: `Transport va yetkazib berish — ${U.periodLabel(period)}`, category: 'logistics',
      account: bankCode, method: 'bank', vat_rate: 12, party_id: suppliers[0].id,
    }, user);

    // ── Hisob-fakturalar (sotuv) ───────────────────────────────────────────
    const invoiceCount = profile === 'minimal' ? 2 : rand(seq++, 4, 6);
    for (let k = 0; k < invoiceCount; k++) {
      const customer = pick(customers, mi + k);
      const day = Math.min(maxDay, 4 + k * 4 + rand(seq++, 0, 2));
      const issue = monthDate(period, day);
      const due = U.addDays(issue, customer.payment_terms_days || 14);
      const items = [];
      const lineCount = rand(seq++, 1, 3);
      for (let li = 0; li < lineCount; li++) {
        const prod = pick(physical, mi + k + li);
        const qty = prod.unit === 'kg' ? rand(seq++, 300, 900) : prod.unit === 'metr' ? rand(seq++, 250, 700) : rand(seq++, 40, 260);
        items.push({ product_id: prod.id, qty, unit_price: prod.sale_price, name: prod.name, unit: prod.unit });
      }
      if (rand(seq++, 0, 3) === 0) {
        const sp = pick(serviceProducts, mi + k);
        items.push({ product_id: sp.id, qty: rand(seq++, 3, 25), unit_price: sp.sale_price, name: sp.name, unit: sp.unit });
      }
      const invoice = inv.create(companyId, {
        customer_id: customer.id, issue_date: issue, due_date: due, items,
        notes: `Shartnoma №${100 + mi}${k} bo‘yicha`, vat_enabled: true,
      }, user);
      created.invoices.push(invoice.no);

      // To‘lov holati: ko‘pi to‘langan, ba’zilari qismon yoki to‘lanmagan
      const mode = rand(seq++, 0, 9);
      const open = invoice.open_amount;
      if (mode <= 5) {
        pay.create(companyId, {
          type: 'incoming', party_id: customer.id, amount: open,
          date: U.addDays(issue, Math.min(rand(seq++, 5, 30), Math.max(1, maxDay - day))),
          method: 'bank', account: bankCode, allocations: [{ invoice_id: invoice.id, amount: open }],
          memo: `${invoice.no} uchun to‘lov — ${customer.name}`, reference: invoice.no,
        }, user);
        created.payments.push(invoice.no);
      } else if (mode <= 7) {
        const part = U.round(open * 0.45, 0);
        pay.create(companyId, {
          type: 'incoming', party_id: customer.id, amount: part,
          date: U.addDays(issue, Math.min(rand(seq++, 8, 25), Math.max(1, maxDay - day))),
          method: 'bank', account: bankCode, allocations: [{ invoice_id: invoice.id, amount: part }],
          memo: `${invoice.no} uchun qismon to‘lov — ${customer.name}`, reference: invoice.no,
        }, user);
        created.payments.push(invoice.no);
      }
      // mode 8-9: to‘lanmagan (muddati o‘tgan debitorlik hosil bo‘ladi)
    }

    // ── Xarid hisoblari ────────────────────────────────────────────────────
    const billCount = profile === 'minimal' ? 1 : rand(seq++, 2, 3);
    for (let k = 0; k < billCount; k++) {
      const supplier = pick(suppliers, mi + k);
      const day = Math.min(maxDay, 6 + k * 5);
      const issue = monthDate(period, day);
      const due = U.addDays(issue, supplier.payment_terms_days || 15);
      const prod = pick(physical, mi + k + 1);
      const qty = prod.unit === 'kg' ? rand(seq++, 400, 1000) : rand(seq++, 30, 120);
      const bill = billsMod.create(companyId, {
        supplier_id: supplier.id, issue_date: issue, due_date: due,
        supplier_invoice_no: `SF-${period.slice(5)}${k + 1}${Math.abs(mi * 7 + k)}`,
        items: [{ product_id: prod.id, qty, unit_price: prod.purchase_price, name: prod.name, unit: prod.unit }],
        notes: `${supplier.name} hisobi`,
      }, user);
      created.bills.push(bill.no);
      const mode = rand(seq++, 0, 9);
      if (mode <= 6) {
        pay.create(companyId, {
          type: 'outgoing', party_id: supplier.id, amount: bill.open_amount,
          date: U.addDays(issue, Math.min(rand(seq++, 5, 25), Math.max(1, maxDay - day))),
          method: 'bank', account: bankCode, allocations: [{ bill_id: bill.id, amount: bill.open_amount }],
          memo: `${bill.no} bo‘yicha to‘lov — ${supplier.name}`, reference: bill.no,
        }, user);
        created.payments.push(bill.no);
      } else if (mode <= 8) {
        const part = U.round(bill.open_amount * 0.5, 0);
        if (part > 0) {
          pay.create(companyId, {
            type: 'outgoing', party_id: supplier.id, amount: part,
            date: U.addDays(issue, Math.min(rand(seq++, 6, 22), Math.max(1, maxDay - day))),
            method: 'bank', account: bankCode, allocations: [{ bill_id: bill.id, amount: part }],
            memo: `${bill.no} uchun qismon to‘lov — ${supplier.name}`,
          }, user);
        }
      }
    }

    // ── Ofis va boshqa xarajatlar ──────────────────────────────────────────
    tx.create(companyId, {
      type: 'expense', amount: U.round(rand(seq++, 2600000, 4200000), -3), date: monthDate(period, Math.min(20, maxDay)),
      description: `Ofis va xo‘jalik xarajatlari — ${U.periodLabel(period)}`, category: 'office',
      account: cashCode, method: 'cash', vat_rate: 0,
    }, user);
    tx.create(companyId, {
      type: 'expense', amount: 1250000, date: monthDate(period, Math.min(22, maxDay)),
      description: `Bank xizmatlari — ${U.periodLabel(period)}`, category: 'bank',
      account: bankCode, method: 'bank', vat_rate: 0,
    }, user);

    // ── Boshqa operatsion daromad ──────────────────────────────────────────
    if (rand(seq++, 0, 2) === 0) {
      tx.create(companyId, {
        type: 'income', amount: U.round(rand(seq++, 3200000, 6800000), -3), date: monthDate(period, Math.min(24, maxDay)),
        description: `Qaytarilgan ortiqcha to‘lov / boshqa daromad — ${U.periodLabel(period)}`, category: 'other_income',
        account: bankCode, method: 'bank', vat_rate: 0,
      }, user);
    }
  }

  // ── Kassa harakatlari (naqd) ─────────────────────────────────────────────
  tx.create(companyId, {
    type: 'transfer', amount: 15000000, date: U.addDays(today, -20), from_account: bankCode, to_account: cashCode,
    account: bankCode, to_account_id: cashCode, description: 'Bankdan kassaga naqd mablag‘',
  }, user).catch?.(() => {});

  // ── Maqsadlar ────────────────────────────────────────────────────────────
  const dashboard = require('./dashboard');
  dashboard.createGoal(companyId, { metric: 'revenue', target: 480000000, period: 'month', note: 'Joriy oy sotuv rejasi' }, user);
  dashboard.createGoal(companyId, { metric: 'expense_limit', target: 320000000, period: 'month', note: 'Operatsion xarajatlar limiti' }, user);
  dashboard.createGoal(companyId, { metric: 'receivables_collection', target: 250000000, period: 'month', note: 'Undirish rejasi' }, user);

  // ── Vazifalar ────────────────────────────────────────────────────────────
  const work = require('./work');
  work.createTask(companyId, { title: 'Oylik yopish: bank solishtirish', detail: 'Bank ko‘chirmasini import qilib, barcha qatorlarni solishtirish', due_date: U.addDays(today, 2), priority: 'high' }, user);
  work.createTask(companyId, { title: 'QQS hisob-kitobini tayyorlash', detail: 'Hisob-fakturalar va kirim QQS larini tekshirish', due_date: U.addDays(today, 5), priority: 'medium' }, user);
  work.createTask(companyId, { title: 'Inventarizatsiya o‘tkazish', detail: 'Asosiy omborda jismoniy sanoq va tizim qoldiqlarini taqqoslash', due_date: U.addDays(today, 9), priority: 'medium' }, user);

  // ── Bank ko‘chirmasi (import + solishtirish demo) ────────────────────────
  const banking = require('./banking');
  try {
    const csv = buildStatementCsv(companyId, bankCode);
    banking.importStatement(companyId, {
      account: bankCode, filename: `hисob-ko‘chirma-${U.currentPeriod()}.csv`, format: 'csv', content: csv,
      period_start: U.periodStart(U.currentPeriod()), period_end: today,
    }, user);
    created.bank_rows = store.collection('bankRows').filter(r => r.company_id === companyId).length;
  } catch (e) {
    console.error('[seed] bank import:', e.message);
  }

  // ── Obuna yangilanishi haqida yozuv (audit uchun) ────────────────────────
  require('./audit').log({
    company_id: companyId, user, action: 'company.seed', entity: 'company', entity_id: companyId,
    summary: `Demo ma’lumotlar yaratildi: ${created.invoices.length} hisob-faktura, ${created.bills.length} xarid, ${created.payments.length} to‘lov`,
    after: { counts: { partners: created.parties.length, products: created.products.length, invoices: created.invoices.length, bills: created.bills.length, payments: created.payments.length, bank_rows: created.bank_rows } },
  });
  require('./radar').invalidate(companyId);
  return { skipped: false, created, months: months.length };
}

/** Bank ko'chirmasi CSV: real yozuvlardan quriladi (mos keladigan va kelmaydigan qatorlar) */
function buildStatementCsv(companyId, account) {
  const entries = ledger.entries(companyId, { from: U.periodStart(U.currentPeriod()), to: U.today() })
    .filter(e => e.lines.some(l => l.account === account));
  const rows = [['Sana', 'Hujjat', 'Kontragent', 'Izoh', 'Kirim', 'Chiqim', 'Qoldiq'].join(',')];
  const sorted = U.sortBy(entries, e => e.date);
  let balance = 320000000;
  for (const e of sorted) {
    const line = e.lines.find(l => l.account === account);
    if (!line) continue;
    const amount = line.debit - line.credit;
    balance += amount;
    const contra = e.lines.find(l => l !== line);
    const party = contra && contra.party_id ? store.collection('parties').find(p => p.id === contra.party_id) : null;
    const desc = (e.memo || '').replace(/[,;]/g, ' ').slice(0, 80);
    rows.push([
      e.date, e.no, party ? party.name.replace(/,/g, ' ') : (contra ? contra.account : ''),
      desc,
      amount > 0 ? amount : '', amount < 0 ? Math.abs(amount) : '', balance,
    ].join(','));
  }
  // Hisobotda aks etmagan bank harakatlari (real hayotda bo'ladi): komissiya va foiz
  rows.push([U.today(), 'BS-90121', 'Tashkent City Bank', 'Hisob yuritish komissiyasi', '', 285000, balance - 285000].join(','));
  rows.push([U.addDays(U.today(), -2), 'BS-90118', 'Tashkent City Bank', 'Karta operatsiyasi komissiyasi', '', 75000, balance - 360000].join(','));
  rows.push([U.addDays(U.today(), -1), 'BS-90125', 'Tashkent City Bank', 'Karta operatsiyasi komissiyasi', '', 75000, balance - 435000].join(','));
  return rows.join('\n');
}

module.exports = { seedCompany, CUSTOMERS, SUPPLIERS, PRODUCTS };
