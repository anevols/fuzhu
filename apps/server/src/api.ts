import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { config as AppConfig } from './config';
import type { ClientRow, Store, TunnelRow, UserRole, UserRow } from './db';
import type { AgentHub, TrafficStore } from './hub';
import type { TunnelManager } from './tunnels';
import {
  agentTokenPrefix,
  hashAgentToken,
  hashPassword,
  newAgentToken,
  newId,
  newSessionId,
  verifyPassword,
} from './security';

const SESSION_COOKIE = 'tunnel_sid';
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_MAX_TRACKED = 10_000;

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

interface AuthedRequest extends FastifyRequest {
  user?: AuthUser;
}

export interface ApiDeps {
  store: Store;
  hub: AgentHub;
  tunnelManager: TunnelManager;
  traffic: TrafficStore;
  config: typeof AppConfig;
  startedAt: number;
}

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

const clientCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  note: z.string().trim().max(200).optional(),
});

const clientUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .refine((value) => value.name !== undefined || value.note !== undefined, {
    message: '至少提供一个字段',
  });

const protocolSchema = z.enum(['tcp', 'udp', 'http']);

const tunnelCreateSchema = z.object({
  clientId: z.string().min(1),
  name: z.string().trim().min(1).max(64),
  protocol: protocolSchema.default('tcp'),
  localHost: z.string().trim().min(1).max(255).default('127.0.0.1'),
  localPort: z.number().int().min(1).max(65535),
  remotePort: z.number().int().min(1).max(65535).optional(),
  domains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
  enabled: z.boolean().default(true),
});

const tunnelUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    localHost: z.string().trim().min(1).max(255).optional(),
    localPort: z.number().int().min(1).max(65535).optional(),
    remotePort: z.number().int().min(1).max(65535).optional(),
    domains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个字段' });

const userCreateSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/, '只能包含字母、数字、下划线、点和短横线'),
  password: z.string().min(6).max(128),
  role: z.enum(['admin', 'member']).default('member'),
});

const userUpdateSchema = z
  .object({
    password: z.string().min(6).max(128).optional(),
    role: z.enum(['admin', 'member']).optional(),
  })
  .refine((value) => value.password !== undefined || value.role !== undefined, {
    message: '至少提供一个字段',
  });

function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.') || 'body';
    throw new ApiError(400, `${field}: ${issue?.message ?? '参数不合法'}`);
  }
  return result.data;
}

function iso(value: number | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function trafficOf(traffic: TrafficStore, tunnelIds: string[]): { inbound: number; outbound: number } {
  let inbound = 0;
  let outbound = 0;
  for (const id of tunnelIds) {
    const item = traffic.get(id);
    inbound += item.inbound;
    outbound += item.outbound;
  }
  return { inbound, outbound };
}

function normalizeDomains(input: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const domain = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!domain) continue;
    if (
      domain.length > 253 ||
      domain.includes('/') ||
      domain.includes(':') ||
      domain.includes('..') ||
      !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain)
    ) {
      throw new ApiError(400, `域名格式不正确: ${raw}`);
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    result.push(domain);
  }
  return result;
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { store, hub, tunnelManager, traffic, config } = deps;
  const loginFailures = new Map<string, { count: number; resetAt: number }>();

  function pruneLoginFailures(now: number): void {
    if (loginFailures.size < LOGIN_MAX_TRACKED) return;
    for (const [key, item] of loginFailures) {
      if (item.resetAt <= now) loginFailures.delete(key);
    }
    while (loginFailures.size >= LOGIN_MAX_TRACKED) {
      const oldest = loginFailures.keys().next().value;
      if (!oldest) break;
      loginFailures.delete(oldest);
    }
  }

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      return reply.code(400).send({ error: '请求格式不正确' });
    }
    request.log.error({ err: error }, 'unhandled api error');
    return reply.code(500).send({ error: '服务器内部错误' });
  });

  async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (!sessionId) {
      reply.code(401).send({ error: '未登录' });
      return;
    }
    const session = store.findSession(sessionId);
    if (!session || session.expires_at < Date.now()) {
      if (session) store.deleteSession(sessionId);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      reply.code(401).send({ error: '登录已过期' });
      return;
    }
    const user = store.findUserById(session.user_id);
    if (!user) {
      reply.code(401).send({ error: '账号不存在' });
      return;
    }
    (request as AuthedRequest).user = {
      id: user.id,
      username: user.username,
      role: user.role,
    };
  }

  async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = (request as AuthedRequest).user;
    if (!user || user.role !== 'admin') {
      reply.code(403).send({ error: '需要管理员权限' });
    }
  }

  function currentUser(request: FastifyRequest): AuthUser {
    const user = (request as AuthedRequest).user;
    if (!user) throw new ApiError(401, '未登录');
    return user;
  }

  function visibleClients(user: AuthUser): ClientRow[] {
    return user.role === 'admin' ? store.listClients() : store.listClientsByOwner(user.id);
  }

  function ownedClient(user: AuthUser, clientId: string): ClientRow {
    const client = store.findClient(clientId);
    if (!client) throw new ApiError(404, '客户端不存在');
    if (user.role !== 'admin' && client.owner_id !== user.id) {
      throw new ApiError(404, '客户端不存在');
    }
    return client;
  }

  function ownedTunnel(user: AuthUser, tunnelId: string): { tunnel: TunnelRow; client: ClientRow } {
    const tunnel = store.findTunnel(tunnelId);
    if (!tunnel) throw new ApiError(404, '隧道不存在');
    const client = store.findClient(tunnel.client_id);
    if (!client) throw new ApiError(404, '隧道不存在');
    if (user.role !== 'admin' && client.owner_id !== user.id) {
      throw new ApiError(404, '隧道不存在');
    }
    return { tunnel, client };
  }

  function serializeUser(user: UserRow): unknown {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: iso(user.created_at),
    };
  }

  function domainsMap(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const row of store.listAllDomains()) {
      const list = map.get(row.tunnel_id) ?? [];
      list.push(row.domain);
      map.set(row.tunnel_id, list);
    }
    return map;
  }

  function serializeClient(
    client: ClientRow,
    tunnels: TunnelRow[],
    owners: Map<string, string>,
  ): unknown {
    const ids = tunnels.filter((t) => t.client_id === client.id).map((t) => t.id);
    return {
      id: client.id,
      name: client.name,
      note: client.note,
      tokenPrefix: client.token_prefix,
      nodeId: client.node_id,
      ownerId: client.owner_id,
      ownerName: client.owner_id ? (owners.get(client.owner_id) ?? null) : null,
      online: hub.isOnline(client.id),
      createdAt: iso(client.created_at),
      lastSeenAt: iso(client.last_seen_at),
      tunnelCount: ids.length,
      traffic: trafficOf(traffic, ids),
    };
  }

  function serializeTunnel(
    tunnel: TunnelRow,
    clientName: string,
    domains: string[],
  ): unknown {
    const runtime = tunnelManager.status(tunnel);
    const stats = traffic.get(tunnel.id);
    let status: 'active' | 'offline' | 'error' | 'disabled' = 'offline';
    if (tunnel.enabled !== 1) status = 'disabled';
    else if (runtime.error) status = 'error';
    else if (runtime.listening) status = 'active';

    return {
      id: tunnel.id,
      clientId: tunnel.client_id,
      clientName,
      name: tunnel.name,
      protocol: tunnel.protocol,
      localHost: tunnel.local_host,
      localPort: tunnel.local_port,
      remotePort: tunnel.remote_port,
      domains,
      certs: tunnel.protocol === 'http' ? tunnelManager.certInfo(tunnel.id) : [],
      enabled: tunnel.enabled === 1,
      status,
      error: runtime.error ?? null,
      listening: runtime.listening,
      connections: stats.connections,
      activeConnections: stats.activeConnections,
      lastActiveAt: iso(stats.lastActiveAt),
      traffic: { inbound: stats.inbound, outbound: stats.outbound },
    };
  }

  // ---------- auth ----------

  app.post('/api/auth/login', async (request, reply) => {
    const ip = request.ip;
    const now = Date.now();
    pruneLoginFailures(now);
    const failure = loginFailures.get(ip);
    if (failure && failure.resetAt > now && failure.count >= LOGIN_MAX_FAILURES) {
      reply.header('retry-after', String(Math.ceil((failure.resetAt - now) / 1000)));
      throw new ApiError(429, '尝试次数过多，请 5 分钟后再试');
    }

    const { username, password } = parseBody(loginSchema, request.body);
    const user = store.findUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      const current = loginFailures.get(ip);
      if (current && current.resetAt > now) {
        current.count += 1;
      } else {
        loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      }
      throw new ApiError(401, '用户名或密码错误');
    }

    loginFailures.delete(ip);
    store.deleteExpiredSessions(Date.now());
    const sessionId = newSessionId();
    store.createSession({
      id: sessionId,
      user_id: user.id,
      expires_at: Date.now() + config.sessionTtlMs,
    });
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: config.cookieSecure,
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });
    return {
      user: { id: user.id, username: user.username, role: user.role },
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) store.deleteSession(sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => {
    return { user: currentUser(request) };
  });

  app.get('/api/health', async () => ({ ok: true, version: config.version }));

  // ---------- overview ----------

  app.get('/api/overview', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const clients = visibleClients(user);
    const allowedClients = new Set(clients.map((client) => client.id));
    const tunnels = store.listTunnels().filter((tunnel) => allowedClients.has(tunnel.client_id));
    const clientNames = new Map(clients.map((client) => [client.id, client.name]));
    const owners = new Map(store.listUsers().map((item) => [item.id, item.username]));
    const domains = domainsMap();
    const httpStatus = tunnelManager.httpStatus;

    const ports = new Set<number>();
    for (const tunnel of tunnels) {
      const runtime = tunnelManager.status(tunnel);
      if (!runtime.listening) continue;
      if (tunnel.protocol === 'http') {
        if (httpStatus.listening) ports.add(httpStatus.port);
        if (httpStatus.httpsListening) ports.add(httpStatus.httpsPort);
      } else if (tunnel.remote_port > 0) {
        ports.add(tunnel.remote_port);
      }
    }

    return {
      server: {
        version: config.version,
        uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
        onlineClients: clients.filter((client) => hub.isOnline(client.id)).length,
        totalClients: clients.length,
        totalTunnels: tunnels.length,
        listeningPorts: [...ports].sort((a, b) => a - b),
        http: httpStatus,
      },
      clients: clients.map((client) => serializeClient(client, tunnels, owners)),
      tunnels: tunnels.map((tunnel) =>
        serializeTunnel(
          tunnel,
          clientNames.get(tunnel.client_id) ?? '已删除客户端',
          domains.get(tunnel.id) ?? [],
        ),
      ),
    };
  });

  // ---------- clients ----------

  app.get('/api/clients', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const tunnels = store.listTunnels();
    const owners = new Map(store.listUsers().map((item) => [item.id, item.username]));
    return {
      clients: visibleClients(user).map((client) => serializeClient(client, tunnels, owners)),
    };
  });

  app.post('/api/clients', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const body = parseBody(clientCreateSchema, request.body);
    const token = newAgentToken();
    const client: ClientRow = {
      id: newId(),
      name: body.name,
      note: body.note ?? '',
      token_hash: hashAgentToken(token),
      token_prefix: agentTokenPrefix(token),
      node_id: 'local',
      owner_id: user.id,
      created_at: Date.now(),
      last_seen_at: null,
    };
    store.createClient(client);
    const owners = new Map(store.listUsers().map((item) => [item.id, item.username]));
    reply.code(201);
    return {
      client: serializeClient(client, [], owners),
      token,
    };
  });

  app.patch('/api/clients/:id', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    ownedClient(user, id);
    const body = parseBody(clientUpdateSchema, request.body);
    store.updateClient(id, body);
    return { ok: true };
  });

  app.delete('/api/clients/:id', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    ownedClient(user, id);
    for (const tunnel of store.listTunnelsByClient(id)) {
      traffic.drop(tunnel.id);
    }
    hub.disconnectClient(id, 'client deleted');
    store.deleteClient(id);
    await tunnelManager.reconcile();
    return { ok: true };
  });

  app.post('/api/clients/:id/token', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    ownedClient(user, id);
    const token = newAgentToken();
    store.updateClientToken(id, hashAgentToken(token), agentTokenPrefix(token));
    hub.disconnectClient(id, 'token rotated');
    return { token };
  });

  // ---------- tunnels ----------

  function assertPortAvailable(port: number, protocol: string, excludeId?: string): void {
    if (port === config.port) {
      throw new ApiError(409, `端口 ${port} 是面板端口，不能用于隧道`);
    }
    if (protocol !== 'http' && (port === config.httpPort || port === config.httpsPort)) {
      throw new ApiError(409, `端口 ${port} 保留给 HTTP/HTTPS 域名路由`);
    }
    const occupied = store.findTunnelByRemotePort(port, protocol);
    if (occupied && occupied.id !== excludeId) {
      throw new ApiError(409, `端口 ${port} 已被其他隧道占用`);
    }
  }

  function assertDomainsAvailable(domains: string[], excludeTunnelId?: string): void {
    for (const domain of domains) {
      const owner = store.findTunnelIdByDomain(domain);
      if (owner && owner !== excludeTunnelId) {
        throw new ApiError(409, `域名 ${domain} 已被其他隧道占用`);
      }
    }
  }

  app.get('/api/tunnels', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const clients = visibleClients(user);
    const allowed = new Set(clients.map((client) => client.id));
    const names = new Map(clients.map((client) => [client.id, client.name]));
    const domains = domainsMap();
    return {
      tunnels: store
        .listTunnels()
        .filter((tunnel) => allowed.has(tunnel.client_id))
        .map((tunnel) =>
          serializeTunnel(
            tunnel,
            names.get(tunnel.client_id) ?? '已删除客户端',
            domains.get(tunnel.id) ?? [],
          ),
        ),
    };
  });

  app.post('/api/tunnels', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const body = parseBody(tunnelCreateSchema, request.body);
    const client = ownedClient(user, body.clientId);

    const protocol = body.protocol;
    const domains = protocol === 'http' ? normalizeDomains(body.domains ?? []) : [];
    if (protocol === 'http' && domains.length === 0) {
      throw new ApiError(400, 'HTTP 隧道至少需要一个域名');
    }
    if (protocol !== 'http' && body.remotePort === undefined) {
      throw new ApiError(400, 'TCP/UDP 隧道必须填写公网端口');
    }
    if (protocol === 'http' && body.remotePort !== undefined) {
      throw new ApiError(400, 'HTTP 隧道使用共享的 80/443 端口，无需公网端口');
    }

    const remotePort = protocol === 'http' ? 0 : (body.remotePort as number);
    if (protocol !== 'http') {
      assertPortAvailable(remotePort, protocol);
    } else {
      assertDomainsAvailable(domains);
    }

    const tunnel: TunnelRow = {
      id: newId(),
      client_id: body.clientId,
      name: body.name,
      protocol,
      local_host: body.localHost,
      local_port: body.localPort,
      remote_port: remotePort,
      enabled: body.enabled ? 1 : 0,
      created_at: Date.now(),
    };
    store.createTunnel(tunnel);
    if (domains.length > 0) store.setTunnelDomains(tunnel.id, domains);
    await tunnelManager.reconcile();
    hub.syncClient(tunnel.client_id);
    reply.code(201);
    return { tunnel: serializeTunnel(tunnel, client.name, domains) };
  });

  app.patch('/api/tunnels/:id', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const { tunnel: existing, client } = ownedTunnel(user, id);
    const body = parseBody(tunnelUpdateSchema, request.body);

    const isHttp = existing.protocol === 'http';
    if (isHttp && body.remotePort !== undefined) {
      throw new ApiError(400, 'HTTP 隧道不使用公网端口');
    }
    if (!isHttp && body.domains !== undefined) {
      throw new ApiError(400, '只有 HTTP 隧道可以配置域名');
    }
    if (!isHttp && body.remotePort !== undefined) {
      assertPortAvailable(body.remotePort, existing.protocol, id);
    }

    let domains: string[] | undefined;
    if (body.domains !== undefined) {
      domains = normalizeDomains(body.domains);
      if (domains.length === 0) throw new ApiError(400, 'HTTP 隧道至少需要一个域名');
      assertDomainsAvailable(domains, id);
    }

    store.updateTunnel(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.localHost !== undefined ? { local_host: body.localHost } : {}),
      ...(body.localPort !== undefined ? { local_port: body.localPort } : {}),
      ...(body.remotePort !== undefined ? { remote_port: body.remotePort } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled ? 1 : 0 } : {}),
    });
    if (domains) store.setTunnelDomains(id, domains);
    await tunnelManager.reconcile();
    hub.syncClient(existing.client_id);
    const updated = store.findTunnel(id);
    const currentDomains = domains ?? store.listTunnelDomains(id);
    return {
      tunnel: updated ? serializeTunnel(updated, client.name, currentDomains) : null,
    };
  });

  app.delete('/api/tunnels/:id', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const { id } = request.params as { id: string };
    const { tunnel: existing } = ownedTunnel(user, id);
    store.deleteTunnel(id);
    traffic.drop(id);
    await tunnelManager.reconcile();
    hub.syncClient(existing.client_id);
    return { ok: true };
  });

  // ---------- users (admin only) ----------

  app.get(
    '/api/users',
    { preHandler: [requireAuth, requireAdmin] },
    async () => {
      const clients = store.listClients();
      return {
        users: store.listUsers().map((user) => ({
          ...(serializeUser(user) as Record<string, unknown>),
          clientCount: clients.filter((client) => client.owner_id === user.id).length,
        })),
      };
    },
  );

  app.post(
    '/api/users',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const body = parseBody(userCreateSchema, request.body);
      if (store.findUserByUsername(body.username)) {
        throw new ApiError(409, '用户名已存在');
      }
      const user: UserRow = {
        id: newId(),
        username: body.username,
        password_hash: hashPassword(body.password),
        role: body.role,
        created_at: Date.now(),
      };
      store.createUser(user);
      reply.code(201);
      return { user: serializeUser(user) };
    },
  );

  app.patch(
    '/api/users/:id',
    { preHandler: [requireAuth, requireAdmin] },
    async (request) => {
      const { id } = request.params as { id: string };
      const target = store.findUserById(id);
      if (!target) throw new ApiError(404, '用户不存在');
      const body = parseBody(userUpdateSchema, request.body);

      if (body.role && body.role !== target.role) {
        if (target.role === 'admin' && store.countAdmins() <= 1) {
          throw new ApiError(409, '至少需要保留一个管理员');
        }
        store.updateUserRole(id, body.role);
      }
      if (body.password) {
        store.updateUserPassword(id, hashPassword(body.password));
        store.deleteUserSessions(id);
      }
      const updated = store.findUserById(id);
      return { user: updated ? serializeUser(updated) : null };
    },
  );

  app.delete(
    '/api/users/:id',
    { preHandler: [requireAuth, requireAdmin] },
    async (request) => {
      const actor = currentUser(request);
      const { id } = request.params as { id: string };
      const target = store.findUserById(id);
      if (!target) throw new ApiError(404, '用户不存在');
      if (target.id === actor.id) throw new ApiError(409, '不能删除当前登录的账号');
      if (target.role === 'admin' && store.countAdmins() <= 1) {
        throw new ApiError(409, '至少需要保留一个管理员');
      }
      store.deleteUser(id, actor.id);
      return { ok: true };
    },
  );
}
