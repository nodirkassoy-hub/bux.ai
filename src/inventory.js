'use strict';
/**
 * BUXAI — Mahsulotlar va ombor (inventory).
 * Ombor qiymati o'rtacha tortilgan tannarx (weighted average) usulida hisoblanadi
 * va buxgalteriya jurnaliga (1010/1020/1030) bog'lanadi.
 */
const store = require('./store');
const U = require('./util');
const ledger = require('./ledger');
const { ApiError } = U;

const UNITS = ['dona', 'kg', 'litr', 'metr', 'm²', 'm³', 'quti', 'paket', 'komplekt', 'soat', 'kun', 'xizmat'];
const MOVE_TYPES = {
  in: { key: 'in', label: 'Kirim', sign: 1 },
  out: { key: 'out', label: 'Chiqim', sign: -1 },
  adjust_in: { key: 'adjust_in', label: 'Inventarizatsiya (+)', sign: 1 },
  adjust_out: { key: 'adjust_out', label: 'Inventarizatsiya (−)', sign: -1 },
  return_in: { key: 'return_in', label: 'Qaytarish (kirim)', sign: 1 },
  return_out: { key: 'return_out', label: 'Qaytarish (chiqim)', sign: -1 },
  transfer: { key: 'transfer', label: 'Ko‘chirish', sign: 0 },
  initial: { key: 'initial', label: 'Boshlang‘ich qoldiq', sign: 1 },
};

function products(companyId) { return store.collection('products').filter(p => p.company_id === companyId); }
function moves(companyId) { return store.collection('stockMoves').filter(m => m.company_id === companyId); }
function movesOf(companyId, productId) {
  return U.sortBy(moves(companyId).filter(m => m.product_id === productId), m => `${m.date} ${m.created_at || ''}`);
}
function findProduct(companyId, id) {
  const p = products(companyId).find(x => x.id === id);
  if (!p) throw new ApiError('Mahsulot topilmadi.', 404, 'not_found');
  return p;
}
function tryProduct(companyId, id) { return products(companyId).find(x => x.id === id) || null; }

/** O'rtacha tortilgan tannarx va qoldiq: harakatlar tarixini qayta o'ynash */
function evaluate(companyId, productId) {
  let qty = 0, value = 0, avg = 0;
  const rows = [];
  for (const m of movesOf(companyId, productId)) {
    if (m.type === 'in' || m.type === 'initial' || m.type === 'adjust_in' || m.type === 'return_in') {
      const cost = m.unit_cost != null ? m.unit_cost : (avg || 0);
      const addValue = U.round(m.qty * cost, 0);
      qty += m.qty; value += addValue;
      if (qty > 0) avg = value / qty;
      rows.push({ ...m, unit_cost: cost, value_delta: addValue, balance_qty: qty, balance_value: U.round(value, 0), balance_avg: U.round(qty > 0 ? value / qty : 0, 0) });
    } else {
      const usd = avg || 0;
      const out = U.round(m.qty * usd, 0);
      qty -= m.qty; value -= out;
      if (qty > 0) avg = value / qty; else if (qty === 0) { value = 0; avg = 0; }
      rows.push({ ...m, unit_cost: usd, value_delta: -out, balance_qty: qty, balance_value: U.round(value, 0), balance_avg: U.round(qty > 0 ? Math.max(0, value / qty) : 0, 0) });
    }
  }
  return { qty, value: U.round(value, 0), avg_cost: U.round(qty > 0 ? value / qty : 0, 0), rows };
}

function list(companyId, { search, category, warehouse, low_stock, active = true, sort = 'name' } = {}) {
  let rows = products(companyId);
  if (active) rows = rows.filter(p => p.status !== 'archived');
  if (category) rows = rows.filter(p => p.category === category);
  if (warehouse) rows = rows.filter(p => p.warehouse === warehouse);
  if (search) {
    const q = U.norm(search);
    rows = rows.filter(p => U.norm(`${p.name} ${p.sku} ${p.barcode || ''} ${p.category || ''}`).includes(q));
  }
  const out = rows.map(p => decorate(companyId, p));
  let result = out;
  if (low_stock) result = out.filter(p => !p.is_service && p.stock <= (p.min_stock || 0));
  if (sort === 'value') result = [...result].sort((a, b) => b.value - a.value);
  else if (sort === 'stock') result = [...result].sort((a, b) => a.stock - b.stock);
  else result = [...result].sort((a, b) => String(a.name).localeCompare(String(b.name), 'uz'));
  return result;
}

function decorate(companyId, p) {
  const ev = evaluate(companyId, p.id);
  const min = U.num(p.min_stock);
  return {
    ...p,
    stock: ev.qty,
    stock_value: ev.value,
    avg_cost: ev.avg_cost,
    min_stock: min,
    is_low: !p.is_service && min > 0 && ev.qty <= min,
    is_negative: !p.is_service && ev.qty < 0,
    margin_pct: p.sale_price > 0 ? U.pct(p.sale_price - ev.avg_cost, p.sale_price) : null,
  };
}

function create(companyId, input, user) {
  const p = {
    id: store.uid('prd'),
    company_id: companyId,
    name: U.str(input.name, { max: 160, required: true, field: 'Mahsulot nomi' }),
    sku: U.str(input.sku || '', { max: 40 }),
    barcode: U.str(input.barcode || '', { max: 40 }),
    category: U.str(input.category || '', { max: 60 }),
    unit: UNITS.includes(input.unit) ? input.unit : 'dona',
    purchase_price: U.amount(input.purchase_price || 0),
    sale_price: U.amount(input.sale_price || 0),
    min_stock: Math.max(0, U.num(input.min_stock || 0)),
    warehouse: U.str(input.warehouse || 'Asosiy ombor', { max: 60 }),
    supplier_id: input.supplier_id || null,
    is_service: !!input.is_service,
    vat_rate: input.vat_rate != null ? U.num(input.vat_rate) : null,
    description: U.str(input.description || '', { max: 1000 }),
    status: 'active',
    opening_stock: 0,
    created_at: store.nowISO(),
    created_by: user ? user.id : null,
  };
  if (!p.sku) p.sku = `SKU-${store.nextNumber(`sku_${companyId}`, 5)}`, store.nextSeq(`sku_${companyId}`);
  if (products(companyId).some(x => x.status !== 'archived' && U.norm(x.name) === U.norm(p.name))) {
    throw new ApiError(`«${p.name}» nomli mahsulot allaqachon mavjud.`, 409, 'duplicate_product');
  }
  if (p.barcode && products(companyId).some(x => x.barcode && x.barcode === p.barcode)) {
    throw new ApiError(`Shtrix-kod ${p.barcode} boshqa mahsulotda ishlatilgan.`, 409, 'duplicate_barcode');
  }
  store.collection('products').push(p);
  store.save();
  store.touch(companyId);
  const openingQty = U.num(input.opening_stock || 0);
  if (openingQty > 0 && !p.is_service) {
    receive(companyId, {
      product_id: p.id, qty: openingQty, unit_cost: p.purchase_price || 0, date: U.isValidDate(input.opening_date) ? input.opening_date : U.today(),
      memo: 'Boshlang‘ich qoldiq', type: 'initial', post_to_ledger: true, counter_account: input.opening_account || null,
    }, user);
  }
  require('./audit').log({ company_id: companyId, user, action: 'product.create', entity: 'product', entity_id: p.id, summary: `Mahsulot qo‘shildi: ${p.name}`, after: p });
  return decorate(companyId, findProduct(companyId, p.id));
}

function update(companyId, id, patch, user) {
  const p = findProduct(companyId, id);
  const before = { ...p };
  const fields = ['name', 'sku', 'barcode', 'category', 'unit', 'warehouse', 'description', 'status'];
  for (const f of fields) if (patch[f] !== undefined) p[f] = U.str(patch[f], { max: f === 'description' ? 1000 : 160 });
  for (const f of ['purchase_price', 'sale_price']) if (patch[f] !== undefined) p[f] = U.amount(patch[f]);
  if (patch.min_stock !== undefined) p.min_stock = Math.max(0, U.num(patch.min_stock));
  if (patch.supplier_id !== undefined) p.supplier_id = patch.supplier_id || null;
  if (patch.is_service !== undefined) p.is_service = !!patch.is_service;
  if (patch.vat_rate !== undefined) p.vat_rate = patch.vat_rate == null ? null : U.num(patch.vat_rate);
  p.updated_at = store.nowISO();
  store.save();
  store.touch(companyId);
  require('./audit').log({
    company_id: companyId, user, action: 'product.update', entity: 'product', entity_id: id,
    summary: `Mahsulot tahrirlandi: ${p.name}`, before, after: { ...p },
    meta: { changes: require('./audit').diff(before, p, ['name', 'sku', 'purchase_price', 'sale_price', 'min_stock', 'unit', 'warehouse']) },
  });
  return decorate(companyId, p);
}

/** Ombor kirimi + (ixtiyoriy) buxgalteriya yozuvi */
function receive(companyId, input, user) {
  const qty = U.num(input.qty);
  if (!(qty > 0)) throw new ApiError('Kirim miqdori noldan katta bo‘lishi kerak.', 400, 'invalid_qty');
  return move(companyId, { ...input, type: input.type || 'in', qty }, user);
}

function issue(companyId, input, user) {
  const qty = U.num(input.qty);
  if (!(qty > 0)) throw new ApiError('Chiqim miqdori noldan katta bo‘lishi kerak.', 400, 'invalid_qty');
  return move(companyId, { ...input, type: input.type || 'out', qty }, user);
}

function move(companyId, input, user) {
  const product = findProduct(companyId, input.product_id);
  const type = MOVE_TYPES[input.type] ? input.type : 'in';
  const qty = Math.abs(U.num(input.qty));
  if (!(qty > 0)) throw new ApiError('Miqdor noto‘g‘ri.', 400, 'invalid_qty');
  const date = U.isValidDate(input.date) ? input.date : U.today();
  if (ledger.isPeriodClosed(companyId, U.periodOf(date)) && !input.allow_closed_period) {
    throw new ApiError(`${U.periodLabel(U.periodOf(date))} davri yopilgan — ombor harakati kiritilmaydi.`, 409, 'period_closed');
  }
  const before = evaluate(companyId, product.id);
  const isIn = MOVE_TYPES[type].sign > 0;

  // Chiqimda yetarli qoldiq tekshiruvi (ruxsat berilgan holatlar bundan mustasno)
  if (!isIn && !product.is_service && input.strict_stock !== false && before.qty - qty < 0 && !input.allow_negative) {
    throw new ApiError(
      `«${product.name}» uchun omborda yetarli qoldiq yo‘q: mavjud ${before.qty} ${product.unit}, kerak ${qty} ${product.unit}. ` +
      `Avval kirim qiling yoki inventarizatsiya o‘tkazing.`,
      409, 'insufficient_stock',
      { available: before.qty, requested: qty, product_id: product.id }
    );
  }
  const unitCost = input.unit_cost != null ? U.amount(input.unit_cost) : (isIn ? (U.amount(input.unit_cost || product.purchase_price || 0)) : before.avg_cost);
  const m = {
    id: store.uid('stk'),
    company_id: companyId,
    product_id: product.id,
    product_name: product.name,
    sku: product.sku,
    date,
    period: U.periodOf(date),
    type,
    qty,
    direction: isIn ? 'in' : 'out',
    unit_cost: unitCost,
    total_cost: U.round(qty * unitCost, 0),
    warehouse: U.str(input.warehouse || product.warehouse || 'Asosiy ombor', { max: 60 }),
    party_id: input.party_id || null,
    source: input.source || { type: 'manual', id: null },
    memo: U.str(input.memo || MOVE_TYPES[type].label, { max: 300 }),
    created_by: user ? user.id : null,
    created_at: store.nowISO(),
    entry_id: null,
  };
  store.collection('stockMoves').push(m);
  store.save();
  store.touch(companyId);

  // Buxgalteriya yozuvi: ombor qiymati o'zgarishini jurnalda aks ettirish
  if (input.post_to_ledger !== false && !product.is_service) {
    const inventoryCode = ledger.roleCode(companyId, 'inventory');
    const value = isIn ? U.round(qty * unitCost, 0) : U.round(qty * before.avg_cost, 0);
    if (value > 0) {
      try {
        let counter = input.counter_account;
        if (!counter) {
          if (type === 'initial') counter = ledger.roleCode(companyId, 'equity');
          else if (type === 'in') counter = input.party_id ? ledger.roleCode(companyId, 'ap') : ledger.roleCode(companyId, 'cash');
          else if (type === 'out' && (input.source || {}).type === 'invoice') counter = ledger.roleCode(companyId, 'cos');
          else counter = ledger.roleCode(companyId, 'other_expense');
        }
        const lines = isIn
          ? [{ account: inventoryCode, debit: value, party_id: input.party_id || null, description: `${product.name} kirim (${qty} ${product.unit})`, product_id: product.id, qty },
             { account: counter, credit: value, party_id: input.party_id || null, description: m.memo }]
          : [{ account: counter, debit: value, description: `${product.name} chiqim (${qty} ${product.unit})`, product_id: product.id, qty },
             { account: inventoryCode, credit: value, description: m.memo }];
        const entry = ledger.postEntry(companyId, {
          date, memo: `${MOVE_TYPES[type].label}: ${product.name} — ${qty} ${product.unit}`.slice(0, 400),
          ref: product.sku, lines, source: { type: 'stock_move', id: m.id }, user, allow_closed_period: true,
        });
        m.entry_id = entry.id;
        store.save();
      } catch (e) {
        if (e.code === 'invalid_entry') throw e;
        console.error('[inventory] jurnal yozuvi xatosi:', e.message);
      }
    }
  }
  require('./audit').log({ company_id: companyId, user, action: `stock.${type}`, entity: 'product', entity_id: product.id, summary: `Ombor: ${MOVE_TYPES[type].label} — ${product.name} ${qty} ${product.unit}`, before: { qty: before.qty, value: before.value }, after: { qty: before.qty + (isIn ? qty : -qty) } });
  return { move: m, product: decorate(companyId, findProduct(companyId, product.id)) };
}

/** Inventarizatsiya: haqiqiy qoldiqni kiritish, farqni yozuvda aks ettirish */
function stockAdjust(companyId, { product_id, actual_qty, date, memo, account }, user) {
  const product = findProduct(companyId, product_id);
  const ev = evaluate(companyId, product.id);
  const target = U.num(actual_qty);
  const diff = target - ev.qty;
  if (diff === 0) return { changed: false, product: decorate(companyId, product), diff: 0 };
  const res = move(companyId, {
    product_id, qty: Math.abs(diff), date: date || U.today(),
    type: diff > 0 ? 'adjust_in' : 'adjust_out',
    unit_cost: ev.avg_cost, memo: memo || `Inventarizatsiya: ${ev.qty} → ${target} ${product.unit}`,
    counter_account: account || ledger.roleCode(companyId, 'other_expense'),
    source: { type: 'adjustment', id: null },
  }, user);
  return { changed: true, diff, move: res.move, product: res.product };
}

function stockMoves(companyId, { product_id, from, to, type, limit = 200 } = {}) {
  let rows = moves(companyId);
  if (product_id) rows = rows.filter(m => m.product_id === product_id);
  if (type) rows = rows.filter(m => m.type === type);
  if (from) rows = rows.filter(m => m.date >= from);
  if (to) rows = rows.filter(m => m.date <= to);
  return U.sortBy(rows, m => `${m.date} ${m.created_at}`, 'desc').slice(0, limit);
}

function valuation(companyId) {
  const rows = list(companyId, { active: true }).filter(p => !p.is_service);
  const totalValue = U.sumBy(rows, r => Math.max(0, r.stock_value));
  const totalSkus = rows.length;
  const low = rows.filter(r => r.is_low);
  const negative = rows.filter(r => r.is_negative);
  return {
    total_value: totalValue,
    total_skus: totalSkus,
    total_units: U.sumBy(rows, r => r.stock),
    low_stock: low,
    negative_stock: negative,
    by_category: [...U.groupBy(rows, r => r.category || 'Kategoriyasiz').entries()].map(([category, items]) => ({
      category, value: U.sumBy(items, i => Math.max(0, i.stock_value)), count: items.length,
    })).sort((a, b) => b.value - a.value),
    by_warehouse: [...U.groupBy(rows, r => r.warehouse || 'Asosiy ombor').entries()].map(([warehouse, items]) => ({
      warehouse, value: U.sumBy(items, i => Math.max(0, i.stock_value)), count: items.length,
    })).sort((a, b) => b.value - a.value),
    stock_value_ledger: ledger.roleBalance(companyId, 'inventory'),
  };
}

/** Ombor bo'yicha nazorat: jurnal qiymati va ombor kartochkalari farqi */
function reconciliation(companyId) {
  const v = valuation(companyId);
  const diff = U.round(v.total_value - v.stock_value_ledger, 0);
  return { ...v, ledger_value: v.stock_value_ledger, difference: diff, consistent: Math.abs(diff) < Math.max(1000, v.total_value * 0.01) };
}

/** AI/Radar uchun ombor anomaliyalari */
function anomalies(companyId) {
  const out = [];
  for (const p of list(companyId, { active: true })) {
    if (p.is_service) continue;
    if (p.is_negative) {
      out.push({
        type: 'negative_stock', severity: 'high', product_id: p.id,
        title: 'Manfiy ombor qoldig‘i',
        detail: `«${p.name}» bo‘yicha qoldiq ${p.stock} ${p.unit} — buxgalteriya jihatidan mumkin emas.`,
        impact: Math.abs(p.stock) * (p.avg_cost || p.purchase_price || 0),
        evidence: [{ label: 'Qoldiq', value: `${p.stock} ${p.unit}` }, { label: 'O‘rtacha tannarx', value: U.fmtMoney(p.avg_cost) }],
      });
    } else if (p.is_low) {
      out.push({
        type: 'low_stock', severity: p.stock <= 0 ? 'high' : 'medium', product_id: p.id,
        title: 'Minimum zaxiradan past',
        detail: `«${p.name}» qoldig‘i ${p.stock} ${p.unit}, minimum ${p.min_stock} ${p.unit}.`,
        impact: 0,
        evidence: [{ label: 'Qoldiq', value: `${p.stock} ${p.unit}` }, { label: 'Minimum', value: `${p.min_stock} ${p.unit}` }],
      });
    }
    // Keskin harakat (oxirgi 30 kun o'rtachadan 3 sigma yuqori)
    const ms = movesOf(companyId, p.id).filter(m => m.date >= U.addDays(U.today(), -30));
    const history = U.sortBy(moves(companyId).filter(m => m.product_id === p.id), m => m.date).slice(-60);
    if (history.length >= 8 && ms.length) {
      const sizes = history.filter(m => m.direction === 'in').map(m => m.qty);
      const mean = U.mean(sizes), sd = U.stddev(sizes);
      if (sd > 0) {
        for (const m of ms) {
          const z = (m.qty - mean) / sd;
          if (z >= 3 && m.direction === 'in') {
            out.push({
              type: 'unusual_stock_move', severity: 'low', product_id: p.id, move_id: m.id,
              title: 'Odatiy bo‘lmagan ombor harakati',
              detail: `«${p.name}» uchun ${m.date} sanasida ${m.qty} ${p.unit} kirim qilingan — tarixiy o‘rtacha ${U.round(mean, 1)} ${p.unit}.`,
              impact: U.round(m.qty * (m.unit_cost || 0), 0),
              evidence: [{ label: 'Harakat', value: `${m.qty} ${p.unit}` }, { label: 'O‘rtacha kirim', value: `${U.round(mean, 1)} ${p.unit}` }, { label: 'Zarar (taxminiy)', value: U.fmtMoney(m.qty * (m.unit_cost || 0)) }],
            });
          }
        }
      }
    }
  }
  return out;
}

function categoriesOf(companyId) {
  return U.uniq(products(companyId).map(p => p.category).filter(Boolean)).sort();
}

module.exports = {
  UNITS, MOVE_TYPES, list, create, update, findProduct, tryProduct, decorate, evaluate,
  receive, issue, move, stockMoves, valuation, reconciliation, anomalies, categoriesOf, stockAdjust,
};
