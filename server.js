const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC = path.join(ROOT, 'public');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const initial = {
  transactions: [
    { id:'t1', type:'income', title:'Toshkent Coffee — abonement', category:'Savdo', amount:18500000, date:'2026-09-07', account:'Asosiy hisob', status:'Kirim' },
    { id:'t2', type:'expense', title:'Ijara to‘lovi', category:'Ofis', amount:7200000, date:'2026-09-06', account:'Asosiy hisob', status:'Chiqim' },
    { id:'t3', type:'income', title:'Navoiy Logistics', category:'Xizmatlar', amount:12300000, date:'2026-09-05', account:'Asosiy hisob', status:'Kirim' },
    { id:'t4', type:'expense', title:'Xodimlar maoshi', category:'Ish haqi', amount:15600000, date:'2026-09-04', account:'Ish haqi hisobi', status:'Chiqim' },
    { id:'t5', type:'expense', title:'Google Ads kampaniyasi', category:'Marketing', amount:2450000, date:'2026-09-03', account:'Visa Business', status:'Chiqim' },
    { id:'t6', type:'income', title:'Digital Solutions LLC', category:'Savdo', amount:8900000, date:'2026-09-02', account:'Asosiy hisob', status:'Kirim' }
  ],
  invoices: [
    { id:'INV-1042', customer:'Toshkent Coffee', amount:18500000, due:'2026-09-12', state:'To‘lanmagan' },
    { id:'INV-1041', customer:'Navoiy Logistics', amount:12300000, due:'2026-09-05', state:'To‘langan' },
    { id:'INV-1040', customer:'Digital Solutions LLC', amount:8900000, due:'2026-08-30', state:'To‘langan' }
  ]
};
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
function readDB() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function send(res, code, body, type='application/json') { res.writeHead(code, {'Content-Type': type, 'Access-Control-Allow-Origin':'*'}); res.end(type.includes('json') ? JSON.stringify(body) : body); }
function body(req) { return new Promise((resolve, reject) => { let raw=''; req.on('data', c => raw += c); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch(e) { reject(e); } }); }); }
function money(n) { return new Intl.NumberFormat('uz-UZ').format(n) + ' so‘m'; }
function dashboard() {
  const db=readDB(), income=db.transactions.filter(x=>x.type==='income').reduce((a,x)=>a+x.amount,0), expense=db.transactions.filter(x=>x.type==='expense').reduce((a,x)=>a+x.amount,0);
  const categories={}; db.transactions.filter(x=>x.type==='expense').forEach(x=>categories[x.category]=(categories[x.category]||0)+x.amount);
  return { balance: 84250000 + income-expense, income, expense, profit:income-expense, receivable:db.invoices.filter(x=>x.state!=='To‘langan').reduce((a,x)=>a+x.amount,0), categories, flow:[5200000,7400000,6100000,9800000,13200000,16800000,20500000] };
}
function aiAnswer(message) {
  const q=message.toLowerCase(), d=dashboard();
  if (q.includes('xarajat') || q.includes('kamaytir')) return `Xarajatlaringiz ${money(d.expense)}. Eng katta yo‘nalishlarni tekshirishni tavsiya qilaman: ish haqi va ofis xarajatlari. Marketingni natija bo‘yicha ajrating — ROI 2x dan past kampaniyalarni optimallashtiring. Har bir bo‘lim uchun oylik limit qo‘ying.`;
  if (q.includes('foyda') || q.includes('daromad')) return `Joriy davrda sof natija ${money(d.profit)}. Foyda marjasi ${Math.round(d.profit / Math.max(d.income,1)*100)}%. Kechiktirilgan ${money(d.receivable)} so‘mni undirish balansingizni yaxshilaydi.`;
  if (q.includes('soliq') || q.includes('hisobot')) return `Soliq hisobotiga tayyorlanish uchun kirim-chiqimlarni hujjatlar bilan bog‘lang, QQS va ish haqi reyestrlarini alohida yuriting. Buxgalteringiz bilan deklaratsiya sanalarini BuxAI kalendariga kiriting.`;
  return `Tushundim. Hozirgi balansingiz ${money(d.balance)}, kirim ${money(d.income)} va chiqim ${money(d.expense)}. Men sizga pul oqimini prognozlash, xarajatlarni tahlil qilish va to‘lov muddatlarini nazorat qilishda yordam beraman. Aniqroq maslahat uchun “xarajatlarni qanday kamaytiraman?” deb so‘rashingiz mumkin.`;
}
async function api(req,res,url) {
  if (req.method==='GET' && url==='/api/dashboard') return send(res,200,dashboard());
  if (req.method==='GET' && url==='/api/transactions') return send(res,200,readDB().transactions);
  if (req.method==='GET' && url==='/api/invoices') return send(res,200,readDB().invoices);
  if (req.method==='POST' && url==='/api/transactions') { const b=await body(req); const item={id:crypto.randomUUID(), type:b.type||'expense', title:b.title||'Yangi operatsiya', category:b.category||'Boshqa', amount:Number(b.amount)||0, date:b.date||new Date().toISOString().slice(0,10), account:b.account||'Asosiy hisob', status:b.type==='income'?'Kirim':'Chiqim'}; const db=readDB(); db.transactions.unshift(item); writeDB(db); return send(res,201,item); }
  if (req.method==='POST' && url==='/api/ai/chat') { const b=await body(req); return send(res,200,{reply:aiAnswer(b.message||'')}); }
  send(res,404,{error:'Topilmadi'});
}
const server=http.createServer(async (req,res)=>{ const url=(req.url||'/').split('?')[0]; if(req.method==='OPTIONS'){res.writeHead(204);return res.end();} if(url.startsWith('/api/')) { try{return await api(req,res,url)}catch(e){return send(res,400,{error:e.message})} } let file=url==='/'?'/index.html':url; const target=path.normalize(path.join(PUBLIC,file)); if(!target.startsWith(PUBLIC)){return send(res,403,'Forbidden','text/plain')} fs.readFile(target,(err,data)=>{if(err)return send(res,404,'Not found','text/plain');const ext=path.extname(target);const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'};send(res,200,data,types[ext]||'application/octet-stream')}); });
server.listen(PORT,'0.0.0.0',()=>console.log(`BuxAI server http://0.0.0.0:${PORT}`));
