'use strict';

const crypto = require('node:crypto');
const { expect } = require('chai');
const { createPkce, createDpopKey, createDpopProof, parseLoginPage, readJwtClaims } = require('../lib/volvoAuth');

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('volvoAuth', () => {
  it('creates a PKCE S256 challenge matching the verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).to.match(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).to.equal(crypto.createHash('sha256').update(verifier).digest('base64url'));
  });

  it('creates a verifiable ES256 DPoP proof with access token hash', () => {
    const jwk = createDpopKey();
    const proof = createDpopProof(jwk, 'GET', 'https://example.com/resource', 'token123');
    const [h, p, s] = proof.split('.');
    const header = decode(h);
    const payload = decode(p);

    expect(header).to.include({ typ: 'dpop+jwt', alg: 'ES256' });
    expect(header.jwk).to.not.have.property('d');
    expect(payload).to.include({ htm: 'GET', htu: 'https://example.com/resource' });
    expect(payload.ath).to.equal(crypto.createHash('sha256').update('token123').digest('base64url'));

    const publicKey = crypto.createPublicKey({ key: header.jwk, format: 'jwk' });
    const valid = crypto.verify('sha256', Buffer.from(h + '.' + p), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(valid).to.equal(true);
  });

  it('omits ath without access token and uses a fresh jti per proof', () => {
    const jwk = createDpopKey();
    const first = decode(createDpopProof(jwk, 'POST', 'https://example.com/token').split('.')[1]);
    const second = decode(createDpopProof(jwk, 'POST', 'https://example.com/token').split('.')[1]);
    expect(first).to.not.have.property('ath');
    expect(first.jti).to.not.equal(second.jti);
  });

  it('reads page id, action and message from a Keycloak page', () => {
    const html =
      '<script>const kcContext = {"url": {"loginAction": "https://auth.example.com/login-actions/authenticate?session_code=a\\u0026execution=b"},' +
      ' "message": {"summary": "Invalid \\"code\\"", "type": "error"}, "pageId": "login-otp-email"};</script>';
    expect(parseLoginPage(html)).to.deep.equal({
      pageId: 'login-otp-email',
      action: 'https://auth.example.com/login-actions/authenticate?session_code=a&execution=b',
      message: 'Invalid "code"',
    });
  });

  it('returns nulls for pages without kcContext', () => {
    expect(parseLoginPage('<html></html>')).to.deep.equal({ pageId: null, action: null, message: null });
    expect(parseLoginPage(undefined).pageId).to.equal(null);
  });

  it('reads JWT claims and returns null for opaque tokens', () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = enc({ alg: 'HS512' }) + '.' + enc({ iss: 'https://auth.example.com/realms/x', typ: 'Refresh' }) + '.sig';
    expect(readJwtClaims(jwt)).to.include({ iss: 'https://auth.example.com/realms/x', typ: 'Refresh' });
    expect(readJwtClaims('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef')).to.equal(null);
    expect(readJwtClaims('a.!!!.c')).to.equal(null);
    expect(readJwtClaims(undefined)).to.equal(null);
  });
});
