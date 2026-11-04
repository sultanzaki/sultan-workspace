import { randomBytes, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { digest, fail } from './security.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let bits = 0,
    value = 0,
    output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function decode(value) {
  let bits = 0,
    buffer = 0;
  const out = [];
  for (const char of value.toUpperCase().replace(/=+$/, '')) {
    const n = alphabet.indexOf(char);
    if (n < 0) throw new Error('Invalid base32');
    buffer = (buffer << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totp(secret, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', decode(secret)).update(message).digest(),
    offset = hash.at(-1) & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, '0');
}
export const newSecret = () => base32(randomBytes(20));
function key(config) {
  const bytes = config.AUTH_ENCRYPTION_KEY ? Buffer.from(config.AUTH_ENCRYPTION_KEY, 'base64') : null;
  if (bytes?.length !== 32) fail(503, 'Configure AUTH_ENCRYPTION_KEY to enable two-factor authentication.');
  return bytes;
}
export function encryptSecret(secret, config, user) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(config), iv);
  cipher.setAAD(Buffer.from(user));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(bytes => bytes.toString('base64')).join('.');
}
export function decryptSecret(value, config, user) {
  const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(config), iv);
  decipher.setAAD(Buffer.from(user));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    fail(503, 'The two-factor encryption key does not match. Contact an administrator; do not replace the existing AUTH_ENCRYPTION_KEY.');
  }
}
export async function verifyFactor(db, user, input, config, now = Date.now()) {
  const security = (await db.query('SELECT * FROM user_security WHERE user_id=$1 FOR UPDATE', [user])).rows[0];
  if (!security?.enabled) return true;
  const code = String(input || '')
    .replace(/[\s-]/g, '')
    .toUpperCase();
  if (/^[0-9A-F]{20}$/.test(code)) {
    return (await db.query('DELETE FROM recovery_codes WHERE user_id=$1 AND code_hash=$2 RETURNING code_hash', [user, digest(user + ':' + code)])).rowCount > 0;
  }
  if (!/^\d{6}$/.test(code)) return false;
  const current = Math.floor(now / 30000),
    secret = decryptSecret(security.secret, config, user);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter < 0 || counter <= Number(security.last_counter)) continue;
    if (timingSafeEqual(Buffer.from(totp(secret, counter)), Buffer.from(code))) {
      await db.query('UPDATE user_security SET last_counter=$1 WHERE user_id=$2', [counter, user]);
      return true;
    }
  }
  return false;
}
export async function recoveryCodes(db, user) {
  const codes = Array.from({ length: 10 }, () => randomBytes(10).toString('hex').toUpperCase());
  await db.query('DELETE FROM recovery_codes WHERE user_id=$1', [user]);
  await db.query('INSERT INTO recovery_codes(user_id,code_hash) SELECT $1,unnest($2::text[])', [user, codes.map(code => digest(user + ':' + code))]);
  return codes.map(code => code.match(/.{1,5}/g).join('-'));
}
