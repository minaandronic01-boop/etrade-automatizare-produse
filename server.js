'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const { loadEnv } = require('./lib/env');
loadEnv();

const db = require('./lib/db');
const { sendMail } = require('./lib/smtp');
const { requireAdmin } = require('./lib/auth');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'office@echychiatrade.ro';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '40724306364';

// ---------- utilitare ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { sendJson(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Payload prea mare')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('JSON invalid')); }
    });
    req.on('error', reject);
  });
}

function saveDataUrlPhoto(id, dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const ext = (match[1].split('/')[1] || 'jpg').split('+')[0];
  const buf = Buffer.from(match[2], 'base64');
  const filePath = path.join(UPLOAD_DIR, `req-${id}.${ext}`);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function postWebhook(url, payload) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'http:' ? http : https;
      const body = JSON.stringify(payload);
      const req = lib.request(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
      req.on('error', () => resolve(false));
      req.write(body);
      req.end();
    } catch (e) { resolve(false); }
  });
}

function categoryLabels() {
  return {
    mecanic: 'Piese mecanice (rulmenti, transmisii, ghidaje, cuplaje)',
    pneumatic: 'Componente pneumatice',
    electric: 'Electrice & senzori',
    lubrifianti: 'Lubrifianti & uleiuri',
    garnituri: 'Garnituri & etansari',
    roboti: 'Piese de schimb pentru roboti industriali',
    marcare: 'Marcare industriala',
    scule: 'Scule industriale & echipamente de asamblare',
    altele: 'Alta categorie / nu sunt sigur',
  };
}

function buildSummaryText(row) {
  const campuri = JSON.parse(row.campuri_json || '{}');
  const lines = [];
  lines.push('CERERE IDENTIFICARE PRODUS -- E-TRADE');
  lines.push('');
  lines.push('Nr. cerere: #' + row.id);
  lines.push('Companie: ' + (row.companie || '-'));
  lines.push('Persoana contact: ' + (row.contact || '-'));
  lines.push('Telefon: ' + (row.telefon || '-'));
  if (row.email) lines.push('Email: ' + row.email);
  lines.push('Urgenta: ' + (row.urgenta || 'Normal'));
  lines.push('');
  lines.push('Categorie: ' + (categoryLabels()[row.categorie] || row.categorie));
  Object.entries(campuri).forEach(([k, v]) => { if (v) lines.push(k + ': ' + v); });
  if (row.cod) lines.push('Cod/referinta cunoscuta: ' + row.cod);
  if (row.descriere) lines.push('Descriere: ' + row.descriere);
  if (row.foto_path) lines.push('(are poza atasata in sistem)');
  return lines.join('\n');
}

// ---------- rute API ----------

async function handleCreateRequest(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }

  const { companie, contact, telefon, email, urgenta, categorie, campuri, cod, descriere, fotoDataUrl } = body;

  if (!categorie) return sendJson(res, 400, { error: 'Campul "categorie" este obligatoriu.' });
  if (!telefon && !email) return sendJson(res, 400, { error: 'Este necesar cel putin un telefon sau un email de contact.' });

  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO requests
    (created_at, companie, contact, telefon, email, urgenta, categorie, campuri_json, cod, descriere, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nou')`);
  const info = ins.run(now, companie || '', contact || '', telefon || '', email || '', urgenta || 'Normal', categorie, JSON.stringify(campuri || {}), cod || '', descriere || '');
  const id = Number(info.lastInsertRowid);

  let fotoPath = null;
  if (fotoDataUrl) {
    try { fotoPath = saveDataUrlPhoto(id, fotoDataUrl); } catch (e) { /* ignoram, cererea tot se salveaza */ }
    if (fotoPath) db.prepare('UPDATE requests SET foto_path = ? WHERE id = ?').run(fotoPath, id);
  }

  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  const summaryText = buildSummaryText(row);

  // Trimitere automata de email, daca exista configuratie SMTP.
  let emailTrimis = false, emailEroare = null;
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      await sendMail({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: NOTIFY_EMAIL,
        subject: `Cerere noua identificare produs #${id} - ${companie || 'client'}`,
        text: summaryText,
      });
      emailTrimis = true;
    } catch (e) {
      emailEroare = e.message;
    }
  }
  db.prepare('UPDATE requests SET email_trimis = ?, email_eroare = ? WHERE id = ?').run(emailTrimis ? 1 : 0, emailEroare, id);

  // Webhook optional (Zapier / Make / Google Sheets prin "Catch Hook").
  let webhookTrimis = false;
  if (process.env.WEBHOOK_URL) {
    webhookTrimis = await postWebhook(process.env.WEBHOOK_URL, {
      id, companie, contact, telefon, email, urgenta, categorie, campuri, cod, descriere, createdAt: now, summaryText,
    });
    db.prepare('UPDATE requests SET webhook_trimis = ? WHERE id = ?').run(webhookTrimis ? 1 : 0, id);
  }

  const whatsappLink = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(summaryText)}`;

  sendJson(res, 201, { ok: true, id, emailTrimis, emailEroare, webhookTrimis, whatsappLink, summaryText });
}

function handleListRequests(req, res, query) {
  if (!requireAdmin(req, res)) return;
  let rows;
  if (query.q) {
    const like = `%${query.q}%`;
    rows = db.prepare(`SELECT * FROM requests WHERE companie LIKE ? OR contact LIKE ? OR cod LIKE ? OR descriere LIKE ? ORDER BY id DESC`).all(like, like, like, like);
  } else if (query.status) {
    rows = db.prepare('SELECT * FROM requests WHERE status = ? ORDER BY id DESC').all(query.status);
  } else {
    rows = db.prepare('SELECT * FROM requests ORDER BY id DESC').all();
  }
  rows.forEach(r => { r.campuri = JSON.parse(r.campuri_json || '{}'); delete r.campuri_json; r.are_foto = !!r.foto_path; delete r.foto_path; });
  sendJson(res, 200, rows);
}

function handleGetRequest(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  if (!row) return sendJson(res, 404, { error: 'not found' });
  row.campuri = JSON.parse(row.campuri_json || '{}');
  delete row.campuri_json;
  row.are_foto = !!row.foto_path;
  sendJson(res, 200, row);
}

async function handleUpdateStatus(req, res, id) {
  if (!requireAdmin(req, res)) return;
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const allowed = ['nou', 'in lucru', 'rezolvat'];
  if (!allowed.includes(body.status)) return sendJson(res, 400, { error: 'Status invalid. Valori permise: ' + allowed.join(', ') });
  const info = db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(body.status, id);
  if (info.changes === 0) return sendJson(res, 404, { error: 'not found' });
  sendJson(res, 200, { ok: true });
}

function handleGetPhoto(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const row = db.prepare('SELECT foto_path FROM requests WHERE id = ?').get(id);
  if (!row || !row.foto_path || !fs.existsSync(row.foto_path)) return sendJson(res, 404, { error: 'no photo' });
  const ext = path.extname(row.foto_path).slice(1);
  serveFile(res, row.foto_path, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
}

function handleListXref(req, res) {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare('SELECT * FROM xref ORDER BY id ASC').all();
  sendJson(res, 200, rows);
}

async function handleCreateXref(req, res) {
  if (!requireAdmin(req, res)) return;
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO xref (categorie, cod_intern, eq1, eq2, eq3, observatii, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(body.categorie || '', body.cod_intern || '', body.eq1 || '', body.eq2 || '', body.eq3 || '', body.observatii || '', now);
  sendJson(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
}

async function handleUpdateXref(req, res, id) {
  if (!requireAdmin(req, res)) return;
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const now = new Date().toISOString();
  const info = db.prepare(`UPDATE xref SET categorie=?, cod_intern=?, eq1=?, eq2=?, eq3=?, observatii=?, updated_at=? WHERE id=?`)
    .run(body.categorie || '', body.cod_intern || '', body.eq1 || '', body.eq2 || '', body.eq3 || '', body.observatii || '', now, id);
  if (info.changes === 0) return sendJson(res, 404, { error: 'not found' });
  sendJson(res, 200, { ok: true });
}

function handleDeleteXref(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const info = db.prepare('DELETE FROM xref WHERE id = ?').run(id);
  if (info.changes === 0) return sendJson(res, 404, { error: 'not found' });
  sendJson(res, 200, { ok: true });
}

// ---------- server HTTP + rutare ----------

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams.entries());

  try {
    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (req.method === 'GET' && pathname === '/') {
      return serveFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && pathname === '/admin') {
      if (!requireAdmin(req, res)) return;
      return serveFile(res, path.join(__dirname, 'public', 'admin.html'), 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && pathname === '/api/requests') {
      return await handleCreateRequest(req, res);
    }

    if (req.method === 'GET' && pathname === '/api/admin/requests') {
      return handleListRequests(req, res, query);
    }

    let m;
    if (req.method === 'GET' && (m = pathname.match(/^\/api\/admin\/requests\/(\d+)$/))) {
      return handleGetRequest(req, res, Number(m[1]));
    }
    if (req.method === 'PATCH' && (m = pathname.match(/^\/api\/admin\/requests\/(\d+)$/))) {
      return await handleUpdateStatus(req, res, Number(m[1]));
    }
    if (req.method === 'GET' && (m = pathname.match(/^\/api\/admin\/requests\/(\d+)\/foto$/))) {
      return handleGetPhoto(req, res, Number(m[1]));
    }

    if (req.method === 'GET' && pathname === '/api/admin/xref') {
      return handleListXref(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/admin/xref') {
      return await handleCreateXref(req, res);
    }
    if (req.method === 'PUT' && (m = pathname.match(/^\/api\/admin\/xref\/(\d+)$/))) {
      return await handleUpdateXref(req, res, Number(m[1]));
    }
    if (req.method === 'DELETE' && (m = pathname.match(/^\/api\/admin\/xref\/(\d+)$/))) {
      return handleDeleteXref(req, res, Number(m[1]));
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Eroare interna: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`E-TRADE identificare produse - server pornit pe http://localhost:${PORT}`);
  console.log(`  Formular public:  http://localhost:${PORT}/`);
  console.log(`  Panou admin:      http://localhost:${PORT}/admin  (user: ${process.env.ADMIN_USER || 'admin'})`);
  if (!process.env.ADMIN_PASSWORD) console.log('  ATENTIE: ADMIN_PASSWORD nu e setat in .env — panoul admin va raspunde cu eroare pana il configurati.');
  if (!process.env.SMTP_HOST) console.log('  Info: SMTP neconfigurat -> emailurile automate sunt dezactivate (cererile tot se salveaza).');
});

module.exports = server;
