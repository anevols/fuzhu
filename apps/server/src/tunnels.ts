import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { Duplex } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import type { TunnelProtocol, TunnelSpec } from '@tunnel/protocol';
import type { Store, TunnelRow } from './db';
import type { AgentHub } from './hub';
import type { CertInfo, CertStore } from './certs';
import type { config as AppConfig } from './config';

const UDP_IDLE_MS = 60_000;
const MAX_HTTP_HEAD = 16 * 1024;

interface TcpEntry {
  server: net.Server;
  tunnelId: string;
  sockets: Set<net.Socket>;
}

interface UdpEntry {
  socket: dgram.Socket;
  tunnelId: string;
  sessions: Map<string, UdpSession>;
}

export interface TunnelRuntimeStatus {
  listening: boolean;
  error?: string;
}

export interface HttpListenerStatus {
  enabled: boolean;
  port: number;
  httpsPort: number;
  listening: boolean;
  httpsListening: boolean;
  error: string | null;
  httpsError: string | null;
  acme: boolean;
}

function specOf(tunnel: TunnelRow): TunnelSpec {
  return {
    id: tunnel.id,
    name: tunnel.name,
    protocol: tunnel.protocol as TunnelProtocol,
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

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  404: 'Not Found',
  503: 'Service Unavailable',
};

/**
 * 把一个 UDP 会话伪装成 Duplex，复用 TCP 的 OPEN/DATA/CLOSE 帧。
 * Agent 回包通过 write() 写回，公网侧的新数据报通过 feed() 注入。
 */
class UdpSession extends Duplex {
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly sendDatagram: (chunk: Buffer) => void) {
    super();
    this.resetIdle();
  }

  _read(): void {
    // 由 feed() 主动 push
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.resetIdle();
    try {
      this.sendDatagram(chunk);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    callback(error);
  }

  setNoDelay(_noDelay?: boolean): void {
    // 兼容 net.Socket 接口
  }

  feed(chunk: Buffer): void {
    if (this.destroyed) return;
    this.resetIdle();
    this.push(chunk);
  }

  private resetIdle(): void {
    if (this.destroyed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.destroy();
    }, UDP_IDLE_MS);
    this.idleTimer.unref?.();
  }
}

export class TunnelManager {
  private readonly tcpListeners = new Map<number, TcpEntry>();
  private readonly udpListeners = new Map<number, UdpEntry>();
  private readonly httpRoutes = new Map<string, TunnelRow>();
  private readonly httpSockets = new Set<net.Socket>();
  private errors = new Map<string, string>();
  private httpServer: net.Server | null = null;
  private httpsServer: tls.Server | null = null;
  private httpListening = false;
  private httpsListening = false;
  private httpError = '';
  private httpsError = '';
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly hub: AgentHub,
    private readonly logger: FastifyBaseLogger,
    private readonly certStore: CertStore,
    private readonly config: typeof AppConfig,
  ) {}

  /** 串行执行，避免并发增删隧道时端口/路由状态错乱 */
  reconcile(): Promise<void> {
    this.queue = this.queue
      .then(() => this.doReconcile())
      .catch((error) => {
        this.logger.error({ err: error }, 'failed to reconcile tunnel listeners');
      });
    return this.queue;
  }

  get listeningPorts(): number[] {
    const ports = new Set<number>([...this.tcpListeners.keys(), ...this.udpListeners.keys()]);
    if (this.httpListening) ports.add(this.config.httpPort);
    if (this.httpsListening) ports.add(this.config.httpsPort);
    return [...ports].sort((a, b) => a - b);
  }

  get httpStatus(): HttpListenerStatus {
    return {
      enabled: this.config.httpRouter,
      port: this.config.httpPort,
      httpsPort: this.config.httpsPort,
      listening: this.httpListening,
      httpsListening: this.httpsListening,
      error: this.httpError || null,
      httpsError: this.httpsError || null,
      acme: this.certStore.acmeEnabled,
    };
  }

  status(tunnel: TunnelRow): TunnelRuntimeStatus {
    let error = this.errors.get(tunnel.id);
    let listening = false;
    if (tunnel.protocol === 'tcp') {
      listening = this.tcpListeners.get(tunnel.remote_port)?.tunnelId === tunnel.id;
    } else if (tunnel.protocol === 'udp') {
      listening = this.udpListeners.get(tunnel.remote_port)?.tunnelId === tunnel.id;
    } else if (tunnel.protocol === 'http') {
      listening =
        this.httpListening &&
        this.store
          .listTunnelDomains(tunnel.id)
          .some((domain) => this.httpRoutes.get(domain)?.id === tunnel.id);
      if (!error && tunnel.enabled === 1 && this.config.httpRouter && !this.httpListening) {
        error = `HTTP 监听失败: ${this.httpError || '未知原因'}`;
      }
    }
    return {
      listening,
      ...(error ? { error } : {}),
    };
  }

  certInfo(tunnelId: string): CertInfo[] {
    return this.store.listTunnelDomains(tunnelId).map((domain) => this.certStore.status(domain));
  }

  async close(): Promise<void> {
    for (const entry of this.tcpListeners.values()) {
      this.closeTcpEntry(entry);
    }
    this.tcpListeners.clear();
    for (const entry of this.udpListeners.values()) {
      this.closeUdpEntry(entry);
    }
    this.udpListeners.clear();
    this.closeHttpServers();
    await this.queue;
  }

  private async doReconcile(): Promise<void> {
    const online = this.hub.onlineIds;
    const tunnels = this.store.listTunnels();
    const domainsByTunnel = new Map<string, string[]>();
    for (const row of this.store.listAllDomains()) {
      const list = domainsByTunnel.get(row.tunnel_id) ?? [];
      list.push(row.domain);
      domainsByTunnel.set(row.tunnel_id, list);
    }

    const errors = new Map<string, string>();
    const desiredTcp = new Map<number, TunnelRow>();
    const desiredUdp = new Map<number, TunnelRow>();
    const desiredRoutes = new Map<string, TunnelRow>();
    const claimedDomains = new Map<string, TunnelRow>();
    let hasHttp = false;

    for (const tunnel of tunnels) {
      if (tunnel.enabled !== 1) continue;
      const domains = domainsByTunnel.get(tunnel.id) ?? [];

      if (tunnel.protocol === 'http') {
        hasHttp = true;
        if (!this.config.httpRouter) {
          errors.set(tunnel.id, 'HTTP 域名路由已被 HTTP_ROUTER=false 关闭');
          continue;
        }
        if (domains.length === 0) {
          errors.set(tunnel.id, '未配置域名，无法进行 HTTP 路由');
          continue;
        }
        if (!online.has(tunnel.client_id)) continue;
        for (const domain of domains) {
          const occupied = claimedDomains.get(domain);
          if (occupied) {
            errors.set(tunnel.id, `域名 ${domain} 已被隧道「${occupied.name}」占用`);
            continue;
          }
          claimedDomains.set(domain, tunnel);
          desiredRoutes.set(domain, tunnel);
        }
        continue;
      }

      if (!online.has(tunnel.client_id)) continue;
      if (tunnel.remote_port < 1 || tunnel.remote_port > 65535) {
        errors.set(tunnel.id, '未配置公网端口');
        continue;
      }
      const target = tunnel.protocol === 'udp' ? desiredUdp : desiredTcp;
      const occupied = target.get(tunnel.remote_port);
      if (occupied) {
        errors.set(
          tunnel.id,
          `端口 ${tunnel.remote_port} 已被隧道「${occupied.name}」占用`,
        );
        continue;
      }
      target.set(tunnel.remote_port, tunnel);
    }

    // TCP/UDP 监听器增减
    for (const [port, entry] of [...this.tcpListeners.entries()]) {
      const wanted = desiredTcp.get(port);
      if (!wanted || wanted.id !== entry.tunnelId) {
        this.logger.info({ port, tunnelId: entry.tunnelId }, 'closing tcp tunnel listener');
        this.closeTcpEntry(entry);
        this.tcpListeners.delete(port);
      }
    }
    for (const [port, entry] of [...this.udpListeners.entries()]) {
      const wanted = desiredUdp.get(port);
      if (!wanted || wanted.id !== entry.tunnelId) {
        this.logger.info({ port, tunnelId: entry.tunnelId }, 'closing udp tunnel listener');
        this.closeUdpEntry(entry);
        this.udpListeners.delete(port);
      }
    }

    for (const [port, tunnel] of desiredTcp) {
      if (this.tcpListeners.has(port)) continue;
      await this.bindTcp(port, tunnel, errors);
    }
    for (const [port, tunnel] of desiredUdp) {
      if (this.udpListeners.has(port)) continue;
      await this.bindUdp(port, tunnel, errors);
    }

    // HTTP/HTTPS 共享监听器
    this.httpRoutes.clear();
    for (const [domain, tunnel] of desiredRoutes) {
      this.httpRoutes.set(domain, tunnel);
    }

    if (hasHttp && this.config.httpRouter) {
      await this.certStore.ensure([...desiredRoutes.keys()]);
      await this.startHttpServer();
      await this.startHttpsServer();
    } else if (!hasHttp) {
      this.closeHttpServers();
    }

    this.errors = errors;
  }

  private bindTcp(port: number, tunnel: TunnelRow, errors: Map<string, string>): Promise<void> {
    return new Promise((resolve) => {
      const entry: TcpEntry = {
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
        errors.set(tunnel.id, describeBindError(error, port));
        this.logger.error({ port, tunnelId: tunnel.id, err: error }, 'tcp listener error');
        finish();
      });

      entry.server.listen(port, '0.0.0.0', () => {
        this.tcpListeners.set(port, entry);
        errors.delete(tunnel.id);
        this.logger.info(
          { port, tunnelId: tunnel.id, clientId: tunnel.client_id },
          'tcp tunnel listener started',
        );
        finish();
      });
    });
  }

  private bindUdp(port: number, tunnel: TunnelRow, errors: Map<string, string>): Promise<void> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const entry: UdpEntry = { socket, tunnelId: tunnel.id, sessions: new Map() };
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      socket.on('message', (message, rinfo) => {
        const live = this.store.findTunnel(tunnel.id);
        if (!live || live.enabled !== 1 || !this.hub.isOnline(live.client_id)) return;
        const key = `${rinfo.address}:${rinfo.port}`;
        let session = entry.sessions.get(key);
        if (!session) {
          let created: UdpSession;
          created = new UdpSession((chunk) => {
            socket.send(chunk, rinfo.port, rinfo.address, (error) => {
              if (error) created.destroy();
            });
          });
          entry.sessions.set(key, created);
          created.once('close', () => {
            entry.sessions.delete(key);
          });
          session = created;
          this.hub.openStream(live.client_id, specOf(live), session as unknown as net.Socket);
        }
        session.feed(message);
      });

      socket.on('error', (error: Error) => {
        errors.set(tunnel.id, describeBindError(error, port));
        this.logger.error({ port, tunnelId: tunnel.id, err: error }, 'udp listener error');
        this.closeUdpEntry(entry);
        if (this.udpListeners.get(port) === entry) this.udpListeners.delete(port);
        finish();
      });

      socket.bind(port, '0.0.0.0', () => {
        this.udpListeners.set(port, entry);
        errors.delete(tunnel.id);
        this.logger.info(
          { port, tunnelId: tunnel.id, clientId: tunnel.client_id },
          'udp tunnel listener started',
        );
        finish();
      });
    });
  }

  private startHttpServer(): Promise<void> {
    if (this.httpServer) return Promise.resolve();
    return new Promise((resolve) => {
      const port = this.config.httpPort;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const server = net.createServer((socket) => this.handleHttpSocket(socket));
      server.on('error', (error: Error) => {
        this.httpError = describeBindError(error, port);
        this.httpListening = false;
        if (this.httpServer === server) this.httpServer = null;
        this.logger.error({ port, err: error }, 'http listener error');
        finish();
      });
      server.listen(port, '0.0.0.0', () => {
        this.httpServer = server;
        this.httpListening = true;
        this.httpError = '';
        this.logger.info({ port }, 'http domain router started');
        finish();
      });
    });
  }

  private async startHttpsServer(): Promise<void> {
    if (this.httpsServer) return;
    const pair = await this.certStore.getDefault();
    const port = this.config.httpsPort;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const server = tls.createServer(
        {
          key: pair.key,
          cert: pair.cert,
          ALPNProtocols: ['http/1.1'],
          SNICallback: (servername, callback) => {
            const context = this.certStore.getContext(servername);
            if (context) {
              callback(null, context);
              return;
            }
            try {
              callback(null, this.certStore.getDefaultContext());
            } catch (error) {
              callback(error as Error);
            }
          },
        },
        (socket) => this.handleHttpsSocket(socket),
      );

      server.on('tlsClientError', (error) => {
        this.logger.debug({ err: error }, 'tls client error');
      });
      server.on('error', (error: Error) => {
        this.httpsError = describeBindError(error, port);
        this.httpsListening = false;
        if (this.httpsServer === server) this.httpsServer = null;
        this.logger.error({ port, err: error }, 'https listener error');
        finish();
      });
      server.listen(port, '0.0.0.0', () => {
        this.httpsServer = server;
        this.httpsListening = true;
        this.httpsError = '';
        this.logger.info(
          { port, acme: this.certStore.acmeEnabled },
          'https domain router started',
        );
        finish();
      });
    });
  }

  private handleHttpSocket(socket: net.Socket): void {
    this.trackHttpSocket(socket);
    this.peekHttpHead(socket, (head) => {
      if (!head) {
        this.respond(socket, 400, '请求头过大或格式不正确');
        return;
      }

      if (head.target.startsWith('/.well-known/acme-challenge/')) {
        const token = head.target
          .slice('/.well-known/acme-challenge/'.length)
          .split('?')[0]!;
        const value = this.certStore.getChallenge(token);
        if (value) this.respond(socket, 200, value);
        else this.respond(socket, 404, 'challenge not found');
        return;
      }

      if (!head.host) {
        this.respond(socket, 400, '缺少 Host 请求头');
        return;
      }
      this.routeHttpSocket(socket, head.host);
    });
  }

  private handleHttpsSocket(socket: tls.TLSSocket): void {
    this.trackHttpSocket(socket);
    socket.on('error', () => undefined);
    const servername =
      typeof socket.servername === 'string'
        ? socket.servername.toLowerCase().replace(/\.$/, '')
        : '';
    if (!servername) {
      socket.destroy();
      return;
    }
    this.routeHttpSocket(socket, servername);
  }

  private routeHttpSocket(socket: net.Socket, host: string): void {
    const route = this.httpRoutes.get(host);
    if (!route) {
      this.respond(socket, 404, `未找到域名 ${host} 对应的隧道`);
      return;
    }
    const live = this.store.findTunnel(route.id);
    if (!live || live.enabled !== 1 || !this.hub.isOnline(live.client_id)) {
      this.respond(socket, 503, '隧道当前不可用');
      return;
    }
    this.hub.openStream(live.client_id, specOf(live), socket);
  }

  /**
   * 读取首个请求头但不消费数据：解析 Host 后 unshift 回 socket，
   * 再把原始字节流交给隧道，从而保留 WebSocket 升级等 HTTP/1.1 行为。
   */
  private peekHttpHead(
    socket: net.Socket,
    done: (head: { target: string; host: string } | null) => void,
  ): void {
    const chunks: Buffer[] = [];
    let total = 0;
    let finished = false;

    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onClose);
    };
    const onClose = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
    };
    const onData = (chunk: Buffer): void => {
      if (finished) return;
      chunks.push(chunk);
      total += chunk.length;
      const buffer = Buffer.concat(chunks, total);
      const index = buffer.indexOf('\r\n\r\n');
      if (index < 0 && total < MAX_HTTP_HEAD) return;

      finished = true;
      cleanup();
      socket.pause();
      if (index < 0) {
        done(null);
        return;
      }

      socket.unshift(buffer);
      const head = buffer.subarray(0, index).toString('latin1');
      const lines = head.split('\r\n');
      const requestLine = lines.shift() ?? '';
      const target = requestLine.split(' ')[1] ?? '/';
      let host = '';
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator > 0 && line.slice(0, separator).toLowerCase() === 'host') {
          host = line.slice(separator + 1).trim().toLowerCase();
        }
      }
      if (host.startsWith('[')) {
        const end = host.indexOf(']');
        host = end >= 0 ? host.slice(0, end + 1) : host;
      } else {
        host = host.split(':')[0] ?? '';
      }
      done({ target, host: host.replace(/\.$/, '') });
    };

    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onClose);
  }

  private respond(socket: net.Socket, status: number, body: string): void {
    if (socket.destroyed) return;
    const text = Buffer.from(body, 'utf8');
    const head =
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'OK'}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${text.length}\r\n` +
      'Connection: close\r\n\r\n';
    socket.write(head);
    socket.end(text);
  }

  private trackHttpSocket(socket: net.Socket): void {
    this.httpSockets.add(socket);
    socket.once('close', () => this.httpSockets.delete(socket));
    socket.on('error', () => undefined);
  }

  private closeHttpServers(): void {
    for (const socket of this.httpSockets) {
      socket.destroy();
    }
    this.httpSockets.clear();
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    if (this.httpsServer) {
      this.httpsServer.close();
      this.httpsServer = null;
    }
    this.httpListening = false;
    this.httpsListening = false;
  }

  private closeTcpEntry(entry: TcpEntry): void {
    for (const socket of entry.sockets) {
      socket.destroy();
    }
    entry.sockets.clear();
    entry.server.close();
  }

  private closeUdpEntry(entry: UdpEntry): void {
    for (const session of entry.sessions.values()) {
      session.destroy();
    }
    entry.sessions.clear();
    try {
      entry.socket.close();
    } catch {
      // 未绑定时 close 会抛错，忽略
    }
  }
}
