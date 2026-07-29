'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-bilibili-credential-encryption-secret';

const {
  createCookieHeader,
  decryptCredential,
  encryptCredential,
  sanitizeCookieCollection
} = require('./bilibiliCredentialStore');

test('Bilibili credentials use authenticated encryption and reject tampering', () => {
  const credential = {
    cookies: {
      SESSDATA: 'plain-session-secret',
      bili_jct: 'plain-csrf-secret',
      DedeUserID: '123456'
    },
    uid: '123456',
    displayName: 'Test account',
    avatarUrl: 'https://i0.hdslb.com/test-avatar.png'
  };
  const encryptedCredential = encryptCredential(credential);
  assert.equal(encryptedCredential.includes('plain-session-secret'), false);
  assert.equal(encryptedCredential.includes('plain-csrf-secret'), false);
  assert.deepEqual(decryptCredential(encryptedCredential), credential);

  const tamperedCredential = `${encryptedCredential.slice(0, -1)}${encryptedCredential.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(decryptCredential(tamperedCredential), null);
});

test('Bilibili Cookie serialization rejects control characters and injection delimiters', () => {
  const sanitizedCookies = sanitizeCookieCollection({
    SESSDATA: 'valid-session',
    bili_jct: 'valid-csrf',
    malicious: 'value; injected=true',
    lineBreak: 'value\r\nInjected: true',
    'invalid cookie name': 'value'
  });
  assert.deepEqual(sanitizedCookies, {
    SESSDATA: 'valid-session',
    bili_jct: 'valid-csrf'
  });
  assert.equal(
    createCookieHeader(sanitizedCookies),
    'bili_jct=valid-csrf; SESSDATA=valid-session'
  );
});
