import net from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import type { TunnelSpec } from '@tunnel/protocol';
import type { Store, TunnelRow } from './db';
import type { AgentHub } from './hub';

interface ListenerEntry {
  server: net.Server;
  tunnelId: string;
  sockets: Set<net.Socket>;
}

export interface TunnelRuntimeStatus {
  listening: boolean;
  error?: string;
}

function specOf(tunnel: TunnelRow): TunnelSpec {
  return {
    id: tunnel.id,
    name: tunnel.name,
    protocol: 'tcp',
    localHost: tunnel.local_host,
    localPort: tunnel.local_port,
  };
}

function describeBindError(error: Error, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') return `端口 ${port} 已被占用`;
  if (code === 'EACCES') return `没有权限监听端口 ${port}（1024 以下端口通常需要 root）`;
  return error.message;
}

export class TunnelManager {
  private readonly listeners = new Map<number, ListenerEntry>();
  private readonly errors = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly hub: AgentHub,
    private readonly logger: FastifyBaseLogger,
  ) {}

  /** 串行执行，避免并发增删隧道时端口状态错乱 */
  reconcile(): Promise<void> {
    this.queue = this.queue
      .then(() => this.doReconcile())
      .catch((error) => {
        this.logger.error({ err: error }, 'failed to reconcile tunnel listeners');
      });
    return this.queue;
  }

  get listeningPorts(): number[] {
    return [...this.listeners.keys()].sort((a, b) => a - b);
  }

  status(tunnelId: string, remotePort: number): TunnelRuntimeStatus {
    const listener = this.listeners.get(remotePort);
    const error = this.errors.get(tunnelId);
    return {
      listening: listener?.tunnelId === tunnelId,
      ...(error ? { error } : {}),
    };
  }

  async close(): Promise<void> {
    for (const entry of this.listeners.values()) {
      this.closeEntry(entry);
    }
    this.listeners.clear();
    await this.queue;
  }

  private async doReconcile(): Promise<void> {
    const online = this.hub.onlineIds;
    const desired = new Map<number, TunnelRow>();
    const seen = new Set<string>();

    for (const tunnel of this.store.listTunnels()) {
      if (tunnel.enabled !== 1) continue;
      if (!online.has(tunnel.client_id)) continue;
      const occupied = desired.get(tunnel.remote_port);
      if (occupied) {
        this.errors.set(
          tunnel.id,
          `端口 ${tunnel.remote_port} 已被隧道「${occupied.name}」占用`,
        );
        continue;
      }
      desired.set(tunnel.remote_port, tunnel);
      seen.add(tunnel.id);
    }

    for (const [port, entry] of [...this.listeners.entries()]) {
      const wanted = desired.get(port);
      if (!wanted || wanted.id !== entry.tunnelId) {
        this.logger.info({ port, tunnelId: entry.tunnelId }, 'closing tunnel listener');
        this.closeEntry(entry);
        this.listeners.delete(port);
      }
    }

    for (const [port, tunnel] of desired) {
      if (this.listeners.has(port)) continue;
      await this.bind(port, tunnel);
    }

    for (const tunnelId of [...this.errors.keys()]) {
      if (!seen.has(tunnelId)) this.errors.delete(tunnelId);
    }
  }

  private bind(port: number, tunnel: TunnelRow): Promise<void> {
    return new Promise((resolve) => {
      const entry: ListenerEntry = {
        server: net.createServer(),
        tunnelId: tunnel.id,
        sockets: new Set(),
      };
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      entry.server.on('connection', (socket) => {
        entry.sockets.add(socket);
        socket.on('close', () => entry.sockets.delete(socket));

        const live = this.store.findTunnel(tunnel.id);
        if (!live || live.enabled !== 1 || !this.hub.isOnline(live.client_id)) {
          socket.destroy();
          return;
        }
        this.hub.openStream(live.client_id, specOf(live), socket);
      });

      entry.server.on('error', (error: Error) => {
        const message = describeBindError(error, port);
        this.errors.set(tunnel.id, message);
        this.logger.error({ port, tunnelId: tunnel.id, err: error }, 'tunnel listener error');
        finish();
      });

      entry.server.listen(port, '0.0.0.0', () => {
        this.listeners.set(port, entry);
        this.errors.delete(tunnel.id);
        this.logger.info(
          { port, tunnelId: tunnel.id, clientId: tunnel.client_id },
          'tunnel listener started',
        );
        finish();
      });
    });
  }

  private closeEntry(entry: ListenerEntry): void {
    for (const socket of entry.sockets) {
      socket.destroy();
    }
    entry.sockets.clear();
    entry.server.close();
  }
}
