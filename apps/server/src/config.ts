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
  version: '0.2.0',
  host: process.env.HOST ?? '0.0.0.0',
  port: intEnv('PORT', 8787),
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  webDist: path.resolve(process.env.WEB_DIST ?? path.join(process.cwd(), '../web/dist')),
  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** HTTP 域名路由与 HTTPS 终止共用的公网端口 */
  httpPort: intEnv('HTTP_PORT', 80),
  httpsPort: intEnv('HTTPS_PORT', 443),
  /** 关闭后完全禁用 HTTP 域名隧道（已有 http 隧道会显示错误） */
  httpRouter: process.env.HTTP_ROUTER !== 'false',
  certDir: path.resolve(process.env.CERT_DIR ?? path.join(process.env.DATA_DIR ?? './data', 'certs')),
  /** 配置邮箱与目录后启用 ACME（Let's Encrypt），否则使用自签名证书 */
  acmeEmail: process.env.ACME_EMAIL ?? '',
  acmeDirectory:
    process.env.ACME_DIRECTORY ?? 'https://acme-v02.api.letsencrypt.org/directory',
};
