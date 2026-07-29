'use strict';

const crypto = require('crypto');
const { getDb } = require('./database');

const BILIBILI_SECRET_KEY = 'bilibili_session';
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const MAX_COOKIE_VALUE_LENGTH = 16384;

function deriveEncryptionKey() {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET is required for Bilibili credential encryption');
  return crypto
    .createHash('sha256')
    .update(`${jwtSecret}:haven-bilibili-session`)
    .digest();
}

function encryptCredential(credential) {
  const initializationVector = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveEncryptionKey(), initializationVector);
  const plaintext = JSON.stringify(credential);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  return [
    initializationVector.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64')
  ].join('.');
}

function decryptCredential(encryptedValue) {
  if (typeof encryptedValue !== 'string') return null;
  const encryptedParts = encryptedValue.split('.');
  if (encryptedParts.length !== 3) return null;

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveEncryptionKey(),
      Buffer.from(encryptedParts[0], 'base64')
    );
    decipher.setAuthTag(Buffer.from(encryptedParts[1], 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedParts[2], 'base64')),
      decipher.final()
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    return null;
  }
}

function sanitizeCookieCollection(cookies) {
  const sanitizedCookies = {};
  if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) return sanitizedCookies;

  for (const [rawName, rawValue] of Object.entries(cookies)) {
    const cookieName = String(rawName || '').trim();
    const cookieValue = String(rawValue ?? '').trim();
    if (!COOKIE_NAME_PATTERN.test(cookieName)) continue;
    if (!cookieValue || cookieValue.length > MAX_COOKIE_VALUE_LENGTH || /[\u0000-\u001f\u007f;]/.test(cookieValue)) continue;
    sanitizedCookies[cookieName] = cookieValue;
  }
  return sanitizedCookies;
}

function getStoredBilibiliCredential() {
  const row = getDb().prepare(
    'SELECT encrypted_value, metadata, updated_at FROM server_secrets WHERE key = ?'
  ).get(BILIBILI_SECRET_KEY);
  if (!row) return null;

  const credential = decryptCredential(row.encrypted_value);
  if (!credential) return null;
  const cookies = sanitizeCookieCollection(credential.cookies);
  if (!cookies.SESSDATA) return null;

  let metadata = {};
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {}

  return {
    cookies,
    uid: String(metadata.uid || credential.uid || ''),
    displayName: String(metadata.displayName || credential.displayName || '').slice(0, 100),
    avatarUrl: String(metadata.avatarUrl || credential.avatarUrl || '').slice(0, 1000),
    credentialVersion: String(credential.credentialVersion || row.updated_at || 'stored'),
    updatedAt: row.updated_at || credential.updatedAt || null
  };
}

function saveBilibiliCredential(credential, updatedByUserId) {
  const cookies = sanitizeCookieCollection(credential?.cookies);
  if (!cookies.SESSDATA) throw new Error('Bilibili login did not return a valid SESSDATA cookie');

  const storedCredential = {
    cookies,
    uid: String(credential.uid || ''),
    displayName: String(credential.displayName || '').slice(0, 100),
    avatarUrl: String(credential.avatarUrl || '').slice(0, 1000),
    credentialVersion: `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`,
    updatedAt: new Date().toISOString()
  };
  const metadata = JSON.stringify({
    uid: storedCredential.uid,
    displayName: storedCredential.displayName,
    avatarUrl: storedCredential.avatarUrl
  });

  getDb().prepare(`
    INSERT INTO server_secrets (key, encrypted_value, metadata, updated_at, updated_by)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(key) DO UPDATE SET
      encrypted_value = excluded.encrypted_value,
      metadata = excluded.metadata,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = excluded.updated_by
  `).run(
    BILIBILI_SECRET_KEY,
    encryptCredential(storedCredential),
    metadata,
    Number.isInteger(updatedByUserId) ? updatedByUserId : null
  );

  return getStoredBilibiliCredential();
}

function deleteBilibiliCredential() {
  getDb().prepare('DELETE FROM server_secrets WHERE key = ?').run(BILIBILI_SECRET_KEY);
}

function createCookieHeader(cookies) {
  return Object.entries(sanitizeCookieCollection(cookies))
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([cookieName, cookieValue]) => `${cookieName}=${cookieValue}`)
    .join('; ');
}

function getBilibiliRequestCredential() {
  const credential = getStoredBilibiliCredential();
  return {
    cookieHeader: credential ? createCookieHeader(credential.cookies) : '',
    credentialVersion: credential?.credentialVersion || 'anonymous'
  };
}

function getBilibiliCredentialStatus() {
  const credential = getStoredBilibiliCredential();
  if (!credential) return { bound: false };
  return {
    bound: true,
    uid: credential.uid,
    displayName: credential.displayName,
    avatarUrl: credential.avatarUrl,
    updatedAt: credential.updatedAt
  };
}

module.exports = {
  createCookieHeader,
  decryptCredential,
  deleteBilibiliCredential,
  encryptCredential,
  getBilibiliCredentialStatus,
  getBilibiliRequestCredential,
  getStoredBilibiliCredential,
  sanitizeCookieCollection,
  saveBilibiliCredential
};
