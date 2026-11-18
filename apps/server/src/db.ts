import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite';

// 通过 createRequire 加载，避免打包器把 node:sqlite 误判为第三方包
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type UserRole = 'admin' | 'member';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: number;
}

export interface ClientRow {
  id: string;
  name: string;
  note: string;
  token_hash: string;
  token_prefix: string;
  node_id: string;
  owner_id: string | null;
  created_at: number;
  last_seen_at: number | null;
}

export interface TunnelRow {
  id: string;
  client_id: string;
  name: string;
  protocol: string;
  local_host: string;
  local_port: number;
  remote_port: number;
  enabled: number;
  created_at: number;
}

export interface DomainRow {
  domain: string;
  tunnel_id: string;
}

type SqlValue = string | number | null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT 'local',
  owner_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'tcp',
  local_host TEXT NOT NULL,
  local_port INTEGER NOT NULL,
  remote_port INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tunnel_domains (
  domain TEXT PRIMARY KEY,
  tunnel_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tunnels_client ON tunnels(client_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_domains_tunnel ON tunnel_domains(tunnel_id);
`;

export class Store {
  private readonly db: DatabaseSyncInstance;

  constructor(file: string) {
    if (file !== ':memory:') {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** 轻量迁移：SQLite 不支持 ADD COLUMN IF NOT EXISTS，这里按列名判断 */
  private migrate(): void {
    const userColumns = this.db.prepare('PRAGMA table_info(users)').all() as unknown as Array<{
      name: string;
    }>;
    if (!userColumns.some((column) => column.name === 'role')) {
      this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
      // 老数据里的第一个账号原本就是管理员
      this.db.exec(
        "UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)",
      );
    }

    const clientColumns = this.db.prepare('PRAGMA table_info(clients)').all() as unknown as Array<{
      name: string;
    }>;
    if (!clientColumns.some((column) => column.name === 'owner_id')) {
      this.db.exec('ALTER TABLE clients ADD COLUMN owner_id TEXT');
    }
    // 历史客户端归属到第一个管理员，避免升级后无人可见
    this.db.exec(
      "UPDATE clients SET owner_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1) WHERE owner_id IS NULL",
    );
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_clients_owner ON clients(owner_id)');
  }

  // ---------- users & sessions ----------

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return Number(row.n);
  }

  countAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .get() as { n: number };
    return Number(row.n);
  }

  createUser(user: UserRow): void {
    this.db
      .prepare(
        'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(user.id, user.username, user.password_hash, user.role, user.created_at);
  }

  findUserByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | UserRow
      | undefined;
  }

  findUserById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  listUsers(): UserRow[] {
    return this.db
      .prepare('SELECT * FROM users ORDER BY created_at ASC')
      .all() as unknown as UserRow[];
  }

  updateUserPassword(id: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  updateUserRole(id: string, role: UserRole): void {
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  /** 删除账号并把其客户端移交给指定管理员，同时清理会话 */
  deleteUser(id: string, reassignTo: string | null): void {
    this.db.exec('BEGIN');
    try {
      if (reassignTo) {
        this.db.prepare('UPDATE clients SET owner_id = ? WHERE owner_id = ?').run(reassignTo, id);
      }
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createSession(session: SessionRow): void {
    this.db
      .prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .run(session.id, session.user_id, session.expires_at);
  }

  findSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  deleteUserSessions(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  deleteExpiredSessions(now: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  }

  // ---------- clients ----------

  listClients(): ClientRow[] {
    return this.db
      .prepare('SELECT * FROM clients ORDER BY created_at ASC')
      .all() as unknown as ClientRow[];
  }

  listClientsByOwner(ownerId: string): ClientRow[] {
    return this.db
      .prepare('SELECT * FROM clients WHERE owner_id = ? ORDER BY created_at ASC')
      .all(ownerId) as unknown as ClientRow[];
  }

  findClient(id: string): ClientRow | undefined {
    return this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow | undefined;
  }

  findClientByTokenHash(hash: string): ClientRow | undefined {
    return this.db.prepare('SELECT * FROM clients WHERE token_hash = ?').get(hash) as
      | ClientRow
      | undefined;
  }

  createClient(client: ClientRow): void {
    this.db
      .prepare(
        `INSERT INTO clients (id, name, note, token_hash, token_prefix, node_id, owner_id, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        client.id,
        client.name,
        client.note,
        client.token_hash,
        client.token_prefix,
        client.node_id,
        client.owner_id,
        client.created_at,
        client.last_seen_at,
      );
  }

  updateClient(id: string, patch: { name?: string; note?: string }): void {
    const fields: string[] = [];
    const values: SqlValue[] = [];
    if (patch.name !== undefined) {
      fields.push('name = ?');
      values.push(patch.name);
    }
    if (patch.note !== undefined) {
      fields.push('note = ?');
      values.push(patch.note);
    }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  }

  updateClientToken(id: string, tokenHash: string, tokenPrefix: string): void {
    this.db
      .prepare('UPDATE clients SET token_hash = ?, token_prefix = ? WHERE id = ?')
      .run(tokenHash, tokenPrefix, id);
  }

  touchClient(id: string, at: number): void {
    this.db.prepare('UPDATE clients SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  deleteClient(id: string): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM tunnel_domains WHERE tunnel_id IN (SELECT id FROM tunnels WHERE client_id = ?)')
        .run(id);
      this.db.prepare('DELETE FROM tunnels WHERE client_id = ?').run(id);
      this.db.prepare('DELETE FROM clients WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------- tunnels ----------

  listTunnels(): TunnelRow[] {
    return this.db
      .prepare('SELECT * FROM tunnels ORDER BY created_at ASC')
      .all() as unknown as TunnelRow[];
  }

  listTunnelsByClient(clientId: string): TunnelRow[] {
    return this.db
      .prepare('SELECT * FROM tunnels WHERE client_id = ? ORDER BY created_at ASC')
      .all(clientId) as unknown as TunnelRow[];
  }

  findTunnel(id: string): TunnelRow | undefined {
    return this.db.prepare('SELECT * FROM tunnels WHERE id = ?').get(id) as TunnelRow | undefined;
  }

  findTunnelByRemotePort(port: number, protocol: string): TunnelRow | undefined {
    return this.db
      .prepare('SELECT * FROM tunnels WHERE remote_port = ? AND protocol = ?')
      .get(port, protocol) as TunnelRow | undefined;
  }

  createTunnel(tunnel: TunnelRow): void {
    this.db
      .prepare(
        `INSERT INTO tunnels (id, client_id, name, protocol, local_host, local_port, remote_port, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tunnel.id,
        tunnel.client_id,
        tunnel.name,
        tunnel.protocol,
        tunnel.local_host,
        tunnel.local_port,
        tunnel.remote_port,
        tunnel.enabled,
        tunnel.created_at,
      );
  }

  updateTunnel(
    id: string,
    patch: {
      name?: string;
      local_host?: string;
      local_port?: number;
      remote_port?: number;
      enabled?: number;
    },
  ): void {
    const fields: string[] = [];
    const values: SqlValue[] = [];
    for (const key of ['name', 'local_host', 'local_port', 'remote_port', 'enabled'] as const) {
      const value = patch[key];
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE tunnels SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
  }

  deleteTunnel(id: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM tunnel_domains WHERE tunnel_id = ?').run(id);
      this.db.prepare('DELETE FROM tunnels WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------- http domains ----------

  listAllDomains(): DomainRow[] {
    return this.db
      .prepare('SELECT domain, tunnel_id FROM tunnel_domains')
      .all() as unknown as DomainRow[];
  }

  listTunnelDomains(tunnelId: string): string[] {
    const rows = this.db
      .prepare('SELECT domain FROM tunnel_domains WHERE tunnel_id = ? ORDER BY domain ASC')
      .all(tunnelId) as unknown as Array<{ domain: string }>;
    return rows.map((row) => row.domain);
  }

  findTunnelIdByDomain(domain: string): string | undefined {
    const row = this.db
      .prepare('SELECT tunnel_id FROM tunnel_domains WHERE domain = ?')
      .get(domain) as { tunnel_id: string } | undefined;
    return row?.tunnel_id;
  }

  setTunnelDomains(tunnelId: string, domains: string[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM tunnel_domains WHERE tunnel_id = ?').run(tunnelId);
      const insert = this.db.prepare(
        'INSERT INTO tunnel_domains (domain, tunnel_id) VALUES (?, ?)',
      );
      for (const domain of domains) {
        insert.run(domain, tunnelId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
