import { readFileSync } from 'node:fs';
import { z } from 'zod';

export function readConfig(env = process.env) {
  const serverless = env.VERCEL === '1';
  const deploymentHost = env.VERCEL_ENV === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL : env.VERCEL_URL;
  const config = z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default(serverless ? 'production' : 'development'),
      DATABASE_URL: z.string().url(),
      APP_ORIGIN: z
        .string()
        .url()
        .default(serverless && deploymentHost ? `https://${deploymentHost}` : 'http://localhost:5173'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3001),
      TRUST_PROXY_HOPS: z.coerce
        .number()
        .int()
        .min(0)
        .max(5)
        .default(serverless ? 1 : 0),
      MAIL_TRANSPORT: z.enum(['smtp', 'file', 'disabled']).optional(),
      MAIL_FROM: z.string().email().default('workspace@localhost.test'),
      SMTP_HOST: z.string().optional(),
      SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
      SMTP_SECURE: z.enum(['true', 'false']).default('false'),
      SMTP_USER: z.string().optional(),
      SMTP_PASSWORD: z.string().optional(),
      MAIL_DIRECTORY: z.string().default('.local/mail'),
      DATABASE_CA_FILE: z.string().optional(),
      DATABASE_CA_PEM: z.string().optional(),
      DB_POOL_MAX: z.coerce
        .number()
        .int()
        .min(1)
        .max(20)
        .default(serverless ? 2 : 10),
      CRON_SECRET: z.string().min(32).optional(),
    })
    .parse(env);
  const origin = new URL(config.APP_ORIGIN);
  if (origin.origin !== config.APP_ORIGIN || origin.username || origin.password) throw new Error('APP_ORIGIN must be an origin without a path or credentials');
  const database = new URL(config.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL connection string');
  config.serverless = serverless;
  config.MAIL_TRANSPORT ??= config.SMTP_HOST ? 'smtp' : config.NODE_ENV === 'production' ? 'disabled' : 'file';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname);
  if (config.NODE_ENV === 'production' && origin.protocol !== 'https:') throw new Error('Production requires an HTTPS APP_ORIGIN');
  if (config.NODE_ENV === 'production' && config.MAIL_TRANSPORT === 'file') throw new Error('Production cannot use file delivery; use SMTP or disabled');
  if (config.MAIL_TRANSPORT === 'smtp' && !config.SMTP_HOST) throw new Error('SMTP_HOST is required');
  if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASSWORD)) throw new Error('SMTP_USER and SMTP_PASSWORD must be supplied together');
  // Explicit verification prevents connection-string sslmode options downgrading TLS.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'options']) database.searchParams.delete(key);
  const ca = config.DATABASE_CA_PEM || (config.DATABASE_CA_FILE ? readFileSync(config.DATABASE_CA_FILE, 'utf8') : null);
  config.database = {
    connectionString: database.toString(),
    ssl: local ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    options: '-c search_path=app_private -c statement_timeout=15000 -c lock_timeout=10000',
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: serverless ? 5000 : 30000,
  };
  // Explicit Vercel-owned hostnames only; never trust an arbitrary Host/Origin header.
  config.allowedOrigins = [config.APP_ORIGIN];
  if (serverless) {
    for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
      if (host && /^[a-z0-9.-]+\.vercel\.app$/i.test(host)) config.allowedOrigins.push(`https://${host}`);
    }
  }
  return config;
}
