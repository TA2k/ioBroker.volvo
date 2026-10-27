'use strict';

const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * PKCE (RFC 7636) verifier and S256 challenge.
 */
function createPkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * New EC P-256 private key as JWK, used to sign DPoP proofs.
 */
function createDpopKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ format: 'jwk' });
}

/**
 * DPoP proof JWT (RFC 9449) for one request, signed with ES256.
 */
function createDpopProof(jwk, htm, htu, accessToken) {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
  const payload = { htm, htu, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() };
  if (accessToken) {
    payload.ath = b64url(crypto.createHash('sha256').update(accessToken).digest());
  }
  const input = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return input + '.' + b64url(signature);
}

function readKcString(html, key) {
  const match = new RegExp('"' + key + '":\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(html);
  if (!match) return null;
  try {
    return JSON.parse('"' + match[1] + '"');
  } catch {
    return match[1];
  }
}

/**
 * Read page id, form action and error message from the kcContext of a Keycloak login page.
 */
function parseLoginPage(html) {
  const text = String(html || '');
  return {
    pageId: readKcString(text, 'pageId'),
    action: readKcString(text, 'loginAction'),
    message: readKcString(text, 'summary'),
  };
}

module.exports = { createPkce, createDpopKey, createDpopProof, parseLoginPage };
