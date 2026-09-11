'use strict';
/**
 * BUXAI — Hisoblar rejasi (Chart of Accounts).
 * O'zbekiston buxgalteriya hisobi amaliyotiga yaqinlashtirilgan kodlar tizimi.
 * Har bir hisob: kod, nom (uz/ru/en), turi, normal qoldiq tomoni, guruh.
 *
 * MUHIM: bu reja buxgalter tomonidan sozlanadi; kodlar o'zgartirilishi mumkin,
 * lekin tizim hisoblar (is_system) o'chirilmaydi — ular dvigatel uchun zarur.
 */

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

// subtype → tizim roli (ledger/reports shu bo'yicha ishlaydi)
const ROLES = {
  cash: 'cash',
  bank: 'bank',
  receivable: 'ar',
  payable: 'ap',
  inventory: 'inventory',
  vat_receivable: 'vat_in',
  vat_payable: 'vat_out',
  revenue: 'revenue',
  cos: 'cos',
  opex: 'opex',
  payroll_payable: 'payroll',
  tax_payable: 'tax',
  equity: 'equity',
  retained: 'retained',
  fixed_asset: 'fixed',
  accumulated_dep: 'accum_dep',
  other_income: 'other_income',
  other_expense: 'other_expense',
  financial_expense: 'fin_expense',
  income_tax: 'income_tax',
  advance_paid: 'advance_paid',
  advance_received: 'advance_received',
  loan: 'loan',
  owner_draw: 'owner_draw',
};

/** Standart hisoblar rejasi */
const TEMPLATE = [
  // ── Aktivlar ────────────────────────────────────────────────────────────────
  { code: '0100', name: 'Asosiy vositalar', type: 'asset', subtype: 'fixed_asset', role: 'fixed' },
  { code: '0110', name: 'Asosiy vositalar eskirishi', type: 'asset', subtype: 'accumulated_dep', role: 'accum_dep', normal: 'credit' },
  { code: '0510', name: 'Kassa', type: 'asset', subtype: 'cash', role: 'cash', is_cash: true },
  { code: '0520', name: 'Hisob-kitob hisobi (bank)', type: 'asset', subtype: 'bank', role: 'bank', is_bank: true },
  { code: '0530', name: 'Valyuta hisobi', type: 'asset', subtype: 'bank', role: 'bank', is_bank: true },
  { code: '0540', name: 'Plastik karta hisobi', type: 'asset', subtype: 'bank', role: 'bank', is_bank: true },
  { code: '0550', name: 'Yo‘ldagi pul mablag‘lari', type: 'asset', subtype: 'bank', role: 'bank' },
  { code: '0610', name: 'Xaridorlar va buyurtmachilar (debitorlik)', type: 'asset', subtype: 'receivable', role: 'ar' },
  { code: '0620', name: 'Berilgan bo‘naklar', type: 'asset', subtype: 'advance_paid', role: 'advance_paid' },
  { code: '0630', name: 'Boshqa debitorlar', type: 'asset', subtype: 'receivable', role: 'ar' },
  { code: '1010', name: 'Xom ashyo va materiallar', type: 'asset', subtype: 'inventory', role: 'inventory' },
  { code: '1020', name: 'Tovar zaxiralari', type: 'asset', subtype: 'inventory', role: 'inventory' },
  { code: '1030', name: 'Tayyor mahsulot', type: 'asset', subtype: 'inventory', role: 'inventory' },
  { code: '4410', name: 'QQS — hisobga olinadigan (kirim)', type: 'asset', subtype: 'vat_receivable', role: 'vat_in' },
  { code: '4510', name: 'Budjetga bo‘lgan da’volar', type: 'asset', subtype: 'receivable', role: 'ar' },

  // ── Majburiyatlar ───────────────────────────────────────────────────────────
  { code: '6010', name: 'Mol yetkazib beruvchilar (kreditorlik)', type: 'liability', subtype: 'payable', role: 'ap' },
  { code: '6020', name: 'Olingan bo‘naklar', type: 'liability', subtype: 'advance_received', role: 'advance_received' },
  { code: '6410', name: 'QQS — to‘lanadigan (chiqim)', type: 'liability', subtype: 'vat_payable', role: 'vat_out' },
  { code: '6420', name: 'Ish haqi bo‘yicha qarzlar', type: 'liability', subtype: 'payroll_payable', role: 'payroll' },
  { code: '6430', name: 'Ijtimoiy to‘lovlar bo‘yicha qarzlar', type: 'liability', subtype: 'payroll_payable', role: 'payroll' },
  { code: '6440', name: 'Soliqlar va yig‘imlar bo‘yicha qarzlar', type: 'liability', subtype: 'tax_payable', role: 'tax' },
  { code: '6450', name: 'Boshqa kreditorlar', type: 'liability', subtype: 'payable', role: 'ap' },
  { code: '6810', name: 'Uzoq muddatli kreditlar', type: 'liability', subtype: 'loan', role: 'loan' },
  { code: '6820', name: 'Qisqa muddatli kreditlar', type: 'liability', subtype: 'loan', role: 'loan' },

  // ── Kapital ─────────────────────────────────────────────────────────────────
  { code: '8300', name: 'Ustav kapitali', type: 'equity', subtype: 'equity', role: 'equity' },
  { code: '8390', name: 'Ta’sischi hissasi / shaxsiy hisob', type: 'equity', subtype: 'equity', role: 'equity' },
  { code: '8400', name: 'Taqsimlanmagan foyda (oldingi davrlar)', type: 'equity', subtype: 'retained', role: 'retained' },

  // ── Daromadlar ──────────────────────────────────────────────────────────────
  { code: '9010', name: 'Mahsulot (tovar) sotishdan daromad', type: 'income', subtype: 'revenue', role: 'revenue' },
  { code: '9020', name: 'Xizmat ko‘rsatishdan daromad', type: 'income', subtype: 'revenue', role: 'revenue' },
  { code: '9030', name: 'Boshqa operatsion daromadlar', type: 'income', subtype: 'other_income', role: 'other_income' },
  { code: '9040', name: 'Foiz va kurs daromadlari', type: 'income', subtype: 'other_income', role: 'other_income' },
  { code: '9090', name: 'Daromaddan qaytarishlar (kontra)', type: 'income', subtype: 'revenue', role: 'returns', normal: 'debit' },

  // ── Xarajatlar ──────────────────────────────────────────────────────────────
  { code: '9110', name: 'Sotilgan tovar tannarxi', type: 'expense', subtype: 'cos', role: 'cos' },
  { code: '9120', name: 'Xom ashyo va materiallar xarajati', type: 'expense', subtype: 'cos', role: 'cos' },
  { code: '9410', name: 'Ish haqi xarajati', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9420', name: 'Ijtimoiy to‘lovlar', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9430', name: 'Ijara xarajati', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9440', name: 'Kommunal xizmatlar', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9450', name: 'Marketing va reklama', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9460', name: 'Transport va logistika', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9470', name: 'Aloqa va internet', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9480', name: 'Ofis va xo‘jalik xarajatlari', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9490', name: 'Professional xizmatlar (audit, yuridik)', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9500', name: 'Bank xizmatlari', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9510', name: 'Soliqlar va yig‘imlar (xarajat)', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9520', name: 'Amortizatsiya', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9530', name: 'Xizmat safari', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9540', name: 'Ta’mirlash va texnik xizmat', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9550', name: 'Ta’lim va malaka oshirish', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9560', name: 'Sug‘urta', type: 'expense', subtype: 'opex', role: 'opex' },
  { code: '9570', name: 'Jarimalar va penya', type: 'expense', subtype: 'other_expense', role: 'other_expense' },
  { code: '9590', name: 'Boshqa xarajatlar', type: 'expense', subtype: 'other_expense', role: 'other_expense' },
  { code: '9610', name: 'Foiz xarajatlari', type: 'expense', subtype: 'financial_expense', role: 'fin_expense' },
  { code: '9710', name: 'Foyda solig‘i', type: 'expense', subtype: 'income_tax', role: 'income_tax' },
];

/** Standart pul/kontragent hisoblari — company settings orqali almashtiriladi */
const DEFAULT_ROLE_MAP = {
  cash: '0510', bank: '0520', ar: '0610', ap: '6010', inventory: '1020',
  vat_in: '4410', vat_out: '6410', revenue: '9010', revenue_service: '9020',
  cos: '9110', payroll: '9410', payroll_payable: '6420', tax: '6440', returns: '9090',
  retained: '8400', equity: '8300', other_income: '9030', other_expense: '9590',
  fin_expense: '9610', income_tax: '9710', owner_draw: '8390', loan: '6820',
  bank_fees: '9500', fx: '9040',
};

/** Tranzaksiya kategoriyasi → standart xarajat hisobi */
const EXPENSE_CATEGORIES = [
  { key: 'payroll', label: 'Ish haqi', account: '9410' },
  { key: 'social', label: 'Ijtimoiy to‘lovlar', account: '9420' },
  { key: 'rent', label: 'Ijara', account: '9430' },
  { key: 'utilities', label: 'Kommunal xizmatlar', account: '9440' },
  { key: 'marketing', label: 'Marketing', account: '9450' },
  { key: 'logistics', label: 'Transport', account: '9460' },
  { key: 'telecom', label: 'Aloqa va internet', account: '9470' },
  { key: 'office', label: 'Ofis', account: '9480' },
  { key: 'professional', label: 'Professional xizmatlar', account: '9490' },
  { key: 'bank', label: 'Bank xizmatlari', account: '9500' },
  { key: 'taxes', label: 'Soliqlar', account: '9510' },
  { key: 'repair', label: 'Ta’mirlash', account: '9540' },
  { key: 'travel', label: 'Xizmat safari', account: '9530' },
  { key: 'insurance', label: 'Sug‘urta', account: '9560' },
  { key: 'cos', label: 'Tovar tannarxi', account: '9110' },
  { key: 'other', label: 'Boshqa xarajatlar', account: '9590' },
];

const INCOME_CATEGORIES = [
  { key: 'sales', label: 'Tovar savdosi', account: '9010' },
  { key: 'services', label: 'Xizmatlar', account: '9020' },
  { key: 'other_income', label: 'Boshqa daromad', account: '9030' },
];

function accountByCode(code, list) { return list.find(a => a.code === code) || null; }
function roleAccount(role, list) {
  const found = list.find(a => a.role === role && a.active !== false);
  return found ? found.code : null;
}

module.exports = { TYPES, ROLES, TEMPLATE, DEFAULT_ROLE_MAP, EXPENSE_CATEGORIES, INCOME_CATEGORIES, accountByCode, roleAccount };
