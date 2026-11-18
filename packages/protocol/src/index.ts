/**
 * 控制帧与数据帧共用一条 WebSocket 连接。
 * 帧结构: [1B type][4B streamId][payload]
 */
export const FRAME = {
  Auth: 1,
  AuthOk: 2,
  AuthError: 3,
  Sync: 4,
  Open: 5,
  OpenOk: 6,
  OpenError: 7,
  Data: 8,
  Close: 9,
} as const;

export type FrameType = (typeof FRAME)[keyof typeof FRAME];

const HEADER_SIZE = 5;

export interface TunnelSpec {
  id: string;
  name: string;
  protocol: 'tcp';
  localHost: string;
  localPort: number;
}

export interface AuthRequest {
  token: string;
  agentVersion?: string;
}

export interface AuthOk {
  clientId: string;
  clientName: string;
  serverVersion: string;
}

export interface AuthErrorPayload {
  message: string;
}

export interface SyncPayload {
  tunnels: TunnelSpec[];
}

export interface OpenRequest {
  tunnelId: string;
}

export interface OpenErrorPayload {
  message: string;
}

export function encodeFrame(
  type: number,
  streamId = 0,
  payload: Buffer | string = Buffer.alloc(0),
): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const frame = Buffer.allocUnsafe(HEADER_SIZE + body.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(streamId >>> 0, 1);
  body.copy(frame, HEADER_SIZE);
  return frame;
}

export function encodeJsonFrame(type: number, streamId = 0, value: unknown): Buffer {
  return encodeFrame(type, streamId, JSON.stringify(value));
}

export interface DecodedFrame {
  type: number;
  streamId: number;
  payload: Buffer;
}

export function decodeFrame(data: Buffer): DecodedFrame {
  if (data.length < HEADER_SIZE) {
    throw new Error('frame too short');
  }
  return {
    type: data.readUInt8(0),
    streamId: data.readUInt32BE(1),
    payload: data.subarray(HEADER_SIZE),
  };
}

export function decodeJson<T>(payload: Buffer): T {
  return JSON.parse(payload.toString('utf8')) as T;
}
