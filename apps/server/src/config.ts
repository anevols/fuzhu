import path from 'node:path';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} 必须是 1-65535 之间的整数`);
  }
  return value;
}

export const config = {
  version: '0.1.0',
  host: process.env.HOST ?? '0.0.0.0',
  port: intEnv('PORT', 8787),
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  webDist: path.resolve(process.env.WEB_DIST ?? path.join(process.cwd(), '../web/dist')),
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
