'use strict';

const crypto = require('node:crypto');

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SECRET_BYTES = 4096;

function validateSecret(secret) {
  if (typeof secret !== 'string') {
    const error = new Error('PEAKOS_SALES_PII_ENCRYPTION_SECRET가 필요합니다.');
    error.code = 'SALES_PII_SECRET_REQUIRED';
    throw error;
  }
  const bytes = Buffer.byteLength(secret, 'utf8');
  if (bytes < 32 || bytes > MAX_SECRET_BYTES) {
    const error = new Error('PEAKOS_SALES_PII_ENCRYPTION_SECRET는 UTF-8 기준 32~4096바이트여야 합니다.');
    error.code = 'SALES_PII_SECRET_INVALID';
    throw error;
  }
  return secret;
}

function aad(kind, workspaceId, leadId, entityId = '') {
  return Buffer.from(`peakos-sales:v1:${kind}:${workspaceId}:${leadId}:${entityId}`, 'utf8');
}

function encryptJson(value, key, associatedData) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), encryptionVersion: VERSION };
}

function decryptJson(payload, key, associatedData) {
  if (Number(payload.encryptionVersion) !== VERSION) throw new Error('지원하지 않는 영업 PII 암호화 버전입니다.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.nonce), { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData);
  decipher.setAuthTag(Buffer.from(payload.authTag));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext)), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('영업 PII 암호문 형식이 올바르지 않습니다.');
  return parsed;
}

function createSalesPiiCrypto(secret) {
  const validated = validateSecret(secret);
  const root = Buffer.from(validated, 'utf8');
  const salt = Buffer.from('peakos-sales-pii-v1', 'utf8');
  const encryptionKey = Buffer.from(crypto.hkdfSync('sha256', root, salt, Buffer.from('aes-256-gcm'), 32));
  const fingerprintKey = Buffer.from(crypto.hkdfSync('sha256', root, salt, Buffer.from('phone-hmac'), 32));

  return Object.freeze({
    version: VERSION,
    encryptContact(value, { workspaceId, leadId }) {
      return encryptJson(value, encryptionKey, aad('lead-contact', workspaceId, leadId));
    },
    decryptContact(row) {
      return decryptJson({
        ciphertext: row.contact_ciphertext,
        nonce: row.contact_nonce,
        authTag: row.contact_auth_tag,
        encryptionVersion: row.contact_encryption_version,
      }, encryptionKey, aad('lead-contact', row.workspace_id, row.id));
    },
    encryptCallNote(note, { workspaceId, leadId, callId }) {
      return encryptJson({ note }, encryptionKey, aad('call-note', workspaceId, leadId, callId));
    },
    decryptCallNote(row) {
      return decryptJson({
        ciphertext: row.note_ciphertext,
        nonce: row.note_nonce,
        authTag: row.note_auth_tag,
        encryptionVersion: row.note_encryption_version,
      }, encryptionKey, aad('call-note', row.workspace_id, row.lead_id, row.id)).note || '';
    },
    phoneFingerprint(normalizedPhone, workspaceId) {
      return crypto.createHmac('sha256', fingerprintKey)
        .update(`peakos-sales-phone:v1:${workspaceId}:${normalizedPhone}`, 'utf8')
        .digest('hex');
    },
  });
}

module.exports = {
  createSalesPiiCrypto,
  validateSecret,
};
