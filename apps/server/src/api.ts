import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { config as AppConfig } from './config';
import type { ClientRow, Store, TunnelRow } from './db';
import type { AgentHub, TrafficStore } from './hub';
import type { TunnelManager } from './tunnels';
import {
  agentTokenPrefix,
  hashAgentToken,
  newAgentToken,
  newId,
  newSessionId,
  verifyPassword,
} from './security';

const SESSION_COOKIE = 'tunnel_sid';
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface AuthedRequest extends FastifyRequest {
  user?: { id: string; username: string };
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

const tunnelCreateSchema = z.object({
  clientId: z.string().min(1),
  name: z.string().trim().min(1).max(64),
  localHost: z.string().trim().min(1).max(255).default('127.0.0.1'),
  localPort: z.number().int().min(1).max(65535),
  remotePort: z.number().int().min(1).max(65535),
  enabled: z.boolean().default(true),
});

const tunnelUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    localHost: z.string().trim().min(1).max(255).optional(),
    localPort: z.number().int().min(1).max(65535).optional(),
    remotePort: z.number().int().min(1).max(65535).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个字段' });

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

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { store, hub, tunnelManager, traffic, config } = deps;
  const loginFailures = new Map<string, { count: number; resetAt: number }>();

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
    (request as AuthedRequest).user = { id: user.id, username: user.username };
  }

  // ---------- auth ----------

  app.post('/api/auth/login', async (request, reply) => {
    const ip = request.ip;
    const failure = loginFailures.get(ip);
    if (failure && failure.resetAt > Date.now() && failure.count >= LOGIN_MAX_FAILURES) {
      throw new ApiError(429, '尝试次数过多，请 5 分钟后再试');
    }

    const { username, password } = parseBody(loginSchema, request.body);
    const user = store.findUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      const current = loginFailures.get(ip);
      if (current && current.resetAt > Date.now()) {
        current.count += 1;
      } else {
        loginFailures.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
      }
      throw new ApiError(401, '用户名或密码错误');
    }

    loginFailures.delete(ip);
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
    return { user: { username: user.username } };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) store.deleteSession(sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => {
    return { user: (request as AuthedRequest).user };
  });

  app.get('/api/health', async () => ({ ok: true, version: config.version }));

  // ---------- overview ----------

  function serializeClient(client: ClientRow, tunnels: TunnelRow[]): unknown {
    const ids = tunnels.filter((t) => t.client_id === client.id).map((t) => t.id);
    return {
      id: client.id,
      name: client.name,
      note: client.note,
      tokenPrefix: client.token_prefix,
      nodeId: client.node_id,
      online: hub.isOnline(client.id),
      createdAt: iso(client.created_at),
      lastSeenAt: iso(client.last_seen_at),
      tunnelCount: ids.length,
      traffic: trafficOf(traffic, ids),
    };
  }

  function serializeTunnel(tunnel: TunnelRow, clientName: string): unknown {
    const runtime = tunnelManager.status(tunnel.id, tunnel.remote_port);
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

  app.get('/api/overview', { preHandler: requireAuth }, async () => {
    const clients = store.listClients();
    const tunnels = store.listTunnels();
    const clientNames = new Map(clients.map((client) => [client.id, client.name]));
    return {
      server: {
        version: config.version,
        uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
        onlineClients: hub.onlineCount,
        totalClients: clients.length,
        totalTunnels: tunnels.length,
        listeningPorts: tunnelManager.listeningPorts,
      },
      clients: clients.map((client) => serializeClient(client, tunnels)),
      tunnels: tunnels.map((tunnel) =>
        serializeTunnel(tunnel, clientNames.get(tunnel.client_id) ?? '已删除客户端'),
      ),
    };
  });

  // ---------- clients ----------

  app.get('/api/clients', { preHandler: requireAuth }, async () => {
    const tunnels = store.listTunnels();
    return { clients: store.listClients().map((client) => serializeClient(client, tunnels)) };
  });

  app.post('/api/clients', { preHandler: requireAuth }, async (request, reply) => {
    const body = parseBody(clientCreateSchema, request.body);
    const token = newAgentToken();
    const client: ClientRow = {
      id: newId(),
      name: body.name,
      note: body.note ?? '',
      token_hash: hashAgentToken(token),
      token_prefix: agentTokenPrefix(token),
      node_id: 'local',
      created_at: Date.now(),
      last_seen_at: null,
    };
    store.createClient(client);
    reply.code(201);
    return {
      client: serializeClient(client, []),
      token,
    };
  });

  app.patch('/api/clients/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = store.findClient(id);
    if (!existing) throw new ApiError(404, '客户端不存在');
    const body = parseBody(clientUpdateSchema, request.body);
    store.updateClient(id, body);
    return { ok: true };
  });

  app.delete('/api/clients/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = store.findClient(id);
    if (!existing) throw new ApiError(404, '客户端不存在');
    for (const tunnel of store.listTunnelsByClient(id)) {
      traffic.drop(tunnel.id);
    }
    hub.disconnectClient(id, 'client deleted');
    store.deleteClient(id);
    await tunnelManager.reconcile();
    return { ok: true };
  });

  app.post('/api/clients/:id/token', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = store.findClient(id);
    if (!existing) throw new ApiError(404, '客户端不存在');
    const token = newAgentToken();
    store.updateClientToken(id, hashAgentToken(token), agentTokenPrefix(token));
    hub.disconnectClient(id, 'token rotated');
    return { token };
  });

  // ---------- tunnels ----------

  function assertPortAvailable(port: number, excludeTunnelId?: string): void {
    if (port === config.port) {
      throw new ApiError(409, `端口 ${port} 是面板端口，不能用于隧道`);
    }
    const occupied = store.findTunnelByRemotePort(port);
    if (occupied && occupied.id !== excludeTunnelId) {
      throw new ApiError(409, `端口 ${port} 已被隧道「${occupied.name}」占用`);
    }
  }

  app.get('/api/tunnels', { preHandler: requireAuth }, async () => {
    const clients = store.listClients();
    const names = new Map(clients.map((client) => [client.id, client.name]));
    return {
      tunnels: store
        .listTunnels()
        .map((tunnel) => serializeTunnel(tunnel, names.get(tunnel.client_id) ?? '已删除客户端')),
    };
  });

  app.post('/api/tunnels', { preHandler: requireAuth }, async (request, reply) => {
    const body = parseBody(tunnelCreateSchema, request.body);
    const client = store.findClient(body.clientId);
    if (!client) throw new ApiError(404, '客户端不存在');
    assertPortAvailable(body.remotePort);

    const tunnel: TunnelRow = {
      id: newId(),
      client_id: body.clientId,
      name: body.name,
      protocol: 'tcp',
      local_host: body.localHost,
      local_port: body.localPort,
      remote_port: body.remotePort,
      enabled: body.enabled ? 1 : 0,
      created_at: Date.now(),
    };
    store.createTunnel(tunnel);
    await tunnelManager.reconcile();
    hub.syncClient(tunnel.client_id);
    reply.code(201);
    return { tunnel: serializeTunnel(tunnel, client.name) };
  });

  app.patch('/api/tunnels/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = store.findTunnel(id);
    if (!existing) throw new ApiError(404, '隧道不存在');
    const body = parseBody(tunnelUpdateSchema, request.body);

    if (body.remotePort !== undefined) {
      assertPortAvailable(body.remotePort, id);
    }

    store.updateTunnel(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.localHost !== undefined ? { local_host: body.localHost } : {}),
      ...(body.localPort !== undefined ? { local_port: body.localPort } : {}),
      ...(body.remotePort !== undefined ? { remote_port: body.remotePort } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled ? 1 : 0 } : {}),
    });
    await tunnelManager.reconcile();
    hub.syncClient(existing.client_id);
    const updated = store.findTunnel(id);
    const client = store.findClient(existing.client_id);
    return {
      tunnel: updated
        ? serializeTunnel(updated, client?.name ?? '已删除客户端')
        : null,
    };
  });

  app.delete('/api/tunnels/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = store.findTunnel(id);
    if (!existing) throw new ApiError(404, '隧道不存在');
    store.deleteTunnel(id);
    traffic.drop(id);
    await tunnelManager.reconcile();
    hub.syncClient(existing.client_id);
    return { ok: true };
  });

}
