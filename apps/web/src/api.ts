export interface Traffic {
  inbound: number;
  outbound: number;
}

export type UserRole = 'admin' | 'member';

export interface UserInfo {
  id: string;
  username: string;
  role: UserRole;
  createdAt?: string;
  clientCount?: number;
}

export type TunnelProtocol = 'tcp' | 'udp' | 'http';

export interface CertInfo {
  domain: string;
  mode: 'acme' | 'self-signed' | 'pending' | 'error';
  expiresAt: string | null;
  updatedAt: string | null;
  error: string | null;
}

export interface HttpRouterInfo {
  enabled: boolean;
  port: number;
  httpsPort: number;
  listening: boolean;
  httpsListening: boolean;
  error: string | null;
  httpsError: string | null;
  acme: boolean;
}

export interface ClientInfo {
  id: string;
  name: string;
  note: string;
  tokenPrefix: string;
  nodeId: string;
  ownerId: string | null;
  ownerName: string | null;
  online: boolean;
  createdAt: string | null;
  lastSeenAt: string | null;
  tunnelCount: number;
  traffic: Traffic;
}

export type TunnelStatus = 'active' | 'offline' | 'error' | 'disabled';

export interface TunnelInfo {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  protocol: TunnelProtocol;
  localHost: string;
  localPort: number;
  remotePort: number;
  domains: string[];
  certs: CertInfo[];
  enabled: boolean;
  status: TunnelStatus;
  error: string | null;
  listening: boolean;
  connections: number;
  activeConnections: number;
  lastActiveAt: string | null;
  traffic: Traffic;
}

export interface OverviewResponse {
  server: {
    version: string;
    uptimeSec: number;
    onlineClients: number;
    totalClients: number;
    totalTunnels: number;
    listeningPorts: number[];
    http: HttpRouterInfo;
  };
  clients: ClientInfo[];
  tunnels: TunnelInfo[];
}

export interface TunnelInput {
  clientId: string;
  name: string;
  protocol: TunnelProtocol;
  localHost: string;
  localPort: number;
  remotePort?: number;
  domains?: string[];
  enabled?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'include',
      ...init,
      headers,
    });
  } catch {
    throw new ApiError(0, '无法连接服务器，请检查网络');
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message =
      (data as { error?: string } | null)?.error ?? `请求失败 (HTTP ${response.status})`;
    throw new ApiError(response.status, message);
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: UserInfo }>('/api/auth/me'),

  login: (username: string, password: string) =>
    request<{ user: UserInfo }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  overview: () => request<OverviewResponse>('/api/overview'),

  createClient: (input: { name: string; note?: string }) =>
    request<{ client: ClientInfo; token: string }>('/api/clients', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateClient: (id: string, input: { name?: string; note?: string }) =>
    request<{ ok: boolean }>(`/api/clients/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteClient: (id: string) =>
    request<{ ok: boolean }>(`/api/clients/${id}`, { method: 'DELETE' }),

  rotateToken: (id: string) =>
    request<{ token: string }>(`/api/clients/${id}/token`, { method: 'POST' }),

  createTunnel: (input: TunnelInput) =>
    request<{ tunnel: TunnelInfo }>('/api/tunnels', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateTunnel: (id: string, input: Partial<Omit<TunnelInput, 'clientId' | 'protocol'>>) =>
    request<{ tunnel: TunnelInfo | null }>(`/api/tunnels/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteTunnel: (id: string) =>
    request<{ ok: boolean }>(`/api/tunnels/${id}`, { method: 'DELETE' }),

  users: () => request<{ users: UserInfo[] }>('/api/users'),

  createUser: (input: { username: string; password: string; role: UserRole }) =>
    request<{ user: UserInfo }>('/api/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateUser: (id: string, input: { password?: string; role?: UserRole }) =>
    request<{ user: UserInfo | null }>(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteUser: (id: string) =>
    request<{ ok: boolean }>(`/api/users/${id}`, { method: 'DELETE' }),
};
