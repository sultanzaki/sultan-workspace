import { readFileSync } from 'node:fs';
import { z } from 'zod';

export function readConfig(env = process.env) {
  const config = z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      DATABASE_URL: z.string().url(),
      APP_ORIGIN: z.string().url().default('http://localhost:5173'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3001),
      TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
      MAIL_TRANSPORT: z.enum(['smtp', 'file']).default('file'),
      MAIL_FROM: z.string().email().default('workspace@localhost.test'),
      SMTP_HOST: z.string().optional(),
      SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
      SMTP_SECURE: z.enum(['true', 'false']).default('false'),
      SMTP_USER: z.string().optional(),
      SMTP_PASSWORD: z.string().optional(),
      MAIL_DIRECTORY: z.string().default('.local/mail'),
      DATABASE_CA_FILE: z.string().optional(),
    })
    .parse(env);
  const origin = new URL(config.APP_ORIGIN);
  if (origin.origin !== config.APP_ORIGIN || origin.username || origin.password) throw new Error('APP_ORIGIN must be an origin without a path or credentials');
  const database = new URL(config.DATABASE_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname);
  if (config.NODE_ENV === 'production' && origin.protocol !== 'https:') throw new Error('Production requires an HTTPS APP_ORIGIN');
  if (config.NODE_ENV === 'production' && config.MAIL_TRANSPORT !== 'smtp') throw new Error('Production requires SMTP delivery');
  if (config.MAIL_TRANSPORT === 'smtp' && !config.SMTP_HOST) throw new Error('SMTP_HOST is required');
  if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASSWORD)) throw new Error('SMTP_USER and SMTP_PASSWORD must be supplied together');
  // Explicit verification prevents connection-string sslmode options downgrading TLS.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) database.searchParams.delete(key);
  config.database = {
    connectionString: database.toString(),
    ssl: local ? false : { rejectUnauthorized: true, ...(config.DATABASE_CA_FILE ? { ca: readFileSync(config.DATABASE_CA_FILE, 'utf8') } : {}) },
    options: '-c search_path=app_private -c statement_timeout=15000 -c lock_timeout=10000',
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  };
  return config;
}
