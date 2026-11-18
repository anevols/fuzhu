import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { generate } from 'selfsigned';
import * as acme from 'acme-client';
import type { FastifyBaseLogger } from 'fastify';
import type { config as AppConfig } from './config';

export interface CertInfo {
  domain: string;
  mode: 'acme' | 'self-signed' | 'pending' | 'error';
  expiresAt: string | null;
  updatedAt: string | null;
  error: string | null;
}

interface KeyPair {
  key: string;
  cert: string;
}

const RENEW_ACME_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_SELF_MS = 7 * 24 * 60 * 60 * 1000;
const ACME_RETRY_MS = 10 * 60 * 1000;

function safeName(domain: string): string {
  return domain.replace(/[^a-z0-9.-]/gi, '_');
}

function pemExpiry(cert: string): number | null {
  try {
    const parsed = new X509Certificate(cert);
    const time = Date.parse(parsed.validTo);
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}

async function selfSignedPair(domain: string): Promise<KeyPair> {
  const result = await generate([{ name: 'commonName', value: domain }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: new Date(),
    notAfterDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] },
    ],
  });
  return { key: result.private, cert: result.cert };
}

/**
 * 证书仓库：优先使用 ACME 证书，未配置或签发失败时回退到自签名证书，
 * 保证域名隧道开启 HTTPS 后立即可用。
 */
export class CertStore {
  private readonly pairs = new Map<string, KeyPair>();
  private readonly contexts = new Map<string, tls.SecureContext>();
  private readonly info = new Map<string, CertInfo>();
  private readonly issuing = new Set<string>();
  private readonly acmeAttemptAt = new Map<string, number>();
  private readonly challenges = new Map<string, string>();
  private defaultPair: KeyPair | null = null;
  private defaultContext: tls.SecureContext | null = null;

  constructor(
    private readonly dir: string,
    private readonly config: typeof AppConfig,
    private readonly logger: FastifyBaseLogger,
  ) {
    mkdirSync(this.dir, { recursive: true });
  }

  get acmeEnabled(): boolean {
    return Boolean(this.config.acmeEmail);
  }

  /** HTTP-01 校验文件内容，由 HTTP 监听器直接响应 */
  getChallenge(token: string): string | undefined {
    return this.challenges.get(token);
  }

  async getDefault(): Promise<KeyPair> {
    if (this.defaultPair) return this.defaultPair;
    const keyFile = path.join(this.dir, '_default.key');
    const certFile = path.join(this.dir, '_default.crt');
    if (existsSync(keyFile) && existsSync(certFile)) {
      const pair = { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
      const expires = pemExpiry(pair.cert);
      if (expires !== null && expires - Date.now() > RENEW_SELF_MS) {
        this.defaultPair = pair;
        return pair;
      }
    }
    const pair = await selfSignedPair('localhost');
    writeFileSync(keyFile, pair.key);
    writeFileSync(certFile, pair.cert);
    this.defaultPair = pair;
    this.defaultContext = null;
    return pair;
  }

  getDefaultContext(): tls.SecureContext {
    if (!this.defaultPair) throw new Error('default certificate not ready');
    if (!this.defaultContext) {
      this.defaultContext = tls.createSecureContext({
        key: this.defaultPair.key,
        cert: this.defaultPair.cert,
      });
    }
    return this.defaultContext;
  }

  getContext(domain: string): tls.SecureContext | undefined {
    const normalized = domain.toLowerCase();
    const pair = this.pairs.get(normalized);
    if (!pair) return undefined;
    let context = this.contexts.get(normalized);
    if (!context) {
      context = tls.createSecureContext({ key: pair.key, cert: pair.cert });
      this.contexts.set(normalized, context);
    }
    return context;
  }

  status(domain: string): CertInfo {
    return (
      this.info.get(domain.toLowerCase()) ?? {
        domain,
        mode: 'pending',
        expiresAt: null,
        updatedAt: null,
        error: null,
      }
    );
  }

  /** 加载/生成域名证书；ACME 签发在后台进行，不阻塞路由启动 */
  async ensure(domains: string[]): Promise<void> {
    for (const raw of domains) {
      const domain = raw.toLowerCase();

      if (this.pairs.has(domain)) {
        const mode = this.info.get(domain)?.mode;
        if (mode === 'acme') {
          if (this.expiringSoon(domain, RENEW_ACME_MS)) this.issueAcme(domain);
        } else if (this.expiringSoon(domain, RENEW_SELF_MS)) {
          await this.generateSelfSigned(domain);
        } else if (this.acmeEnabled) {
          // 自签名可用期间继续尝试申请正式证书
          this.issueAcme(domain);
        }
        continue;
      }

      if (this.loadFromDisk(domain)) {
        const mode = this.info.get(domain)?.mode;
        if (mode === 'acme') {
          if (this.expiringSoon(domain, RENEW_ACME_MS)) this.issueAcme(domain);
        } else if (this.expiringSoon(domain, RENEW_SELF_MS)) {
          await this.generateSelfSigned(domain);
        } else if (this.acmeEnabled) {
          this.issueAcme(domain);
        }
        continue;
      }

      if (this.acmeEnabled) {
        this.info.set(domain, {
          domain,
          mode: 'pending',
          expiresAt: null,
          updatedAt: null,
          error: null,
        });
        this.issueAcme(domain);
        // 先准备一份自签名证书兜底，避免 ACME 失败期间 HTTPS 不可用
        await this.generateSelfSigned(domain);
      } else {
        await this.generateSelfSigned(domain);
      }
    }
  }

  private expiringSoon(domain: string, windowMs: number): boolean {
    const pair = this.pairs.get(domain);
    if (!pair) return false;
    const expires = pemExpiry(pair.cert);
    return expires === null || expires - Date.now() < windowMs;
  }

  /**
   * 从磁盘加载已有证书：优先使用未过期的 ACME 证书，其次未过期的自签名证书；
   * 都过期时仍加载一份用于兜底，并交由 ensure() 触发续期。
   */
  private loadFromDisk(domain: string): boolean {
    const base = safeName(domain);
    const read = (key: string, cert: string): KeyPair | null => {
      if (!existsSync(key) || !existsSync(cert)) return null;
      return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
    };

    const acmePair = read(
      path.join(this.dir, `acme-${base}.key`),
      path.join(this.dir, `acme-${base}.crt`),
    );
    const selfPair = read(path.join(this.dir, `${base}.key`), path.join(this.dir, `${base}.crt`));
    const now = Date.now();

    if (acmePair && (pemExpiry(acmePair.cert) ?? 0) > now) {
      this.apply(domain, acmePair, 'acme');
      return true;
    }
    if (selfPair && (pemExpiry(selfPair.cert) ?? 0) > now) {
      this.apply(domain, selfPair, 'self-signed');
      return true;
    }
    if (acmePair) {
      this.apply(domain, acmePair, 'acme');
      return true;
    }
    if (selfPair) {
      this.apply(domain, selfPair, 'self-signed');
      return true;
    }
    return false;
  }

  private async generateSelfSigned(domain: string): Promise<void> {
    try {
      const pair = await selfSignedPair(domain);
      const base = safeName(domain);
      writeFileSync(path.join(this.dir, `${base}.key`), pair.key);
      writeFileSync(path.join(this.dir, `${base}.crt`), pair.cert);
      this.apply(domain, pair, 'self-signed');
    } catch (error) {
      const message = (error as Error).message;
      this.info.set(domain, {
        domain,
        mode: 'error',
        expiresAt: null,
        updatedAt: null,
        error: `自签名证书生成失败: ${message}`,
      });
      this.logger.error({ domain, err: error }, 'failed to generate self-signed certificate');
    }
  }

  private issueAcme(domain: string): void {
    if (!this.acmeEnabled || this.issuing.has(domain)) return;
    const lastAttempt = this.acmeAttemptAt.get(domain) ?? 0;
    if (Date.now() - lastAttempt < ACME_RETRY_MS) return;
    this.acmeAttemptAt.set(domain, Date.now());
    this.issuing.add(domain);
    void this.doIssueAcme(domain)
      .catch((error: Error) => {
        this.logger.warn({ domain, err: error }, 'ACME certificate issuance failed');
        const current = this.info.get(domain);
        this.info.set(domain, {
          domain,
          mode: current?.mode === 'acme' ? 'acme' : current ? current.mode : 'self-signed',
          expiresAt: current?.expiresAt ?? null,
          updatedAt: current?.updatedAt ?? null,
          error: `ACME 签发失败: ${error.message}`,
        });
      })
      .finally(() => {
        this.issuing.delete(domain);
      });
  }

  private async doIssueAcme(domain: string): Promise<void> {
    const base = safeName(domain);
    const accountKeyFile = path.join(this.dir, 'acme-account.key');
    const accountKey = existsSync(accountKeyFile)
      ? readFileSync(accountKeyFile, 'utf8')
      : await acme.forge.createPrivateKey();
    if (!existsSync(accountKeyFile)) writeFileSync(accountKeyFile, accountKey);

    const client = new acme.Client({
      directoryUrl: this.config.acmeDirectory,
      accountKey,
    });

    const [key, csr] = await acme.forge.createCsr({
      commonName: domain,
      altNames: [domain],
    });

    this.logger.info({ domain }, 'requesting ACME certificate');
    const cert = await client.auto({
      csr,
      email: this.config.acmeEmail,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        if (challenge.type !== 'http-01') {
          throw new Error(`不支持的校验方式: ${challenge.type}`);
        }
        this.challenges.set(challenge.token, keyAuthorization);
      },
      challengeRemoveFn: async (_authz, challenge) => {
        this.challenges.delete(challenge.token);
      },
    });

    writeFileSync(path.join(this.dir, `acme-${base}.key`), key.toString());
    writeFileSync(path.join(this.dir, `acme-${base}.crt`), cert);
    this.apply(domain, { key: key.toString(), cert }, 'acme');
    this.logger.info({ domain }, 'ACME certificate issued');
  }

  private apply(domain: string, pair: KeyPair, mode: 'acme' | 'self-signed'): void {
    this.pairs.set(domain, pair);
    this.contexts.delete(domain);
    const expires = pemExpiry(pair.cert);
    this.info.set(domain, {
      domain,
      mode,
      expiresAt: expires ? new Date(expires).toISOString() : null,
      updatedAt: new Date().toISOString(),
      error: null,
    });
  }
}
