'use strict';
const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Middleware simplu de HTTP Basic Auth pentru rutele /admin si /api/admin/*.
function requireAdmin(req, res) {
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ADMIN_PASSWORD nu este configurat in .env — vezi README.md' }));
    return false;
  }
  const header = req.headers['authorization'] || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="E-TRADE admin"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Autentificare necesara');
    return false;
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sepIdx = decoded.indexOf(':');
  const gotUser = decoded.slice(0, sepIdx);
  const gotPass = decoded.slice(sepIdx + 1);
  if (!timingSafeEqualStr(gotUser, user) || !timingSafeEqualStr(gotPass, pass)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="E-TRADE admin"', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Date de autentificare incorecte');
    return false;
  }
  return true;
}

module.exports = { requireAdmin };
