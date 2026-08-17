# E-TRADE — Automatizare identificare produse

Aplicație reală (server + bază de date), nu doar o pagină HTML: clienții completează un formular
ghidat, cererea se salvează permanent, se trimite automat pe email (dacă e configurat SMTP) și
poate fi replicată automat într-un Google Sheet / Zapier / Make printr-un webhook. Echipa E-TRADE
are un panou intern (`/admin`) cu toate cererile, un instrument de citire text din poze de etichetă
și un tabel de echivalențe între mărci — toate persistate în baza de date, nu doar în sesiunea
browserului.

Scrisă fără nicio dependență externă (doar module native Node.js: `http`, `node:sqlite`, `net`/`tls`
pentru SMTP) — pornește cu `node server.js`, fără `npm install`.

## 1. Ce face automat

- **Formular public** (`/`) — wizard în 4 pași, adaptat pe categorie de produs (mecanic, pneumatic,
  electric, lubrifianți, garnituri, roboți industriali, marcare, scule). La final:
  - salvează cererea în baza de date (SQLite, fișier local `data/etrade.db`);
  - dacă e configurat un cont SMTP, **trimite automat un email** către `office@echychiatrade.ro`
    (sau adresa setată în `NOTIFY_EMAIL`) cu toate detaliile — fără nicio acțiune manuală;
  - dacă e configurat `WEBHOOK_URL`, **trimite automat** aceleași date către Zapier/Make/Google
    Sheets (vezi secțiunea 5);
  - oferă și un link WhatsApp pre-completat, ca variantă suplimentară/manuală.
- **Panou admin** (`/admin`, protejat cu user+parolă) —
  - listă cu toate cererile, căutare, filtrare pe status, schimbare status (nou / în lucru /
    rezolvat), vizualizare poză atașată, acces rapid „Deschide WhatsApp" / „Răspunde pe email";
  - tabel de **cross-reference** (echivalențe între mărci) — editabil, persistat în baza de date,
    nu se pierde la refresh sau la închiderea browserului;
  - instrument de **citire text din poze de etichetă** (OCR, în browser).

## 2. Instalare și pornire

Necesită Node.js 22.5 sau mai nou (pentru `node:sqlite`, inclus nativ). Verifică versiunea instalată:

```bash
node -v
```

Pași:

```bash
cd server
cp .env.example .env
# editează .env: seteaza ADMIN_PASSWORD si, optional, datele SMTP (vezi mai jos)
node server.js
```

Serverul pornește implicit pe portul 3000 (configurabil din `.env`):

- Formular public: `http://localhost:3000/`
- Panou admin: `http://localhost:3000/admin`

Pentru a rula permanent (nu doar în terminal), folosește un manager de procese precum `pm2` sau un
serviciu `systemd` — sau serviciul de hosting ales (vezi secțiunea 4).

## 3. Configurare (fișierul `.env`)

Toate opțiunile sunt documentate în `.env.example`. Cele mai importante:

- `ADMIN_USER` / `ADMIN_PASSWORD` — **obligatoriu de schimbat** — protejează panoul `/admin`.
- `NOTIFY_EMAIL` — adresa la care ajung automat cererile noi (implicit `office@echychiatrade.ro`).
- `WHATSAPP_NUMBER` — numărul folosit pentru linkurile „Trimite pe WhatsApp".
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — contul folosit
  pentru trimiterea automată a emailurilor. Fără aceste date, cererile tot se salvează și apar în
  `/admin`, doar că nu se mai trimite automat emailul (rămâne opțiunea WhatsApp/manuală).
  Funcționează cu orice cont SMTP standard: Gmail (cu „parolă de aplicație"), contul de hosting/
  cPanel al domeniului echychiatrade.ro, sau orice alt furnizor de email.
- `WEBHOOK_URL` — opțional, pentru integrare cu Zapier / Make / Google Sheets (secțiunea 5).

## 4. Unde îl găzduiești

Aplicația e un server Node.js obișnuit — poate rula:

- pe orice hosting cu suport Node.js (Railway, Render, Fly.io, un VPS, sau un plan de hosting
  cPanel cu „Setup Node.js App");
- direct pe un calculator din birou, lăsat pornit (mai puțin recomandat pentru disponibilitate 24/7).

**Notă despre acest mediu de lucru:** aplicația a fost construită și testată complet aici (pornire
server, creare cereri, actualizare status, cross-reference, persistență la restart) — toate
funcționează corect. Accesul la internet din acest mediu e restricționat (nu pot instala pachete
npm noi și nu pot testa efectiv trimiterea unui email real sau apelarea unui webhook real), de-asta
aplicația a fost scrisă fără nicio dependență npm — folosește exclusiv module native Node — și
trimiterea de email/webhook e implementată direct peste protocol (SMTP brut), nu printr-o
bibliotecă netestabilă aici. Le poți testa imediat ce pui datele reale în `.env`, pe orice hosting
cu acces normal la internet.

### Integrare pe echychiatrade.ro

Nu am acces la site-ul/hostingul lor din acest mediu, deci nu îl pot pune live eu direct — ai două
variante simple, în funcție de ce control ai asupra site-ului:

**A. Iframe** (cel mai simplu, fără să atingi codul site-ului): odată ce aplicația rulează la o
adresă publică (ex. `https://identificare.echychiatrade.ro`), adaugi pe orice pagină a site-ului:

```html
<iframe src="https://identificare.echychiatrade.ro" style="width:100%;height:900px;border:0;"></iframe>
```

**B. Reverse proxy pe același domeniu** (ca formularul să apară la o adresă de tipul
`echychiatrade.ro/identificare`), dacă site-ul rulează pe un server cu Nginx sau Apache — necesită
acces la configurația serverului web al site-ului. Exemplu Nginx:

```nginx
location /identificare/ {
    proxy_pass http://localhost:3000/;
}
```

## 5. Conectare la Google Sheets / Zapier / Make

Setează `WEBHOOK_URL` în `.env` cu link-ul primit de la unul dintre aceste servicii — la fiecare
cerere nouă, sistemul trimite automat un `POST` cu toate datele, în format JSON:

- **Zapier**: creează un Zap cu trigger „Webhooks by Zapier → Catch Hook", copiază URL-ul generat.
- **Make (Integromat)**: creează un scenariu cu modul „Webhooks → Custom webhook", copiază URL-ul.
- **Google Sheets direct**: publică un Google Apps Script ca „Web App" care primește `POST` și
  scrie un rând nou în sheet, apoi pune acel URL în `WEBHOOK_URL`.

## 6. Structura proiectului

```
server/
  server.js          serverul HTTP + toate rutele API
  lib/db.js          baza de date SQLite (tabele + conexiune)
  lib/smtp.js        client SMTP minimal (trimitere email fara dependente)
  lib/auth.js        protectie Basic Auth pentru /admin
  lib/env.js         citire fisier .env
  public/index.html  formularul public (wizard identificare)
  public/admin.html  panoul intern (cereri, OCR, cross-reference)
  data/etrade.db      (se creeaza automat la prima pornire — baza de date)
  uploads/            (se creeaza automat — pozele atasate cererilor)
  .env.example        sablon de configurare
```

## 7. Limite cunoscute

- Recunoașterea de text din poze (OCR) rulează direct în browser și încarcă o librărie de la
  `cdnjs.cloudflare.com` — necesită ca rețeaua/browserul folosit să permită acest acces; dacă e
  blocat, instrumentul afișează clar acest lucru și rămâne opțiunea de introducere manuală a
  codului.
- Panoul `/admin` folosește HTTP Basic Auth — suficient pentru un instrument intern cu câțiva
  utilizatori, dar rulează aplicația **doar sub HTTPS** în producție (majoritatea platformelor de
  hosting oferă asta automat) ca parola să nu circule necriptat.
