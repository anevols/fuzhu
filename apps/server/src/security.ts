import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function newAgentToken(): string {
  return `tk_${randomBytes(24).toString('base64url')}`;
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function agentTokenPrefix(token: string): string {
  return `${token.slice(0, 10)}...`;
}

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function randomPassword(length = 16): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}
