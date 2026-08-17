// Client SMTP minimal, scris folosind doar modulele native Node (net/tls),
// fara nicio dependenta externa (npm nu e disponibil in mediul de build).
// Suporta SMTPS (port 465, TLS implicit) si STARTTLS (ex. port 587) + AUTH LOGIN.
'use strict';
const net = require('net');
const tls = require('tls');

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

class SmtpError extends Error {}

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    function onData(chunk) {
      buf += chunk.toString('utf8');
      // O comanda SMTP se poate intinde pe mai multe linii: "250-..." apoi "250 ..."
      const lines = buf.split(/\r\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: parseInt(last.slice(0, 3), 10), lines, raw: buf });
      }
    }
    function onError(err) { cleanup(); reject(err); }
    function onClose() { cleanup(); reject(new SmtpError('Conexiune inchisa neasteptat de server')); }
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

async function sendCommand(socket, command, expectedCodes) {
  if (command !== null) socket.write(command + '\r\n');
  const res = await readResponse(socket);
  if (expectedCodes && !expectedCodes.includes(res.code)) {
    throw new SmtpError(`Raspuns SMTP neasteptat la "${command}": ${res.raw.trim()}`);
  }
  return res;
}

/**
 * Trimite un email folosind un cont SMTP.
 * @param {object} opts
 *  host, port, secure (true=SMTPS implicit TLS), user, pass, from, to, subject, text
 */
async function sendMail(opts) {
  const { host, port, secure, user, pass, from, to, subject, text } = opts;
  if (!host || !port || !user || !pass || !from || !to) {
    throw new SmtpError('Configuratie SMTP incompleta (host/port/user/pass/from/to)');
  }

  let socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });

  await new Promise((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });

  await readResponse(socket); // banner 220

  await sendCommand(socket, `EHLO ${host}`, [250]);

  if (!secure) {
    await sendCommand(socket, 'STARTTLS', [220]);
    const plainSocket = socket;
    socket = tls.connect({ socket: plainSocket, host, servername: host });
    await new Promise((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    await sendCommand(socket, `EHLO ${host}`, [250]);
  }

  await sendCommand(socket, 'AUTH LOGIN', [334]);
  await sendCommand(socket, b64(user), [334]);
  await sendCommand(socket, b64(pass), [235]);

  await sendCommand(socket, `MAIL FROM:<${from}>`, [250]);
  await sendCommand(socket, `RCPT TO:<${to}>`, [250, 251]);
  await sendCommand(socket, 'DATA', [354]);

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ].join('\r\n');

  // Dublarea punctelor de la inceput de linie ("dot-stuffing"), cerinta protocolului SMTP.
  const bodyEscaped = text.replace(/\r\n/g, '\n').split('\n').map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n');

  const message = `${headers}\r\n\r\n${bodyEscaped}\r\n.`;
  await sendCommand(socket, message, [250]);

  await sendCommand(socket, 'QUIT', [221]).catch(() => {});
  socket.end();
}

module.exports = { sendMail, SmtpError };
