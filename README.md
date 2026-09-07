# BuxAI

O'zbekiston kompaniyalari uchun daromad-xarajat, pul oqimi va AI maslahat platformasi.

## Ishga tushirish

```bash
npm start
# http://localhost:3000
```

## API

- `GET /api/dashboard` — KPI, haftalik oqim va kategoriyalar
- `GET /api/transactions` — tranzaksiyalar
- `POST /api/transactions` — yangi kirim/chiqim
- `GET /api/invoices` — hisob-fakturalar
- `POST /api/ai/chat` — AI moliyaviy maslahatchi

Demo ma'lumotlari `data/db.json` ichida saqlanadi. Ishlab chiqarishda PostgreSQL, auth, audit-log va LLM provider kalitlarini server muhit o'zgaruvchilariga ulang.
