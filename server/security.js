import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';

const scrypt = promisify(scryptCallback);
const options = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
export const token = () => randomBytes(32).toString('hex');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z.string().min(12).max(128);
export const name = z.string().trim().min(1).max(100);
export const uuid = z.string().uuid();
export const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const role = z.enum(['owner', 'admin', 'member', 'guest']);

export async function hashPassword(value) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(value, salt, 64, options);
  return `scrypt$65536$8$1$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(value, encoded) {
  const [algorithm, n, r, p, salt, hash] = encoded.split('$');
  if (algorithm !== 'scrypt' || n !== '65536' || r !== '8' || p !== '1' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const actual = await scrypt(value, salt, 64, options);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new HttpError(status, message);
};
export const parse = (schema, body) => {
  const result = schema.safeParse(body);
  if (!result.success) fail(400, 'Periksa isian Anda. Password minimal 12 karakter; nama maksimal 100 karakter.');
  return result.data;
};

export async function limit(db, key, max, seconds) {
  const { rows } = await db.query(
    `INSERT INTO rate_limits(key, count, expires_at) VALUES ($1, 1, now() + $2 * interval '1 second')
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN rate_limits.expires_at < now() THEN 1 ELSE rate_limits.count + 1 END,
    expires_at = CASE WHEN rate_limits.expires_at < now() THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END RETURNING count`,
    [digest(key), seconds],
  );
  if (rows[0].count > max) fail(429, 'Terlalu banyak percobaan. Coba lagi nanti.');
}

export async function membership(db, workspaceId, userId, roles = ['owner', 'admin', 'member', 'guest'], lock = false) {
  uuid.parse(workspaceId);
  if (lock) await db.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
  const { rows } = await db.query('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2 AND active', [workspaceId, userId]);
  if (!rows.length) fail(404, 'Workspace tidak ditemukan.');
  if (!roles.includes(rows[0].role)) fail(403, 'Anda tidak memiliki izin untuk tindakan ini.');
  return rows[0].role;
}
