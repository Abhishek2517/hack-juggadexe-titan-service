const crypto = require('crypto');
const openpgp = require('openpgp');

const YOPASS_BASE_URL = process.env.YOPASS_BASE_URL || 'https://securelink.titan.email';
const DEFAULT_EXPIRATION_SECONDS = 60 * 60 * 24; // 1 day — long enough for a
// recipient to actually open the email, short enough not to linger forever.

function generatePassphrase() {
  // 24 random bytes, base64url — matches the length/shape of Yopass's own
  // generated decryption keys.
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Encrypts `secretText` client-side-equivalent (PGP symmetric, matching
 * exactly what the Yopass web UI does before it ever calls the API — the
 * plaintext secret never reaches Yopass's server) and stores it, returning
 * a one-click link that decrypts and displays it once.
 */
async function createSecureLink(secretText, expirationSeconds = DEFAULT_EXPIRATION_SECONDS) {
  const passphrase = generatePassphrase();
  const message = await openpgp.createMessage({ text: secretText });
  const encrypted = await openpgp.encrypt({
    message,
    passwords: [passphrase],
    format: 'armored',
  });

  const response = await fetch(`${YOPASS_BASE_URL}/create/secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expiration: expirationSeconds,
      message: encrypted,
      one_time: true,
      receipt: false,
      require_auth: false,
    }),
  });

  if (!response.ok) {
    const err = new Error(`Yopass create/secret failed: ${response.status}`);
    err.code = 'YOPASS_UNAVAILABLE';
    throw err;
  }

  const data = await response.json();
  const secretId = data.message || data.id;
  if (!secretId) {
    const err = new Error('Yopass response missing secret id');
    err.code = 'YOPASS_UNAVAILABLE';
    throw err;
  }

  return `${YOPASS_BASE_URL}/#/s/${secretId}/${passphrase}`;
}

/**
 * Same idea as createSecureLink but for a whole file: the filename travels
 * inside the encrypted OpenPGP literal-data packet itself (openpgp's
 * `filename` option), never as a separate cleartext field, so Yopass's
 * server never learns what the file is called any more than it learns its
 * content. Confirmed against Yopass's own web client (its bundle calls
 * openpgp.createMessage({ binary, filename }) the same way) and its
 * /create/file endpoint, which — unlike /create/secret — takes the
 * encrypted bytes as a raw application/octet-stream body plus two request
 * headers instead of a JSON envelope.
 */
async function createSecureFileLink(
  fileBuffer,
  filename,
  expirationSeconds = DEFAULT_EXPIRATION_SECONDS
) {
  const passphrase = generatePassphrase();
  const message = await openpgp.createMessage({
    binary: new Uint8Array(fileBuffer),
    filename,
  });
  const encrypted = await openpgp.encrypt({
    message,
    passwords: [passphrase],
    format: 'binary',
  });

  const response = await fetch(`${YOPASS_BASE_URL}/create/file`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'X-Yopass-Expiration': String(expirationSeconds),
      'X-Yopass-Onetime': 'true',
    },
    body: Buffer.from(encrypted),
  });

  if (!response.ok) {
    const err = new Error(`Yopass create/file failed: ${response.status}`);
    err.code = 'YOPASS_UNAVAILABLE';
    throw err;
  }

  const data = await response.json();
  const secretId = data.message || data.id;
  if (!secretId) {
    const err = new Error('Yopass response missing secret id');
    err.code = 'YOPASS_UNAVAILABLE';
    throw err;
  }

  return `${YOPASS_BASE_URL}/#/f/${secretId}/${passphrase}`;
}

module.exports = { createSecureLink, createSecureFileLink };
