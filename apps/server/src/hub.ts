import type { Socket } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocket } from 'ws';
import {
  FRAME,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  type AuthOk,
  type AuthRequest,
  type DecodedFrame,
  type OpenErrorPayload,
  type OpenRequest,
  type SyncPayload,
  type TunnelProtocol,
  type TunnelSpec,
} from '@tunnel/protocol';
import type { Store, TunnelRow } from './db';
import { hashAgentToken } from './security';

export interface TrafficSnapshot {
  inbound: number;
  outbound: number;
  connections: number;
  activeConnections: number;
  lastActiveAt: number | null;
}

const EMPTY_TRAFFIC: TrafficSnapshot = {
  inbound: 0,
  outbound: 0,
  connections: 0,
  activeConnections: 0,
  lastActiveAt: null,
};

export class TrafficStore {
  private readonly map = new Map<string, TrafficSnapshot>();

  get(tunnelId: string): TrafficSnapshot {
    return this.map.get(tunnelId) ?? EMPTY_TRAFFIC;
  }

  addInbound(tunnelId: string, bytes: number): void {
    const item = this.ensure(tunnelId);
    item.inbound += bytes;
    item.lastActiveAt = Date.now();
  }

  addOutbound(tunnelId: string, bytes: number): void {
    const item = this.ensure(tunnelId);
    item.outbound += bytes;
    item.lastActiveAt = Date.now();
  }

  openConnection(tunnelId: string): void {
    const item = this.ensure(tunnelId);
    item.connections += 1;
    item.activeConnections += 1;
    item.lastActiveAt = Date.now();
  }

  closeConnection(tunnelId: string): void {
    const item = this.ensure(tunnelId);
    item.activeConnections = Math.max(0, item.activeConnections - 1);
  }

  drop(tunnelId: string): void {
    this.map.delete(tunnelId);
  }

  private ensure(tunnelId: string): TrafficSnapshot {
    let item = this.map.get(tunnelId);
    if (!item) {
      item = { ...EMPTY_TRAFFIC };
      this.map.set(tunnelId, item);
    }
    return item;
  }
}

interface ServerStream {
  id: number;
  tunnelId: string;
  socket: Socket;
  opened: boolean;
}

function toSpec(tunnel: TunnelRow): TunnelSpec {
  return {
    id: tunnel.id,
    name: tunnel.name,
    protocol: tunnel.protocol as TunnelProtocol,
    localHost: tunnel.local_host,
    localPort: tunnel.local_port,
  };
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

class MuxConnection {
  private readonly streams = new Map<number, ServerStream>();
  private nextStreamId = 1;
  private authTimer: NodeJS.Timeout | null = null;

  clientId = '';
  clientName = '';
  authenticated = false;

  constructor(
    private readonly hub: AgentHub,
    private readonly ws: WebSocket,
  ) {}

  start(): void {
    this.authTimer = setTimeout(() => {
      if (!this.authenticated) {
        this.ws.close(4001, 'auth timeout');
      }
    }, 10_000);

    this.ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.ws.close(4005, 'binary frames required');
        return;
      }
      let frame: DecodedFrame;
      try {
        frame = decodeFrame(toBuffer(data));
      } catch {
        this.ws.close(4006, 'malformed frame');
        return;
      }
      this.handleFrame(frame);
    });

    this.ws.on('close', () => this.handleClose());
    this.ws.on('error', (error) => {
      this.hub.logger.warn({ err: error, clientId: this.clientId }, 'agent websocket error');
    });
  }

  close(code = 1000, reason = 'closed'): void {
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  sync(tunnels: TunnelSpec[]): void {
    const payload: SyncPayload = { tunnels };
    this.sendJson(FRAME.Sync, 0, payload);
  }

  openStream(tunnel: TunnelSpec, socket: Socket): void {
    const id = this.nextStreamId++;
    if (this.nextStreamId > 0xffffffff) this.nextStreamId = 1;

    const stream: ServerStream = { id, tunnelId: tunnel.id, socket, opened: false };
    this.streams.set(id, stream);

    socket.pause();
    socket.setNoDelay(true);

    const openPayload: OpenRequest = { tunnelId: tunnel.id };
    this.sendJson(FRAME.Open, id, openPayload);

    socket.on('data', (chunk: Buffer) => {
      if (!stream.opened) return;
      this.hub.traffic.addInbound(tunnel.id, chunk.length);
      this.sendFrame(FRAME.Data, id, chunk);
    });
    socket.on('close', () => this.dropStream(id, true));
    socket.on('end', () => this.dropStream(id, true));
    socket.on('error', () => {
      socket.destroy();
      this.dropStream(id, true);
    });
  }

  private handleFrame(frame: DecodedFrame): void {
    switch (frame.type) {
      case FRAME.Auth:
        this.handleAuth(frame);
        break;
      case FRAME.OpenOk:
        this.handleOpenOk(frame.streamId);
        break;
      case FRAME.OpenError:
        this.handleOpenError(frame);
        break;
      case FRAME.Data:
        this.handleData(frame);
        break;
      case FRAME.Close:
        this.dropStream(frame.streamId, false);
        break;
      default:
        break;
    }
  }

  private handleAuth(frame: DecodedFrame): void {
    if (this.authenticated) return;
    let request: AuthRequest;
    try {
      request = decodeJson<AuthRequest>(frame.payload);
    } catch {
      this.sendJson(FRAME.AuthError, 0, { message: 'invalid auth payload' });
      this.close(4007, 'invalid auth payload');
      return;
    }
    const client = this.hub.store.findClientByTokenHash(hashAgentToken(request.token ?? ''));
    if (!client) {
      this.sendJson(FRAME.AuthError, 0, { message: 'invalid token' });
      this.close(4003, 'invalid token');
      return;
    }

    this.clientId = client.id;
    this.clientName = client.name;
    this.authenticated = true;
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }

    const previous = this.hub.attach(this);
    previous?.close(4002, 'replaced by a new connection');

    this.hub.store.touchClient(client.id, Date.now());
    const ok: AuthOk = {
      clientId: client.id,
      clientName: client.name,
      serverVersion: this.hub.version,
    };
    this.sendJson(FRAME.AuthOk, 0, ok);
    this.hub.syncClient(client.id);
    this.hub.notifyOnline(client.id);
  }

  private handleOpenOk(streamId: number): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.opened) return;
    stream.opened = true;
    this.hub.traffic.openConnection(stream.tunnelId);
    stream.socket.resume();
  }

  private handleOpenError(frame: DecodedFrame): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    let message = 'open failed';
    try {
      message = decodeJson<OpenErrorPayload>(frame.payload).message ?? message;
    } catch {
      // ignore malformed payload
    }
    this.hub.logger.warn(
      { clientId: this.clientId, tunnelId: stream.tunnelId, message },
      'agent failed to open local target',
    );
    this.dropStream(frame.streamId, false);
  }

  private handleData(frame: DecodedFrame): void {
    const stream = this.streams.get(frame.streamId);
    if (!stream || !stream.opened) return;
    this.hub.traffic.addOutbound(stream.tunnelId, frame.payload.length);
    stream.socket.write(frame.payload);
  }

  private dropStream(streamId: number, notifyAgent: boolean): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    if (stream.opened) {
      this.hub.traffic.closeConnection(stream.tunnelId);
    }
    if (!stream.socket.destroyed) {
      stream.socket.destroy();
    }
    if (notifyAgent) {
      this.sendFrame(FRAME.Close, streamId);
    }
  }

  private handleClose(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    for (const id of [...this.streams.keys()]) {
      this.dropStream(id, false);
    }
    const wasCurrent = this.hub.detach(this);
    if (wasCurrent && this.authenticated) {
      this.hub.notifyOffline(this.clientId);
    }
  }

  private sendFrame(type: number, streamId: number, payload?: Buffer): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeFrame(type, streamId, payload ?? Buffer.alloc(0)));
  }

  private sendJson(type: number, streamId: number, value: unknown): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeJsonFrame(type, streamId, value));
  }
}

export interface AgentHubHooks {
  onClientOnline?: (clientId: string) => void;
  onClientOffline?: (clientId: string) => void;
}

export class AgentHub {
  readonly version: string;
  private readonly connections = new Map<string, MuxConnection>();
  private hooks: AgentHubHooks = {};

  constructor(
    readonly store: Store,
    readonly traffic: TrafficStore,
    readonly logger: FastifyBaseLogger,
    version: string,
  ) {
    this.version = version;
  }

  setHooks(hooks: AgentHubHooks): void {
    this.hooks = hooks;
  }

  handleConnection(ws: WebSocket): void {
    new MuxConnection(this, ws).start();
  }

  attach(connection: MuxConnection): MuxConnection | undefined {
    const previous = this.connections.get(connection.clientId);
    this.connections.set(connection.clientId, connection);
    return previous;
  }

  detach(connection: MuxConnection): boolean {
    if (this.connections.get(connection.clientId) !== connection) return false;
    this.connections.delete(connection.clientId);
    return true;
  }

  isOnline(clientId: string): boolean {
    return this.connections.has(clientId);
  }

  get onlineIds(): Set<string> {
    return new Set(this.connections.keys());
  }

  get onlineCount(): number {
    return this.connections.size;
  }

  openStream(clientId: string, tunnel: TunnelSpec, socket: Socket): void {
    const connection = this.connections.get(clientId);
    if (!connection || !connection.authenticated) {
      socket.destroy();
      return;
    }
    connection.openStream(tunnel, socket);
  }

  syncClient(clientId: string): void {
    const connection = this.connections.get(clientId);
    if (!connection) return;
    const tunnels = this.store
      .listTunnelsByClient(clientId)
      .filter((tunnel) => tunnel.enabled === 1)
      .map(toSpec);
    connection.sync(tunnels);
  }

  disconnectClient(clientId: string, reason = 'disconnected'): void {
    this.connections.get(clientId)?.close(4004, reason);
  }

  closeAll(): void {
    for (const connection of this.connections.values()) {
      connection.close(1001, 'server shutting down');
    }
    this.connections.clear();
  }

  notifyOnline(clientId: string): void {
    this.hooks.onClientOnline?.(clientId);
  }

  notifyOffline(clientId: string): void {
    this.hooks.onClientOffline?.(clientId);
  }
}
