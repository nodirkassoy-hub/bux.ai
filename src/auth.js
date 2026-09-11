'use strict';
/**
 * BUXAI — autentifikatsiya, rollar va ruxsatlar.
 * Barcha tekshiruvlar SERVER tomonida bajariladi (frontendga ishonilmaydi).
 */
const crypto = require('crypto');
const store = require('./store');
const U = require('./util');
const { ApiError } = U;

const SESSION_TTL_HOURS = Number(process.env.BUXAI_SESSION_HOURS || 24 * 14);
const COOKIE = 'buxai_session';

const ROLES = {
  superadmin: {
    key: 'superadmin', label: 'SuperAdmin', label_ru: 'Супер-админ',
    description: 'Platforma darajasidagi boshqaruv',
    permissions: ['*'],
  },
  director: {
    key: 'director', label: 'Rahbar', label_ru: 'Директор',
    description: 'Moliyaviy axborotni ko‘radi, muhim amallarni tasdiqlaydi',
    permissions: [
      'company.view', 'dashboard.view', 'transactions.view', 'transactions.create', 'transactions.edit',
      'invoices.view', 'invoices.manage', 'bills.view', 'bills.manage', 'payments.manage', 'parties.view',
      'parties.manage', 'products.view', 'products.manage', 'inventory.view', 'banking.view', 'banking.manage',
      'reconciliation.view', 'reconciliation.manage', 'documents.view', 'documents.manage', 'reports.view',
      'reports.export', 'ai.use', 'radar.view', 'radar.resolve', 'approvals.view', 'approvals.approve',
      'audit.view', 'users.view', 'users.manage', 'settings.manage', 'close.manage', 'tax.view', 'tax.manage',
      'subscription.manage', 'goals.manage', 'notifications.manage', 'companies.create',
    ],
  },
  accountant: {
    key: 'accountant', label: 'Buxgalter', label_ru: 'Бухгалтер',
    description: 'Operatsiyalar, hisob-fakturalar va hisobotlar bilan ishlaydi',
    permissions: [
      'company.view', 'dashboard.view', 'transactions.view', 'transactions.create', 'transactions.edit',
      'transactions.reverse', 'invoices.view', 'invoices.manage', 'bills.view', 'bills.manage', 'payments.manage',
      'parties.view', 'parties.manage', 'products.view', 'products.manage', 'inventory.view', 'inventory.manage',
      'banking.view', 'banking.manage', 'reconciliation.view', 'reconciliation.manage', 'documents.view',
      'documents.manage', 'reports.view', 'reports.export', 'ai.use', 'radar.view', 'radar.resolve',
      'approvals.view', 'audit.view', 'users.view', 'close.manage', 'tax.view', 'tax.manage', 'goals.manage',
      'notifications.manage',
    ],
  },
  employee: {
    key: 'employee', label: 'Xodim', label_ru: 'Сотрудник',
    description: 'Xarajatlarni kiritadi va tasdiqlashga yuboradi',
    permissions: [
      'company.view', 'dashboard.view', 'transactions.view', 'transactions.create', 'documents.view',
      'documents.manage', 'ai.use', 'notifications.manage',
    ],
  },
};

const ROLE_LIST = Object.values(ROLES).map(r => ({ key: r.key, label: r.label, label_ru: r.label_ru, description: r.description, permissions: r.permissions }));

function permissionsFor(role) { return (ROLES[role] || ROLES.employee).permissions; }

function can(user, permission, companyId = null) {
  if (!user) return false;
  if (user.is_platform_admin) return true;
  const role = companyId ? roleInCompany(user, companyId) : user.role;
  if (!role) return false;
  const perms = permissionsFor(role);
  return perms.includes('*') || perms.includes(permission);
}

function requirePermission(user, permission, companyId = null) {
  if (!can(user, permission, companyId)) {
    throw new ApiError('Bu amal uchun sizda ruxsat yo‘q.', 403, 'forbidden', { permission });
  }
}

/**
 * Ruxsatni "istalgan kompaniya kontekstida" tekshirish.
 * Kompaniyasi yo'q foydalanuvchi birinchi kompaniyasini yaratishi mumkin.
 */
function canAnywhere(user, permission) {
  if (!user) return false;
  if (user.is_platform_admin) return true;
  const list = companiesFor(user);
  if (!list.length) return true;
  return list.some(c => can(user, permission, c.id));
}

function roleInCompany(user, companyId) {
  if (!user) return null;
  if (user.is_platform_admin) return 'superadmin';
  const m = store.collection('memberships').find(x => x.user_id === user.id && x.company_id === companyId && x.status !== 'removed');
  return m ? m.role : null;
}

// ─────────────────────────── Parollar va sessiyalar ─────────────────────────

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const iterations = 120000;
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, iter, salt, hash] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const test = crypto.pbkdf2Sync(String(password), salt, Number(iter), 32, 'sha256').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

function validatePasswordStrength(pw) {
  const s = String(pw || '');
  if (s.length < 8) throw new ApiError('Parol kamida 8 belgidan iborat bo‘lishi kerak.', 400, 'weak_password');
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw new ApiError('Parolda kamida bitta harf va bitta raqam bo‘lishi kerak.', 400, 'weak_password');
  return true;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id, name: user.name, email: user.email, phone: user.phone || '',
    role: user.role, is_platform_admin: !!user.is_platform_admin,
    avatar: (user.name || '').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(),
    locale: user.locale || 'uz', created_at: user.created_at, last_login_at: user.last_login_at || null,
    status: user.status || 'active',
  };
}

function createUser({ name, email, password, role = 'accountant', is_platform_admin = false, phone = '', locale = 'uz' }) {
  const mail = U.str(email, { max: 160, required: true, field: 'Email' }).toLowerCase();
  if (!U.isEmail(mail)) throw new ApiError('Email manzil noto‘g‘ri.', 400, 'invalid_email');
  if (store.collection('users').some(u => u.email === mail)) throw new ApiError('Bu email allaqachon ro‘yxatdan o‘tgan.', 409, 'email_taken');
  validatePasswordStrength(password);
  if (!ROLES[role] && !is_platform_admin) throw new ApiError('Rol noto‘g‘ri.', 400, 'invalid_role');
  const user = {
    id: store.uid('usr'),
    name: U.str(name, { max: 120, required: true, field: 'Ism' }),
    email: mail, phone: U.str(phone, { max: 30 }),
    password_hash: hashPassword(password),
    role: ROLES[role] ? role : 'accountant',
    is_platform_admin: !!is_platform_admin,
    status: 'active', locale,
    created_at: store.nowISO(),
  };
  store.collection('users').push(user);
  store.save();
  return user;
}

function findUser(id) { return store.collection('users').find(u => u.id === id) || null; }
function findUserByEmail(email) { return store.collection('users').find(u => u.email === String(email || '').toLowerCase()) || null; }

function login(email, password, { ip = '', agent = '' } = {}) {
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new ApiError('Email yoki parol xato.', 401, 'invalid_credentials');
  }
  if (user.status === 'blocked') throw new ApiError('Hisob bloklangan. Administratorga murojaat qiling.', 403, 'blocked');
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    id: store.uid('sess'), token, user_id: user.id,
    created_at: store.nowISO(),
    expires_at: new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString(),
    ip: String(ip).slice(0, 60), agent: String(agent).slice(0, 160),
  };
  store.collection('sessions').push(session);
  user.last_login_at = store.nowISO();
  store.save();
  return { token, user };
}

function logout(token) {
  const col = store.collection('sessions');
  const i = col.findIndex(s => s.token === token);
  if (i >= 0) col.splice(i, 1);
  store.save();
}

function userFromToken(token) {
  if (!token) return null;
  const s = store.collection('sessions').find(x => x.token === token);
  if (!s) return null;
  if (s.expires_at < store.nowISO()) {
    const col = store.collection('sessions');
    const i = col.findIndex(x => x.token === token);
    if (i >= 0) col.splice(i, 1);
    store.save();
    return null;
  }
  const user = findUser(s.user_id);
  if (!user || user.status === 'blocked') return null;
  return { user, session: s };
}

function cleanupSessions() {
  const col = store.collection('sessions');
  const now = store.nowISO();
  const before = col.length;
  for (let i = col.length - 1; i >= 0; i--) if (col[i].expires_at < now) col.splice(i, 1);
  if (col.length !== before) store.save();
}

/** Foydalanuvchi a'zo bo'lgan kompaniyalar */
function companiesFor(user) {
  if (user.is_platform_admin) return store.collection('companies').filter(c => c.status !== 'archived');
  const ids = new Set(store.collection('memberships').filter(m => m.user_id === user.id && m.status !== 'removed').map(m => m.company_id));
  return store.collection('companies').filter(c => ids.has(c.id) && c.status !== 'archived');
}

function requireCompanyAccess(user, companyId) {
  const company = store.collection('companies').find(c => c.id === companyId);
  if (!company) throw new ApiError('Kompaniya topilmadi.', 404, 'company_not_found');
  if (user.is_platform_admin) return { company, role: 'superadmin' };
  const role = roleInCompany(user, companyId);
  if (!role) throw new ApiError('Bu kompaniya ma’lumotlariga kirish huquqingiz yo‘q.', 403, 'company_forbidden');
  return { company, role };
}

function addMembership(userId, companyId, role = 'accountant') {
  if (!ROLES[role]) throw new ApiError('Rol noto‘g‘ri.', 400, 'invalid_role');
  const exists = store.collection('memberships').find(m => m.user_id === userId && m.company_id === companyId);
  if (exists) { exists.role = role; exists.status = 'active'; store.save(); return exists; }
  const m = { id: store.uid('mem'), user_id: userId, company_id: companyId, role, status: 'active', created_at: store.nowISO() };
  store.collection('memberships').push(m);
  store.save();
  return m;
}

function membersOf(companyId) {
  return store.collection('memberships')
    .filter(m => m.company_id === companyId && m.status !== 'removed')
    .map(m => ({ ...m, user: publicUser(findUser(m.user_id)) }))
    .filter(m => m.user);
}

module.exports = {
  ROLES, ROLE_LIST, COOKIE, SESSION_TTL_HOURS,
  can, canAnywhere, requirePermission, roleInCompany, permissionsFor,
  hashPassword, verifyPassword, validatePasswordStrength, createUser, findUser, findUserByEmail,
  login, logout, userFromToken, cleanupSessions, companiesFor, requireCompanyAccess, addMembership,
  membersOf, publicUser,
};
