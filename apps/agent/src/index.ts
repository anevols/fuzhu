import net from 'node:net';
import dgram from 'node:dgram';
import { WebSocket } from 'ws';
import {
  FRAME,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  type AuthErrorPayload,
  type AuthOk,
  type OpenErrorPayload,
  type OpenRequest,
  type SyncPayload,
  type TunnelSpec,
} from '@tunnel/protocol';

const VERSION = '0.1.0';
const HEARTBEAT_MS = 25_000;
const CONNECT_TIMEOUT_MS = 15_000;

interface Options {
  server: string;
  token: string;
  insecure: boolean;
  verbose: boolean;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function printHelp(): void {
  console.log(`tunnel-agent ${VERSION}

用法:
  tunnel-agent --server ws://<公网地址>:8787/agent --token <客户端令牌>

参数:
  --server <url>   服务端 WebSocket 地址，也可用环境变量 TUNNEL_SERVER
  --token <token>  客户端令牌，也可用环境变量 TUNNEL_TOKEN（推荐，避免出现在进程列表）
  --insecure       跳过 TLS 证书校验（仅自签名证书调试时使用）
  --verbose        输出连接级别的调试日志
  -h, --help       显示帮助
`);
}

function parseCli(argv: string[]): Options | null {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return null;
  }

  let server = process.env.TUNNEL_SERVER ?? '';
  let token = process.env.TUNNEL_TOKEN ?? '';
  let insecure = process.env.TUNNEL_INSECURE === '1' || process.env.TUNNEL_INSECURE === 'true';
  let verbose = process.env.TUNNEL_DEBUG === '1' || process.env.TUNNEL_DEBUG === 'true';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = args[i + 1];
      if (next === undefined) throw new Error(`参数 ${key} 缺少值`);
      i += 1;
      return next;
    };

    switch (key) {
      case '--server':
        server = value();
        break;
      case '--token':
        token = value();
        break;
      case '--insecure':
        insecure = true;
        break;
      case '--verbose':
        verbose = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }

  if (!server) throw new Error('缺少 --server，或设置环境变量 TUNNEL_SERVER');
  if (!token) throw new Error('缺少 --token，或设置环境变量 TUNNEL_TOKEN');
  if (!/^wss?:\/\//.test(server)) {
    throw new Error('--server 必须是 ws:// 或 wss:// 地址');
  }
  return { server, token, insecure, verbose };
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

class Agent {
  private ws: WebSocket | null = null;
  private readonly tunnels = new Map<string, TunnelSpec>();
  private readonly streams = new Map<number, net.Socket>();
  private readonly udpStreams = new Map<number, dgram.Socket>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: Options) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupConnection();
    this.ws?.close(1000, 'agent stopped');
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.options.server, {
      handshakeTimeout: 15_000,
      rejectUnauthorized: !this.options.insecure,
      maxPayload: 32 * 1024 * 1024,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.log('debug', `WebSocket 已连接: ${this.options.server}`);
      this.sendJson(FRAME.Auth, 0, {
        token: this.options.token,
        agentVersion: VERSION,
      });
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, HEARTBEAT_MS);
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        ws.close(4005, 'binary frames required');
        return;
      }
      let frame;
      try {
        frame = decodeFrame(toBuffer(data));
      } catch {
        ws.close(4006, 'malformed frame');
        return;
      }
      try {
        this.handleFrame(frame.type, frame.streamId, frame.payload);
      } catch (error) {
        this.log('error', `处理帧失败: ${(error as Error).message}`);
      }
    });

    ws.on('close', (code, reason) => {
      this.log('warn', `连接关闭 (${code}) ${reason.toString()}`.trim());
      this.cleanupConnection();
      this.scheduleReconnect();
    });

    ws.on('error', (error) => {
      this.log('warn', `连接错误: ${error.message}`);
    });
  }

  private handleFrame(type: number, streamId: number, payload: Buffer): void {
    switch (type) {
      case FRAME.AuthOk:
        this.handleAuthOk(decodeJson<AuthOk>(payload));
        break;
      case FRAME.AuthError:
        this.handleAuthError(decodeJson<AuthErrorPayload>(payload));
        break;
      case FRAME.Sync:
        this.handleSync(decodeJson<SyncPayload>(payload));
        break;
      case FRAME.Open:
        this.handleOpen(streamId, decodeJson<OpenRequest>(payload));
        break;
      case FRAME.Data: {
        const udp = this.udpStreams.get(streamId);
        if (udp) udp.send(payload);
        else this.streams.get(streamId)?.write(payload);
        break;
      }
      case FRAME.Close: {
        const udp = this.udpStreams.get(streamId);
        if (udp) {
          this.dropUdpStream(streamId, udp, false);
          break;
        }
        const socket = this.streams.get(streamId);
        if (socket) this.dropStream(streamId, socket, false);
        break;
      }
      default:
        this.log('debug', `忽略未知帧类型 ${type}`);
        break;
    }
  }

  private handleAuthOk(payload: AuthOk): void {
    this.reconnectAttempt = 0;
    this.log('info', `已接入服务端，客户端: ${payload.clientName} (${payload.clientId})`);
  }

  private handleAuthError(payload: AuthErrorPayload): void {
    this.log('error', `认证失败: ${payload.message}`);
    this.stopped = true;
    this.ws?.close(4003, 'auth failed');
    process.exitCode = 1;
  }

  private handleSync(payload: SyncPayload): void {
    this.tunnels.clear();
    for (const tunnel of payload.tunnels) {
      this.tunnels.set(tunnel.id, tunnel);
    }
    if (payload.tunnels.length === 0) {
      this.log('info', '当前没有启用的隧道');
      return;
    }
    const summary = payload.tunnels
      .map((t) => `${t.name} -> ${t.localHost}:${t.localPort}`)
      .join(', ');
    this.log('info', `已同步 ${payload.tunnels.length} 条隧道: ${summary}`);
  }

  private handleOpen(streamId: number, payload: OpenRequest): void {
    const tunnel = this.tunnels.get(payload.tunnelId);
    if (!tunnel) {
      this.sendJson(FRAME.OpenError, streamId, { message: '隧道配置已失效，请重新同步' });
      return;
    }

    if (tunnel.protocol === 'udp') {
      this.handleUdpOpen(streamId, tunnel);
      return;
    }

    const previous = this.streams.get(streamId);
    if (previous) {
      previous.destroy();
      this.streams.delete(streamId);
    }

    const socket = net.connect({ host: tunnel.localHost, port: tunnel.localPort });
    this.streams.set(streamId, socket);
    socket.setNoDelay(true);
    let connected = false;

    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (!connected) {
        this.failStream(streamId, socket, `连接 ${tunnel.localHost}:${tunnel.localPort} 超时`);
      }
    });

    socket.on('connect', () => {
      connected = true;
      socket.setTimeout(0);
      this.sendFrame(FRAME.OpenOk, streamId);
      this.log('debug', `[${tunnel.name}] 连接内网服务 ${tunnel.localHost}:${tunnel.localPort}`);
    });

    socket.on('data', (chunk: Buffer) => {
      this.sendFrame(FRAME.Data, streamId, chunk);
    });

    socket.on('close', () => {
      this.dropStream(streamId, socket, true);
    });

    socket.on('error', (error) => {
      if (!connected) {
        this.failStream(streamId, socket, error.message);
      } else {
        this.log('warn', `[${tunnel.name}] 连接中断: ${error.message}`);
        this.dropStream(streamId, socket, true);
      }
    });
  }

  private handleUdpOpen(streamId: number, tunnel: TunnelSpec): void {
    const previous = this.udpStreams.get(streamId);
    if (previous) {
      try {
        previous.close();
      } catch {
        // ignore
      }
      this.udpStreams.delete(streamId);
    }

    const socket = dgram.createSocket('udp4');
    this.udpStreams.set(streamId, socket);

    socket.on('message', (message) => {
      this.sendFrame(FRAME.Data, streamId, message);
    });

    socket.on('error', (error) => {
      if (this.udpStreams.get(streamId) !== socket) return;
      this.udpStreams.delete(streamId);
      this.sendJson(FRAME.OpenError, streamId, { message: error.message });
      this.log('warn', `[${tunnel.name}] UDP 连接异常: ${error.message}`);
      try {
        socket.close();
      } catch {
        // ignore
      }
    });

    try {
      socket.connect(tunnel.localPort, tunnel.localHost, () => {
        if (this.udpStreams.get(streamId) !== socket) return;
        this.sendFrame(FRAME.OpenOk, streamId);
        this.log('debug', `[${tunnel.name}] UDP 连接内网服务 ${tunnel.localHost}:${tunnel.localPort}`);
      });
    } catch (error) {
      this.udpStreams.delete(streamId);
      this.sendJson(FRAME.OpenError, streamId, { message: (error as Error).message });
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }

  private dropUdpStream(streamId: number, socket: dgram.Socket, notify: boolean): void {
    if (this.udpStreams.get(streamId) !== socket) return;
    this.udpStreams.delete(streamId);
    try {
      socket.close();
    } catch {
      // ignore
    }
    if (notify) this.sendFrame(FRAME.Close, streamId);
  }

  private failStream(streamId: number, socket: net.Socket, message: string): void {
    if (this.streams.get(streamId) !== socket) return;
    this.streams.delete(streamId);
    const payload: OpenErrorPayload = { message };
    this.sendJson(FRAME.OpenError, streamId, payload);
    socket.destroy();
  }

  private dropStream(streamId: number, socket: net.Socket, notify: boolean): void {
    if (this.streams.get(streamId) !== socket) return;
    this.streams.delete(streamId);
    socket.destroy();
    if (notify) this.sendFrame(FRAME.Close, streamId);
  }

  private cleanupConnection(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const socket of this.streams.values()) {
      socket.destroy();
    }
    this.streams.clear();
    for (const socket of this.udpStreams.values()) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    this.udpStreams.clear();
    this.tunnels.clear();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
    const delay = base + Math.floor(Math.random() * 500);
    this.reconnectAttempt += 1;
    this.log('info', `${Math.round(delay / 1000)} 秒后重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendFrame(type: number, streamId: number, payload?: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeFrame(type, streamId, payload ?? Buffer.alloc(0)));
  }

  private sendJson(type: number, streamId: number, value: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeJsonFrame(type, streamId, value));
  }

  private log(level: LogLevel, message: string): void {
    if (level === 'debug' && !this.options.verbose) return;
    const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `${time} [${level}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

let options: Options | null;
try {
  options = parseCli(process.argv);
} catch (error) {
  console.error(`参数错误: ${(error as Error).message}`);
  printHelp();
  process.exit(1);
}

if (options) {
  const agent = new Agent(options);
  agent.start();

  const shutdown = (signal: string): void => {
    console.log(`收到 ${signal}，正在退出`);
    agent.stop();
    setTimeout(() => process.exit(0), 100);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
