import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { WebSocketServer } from 'ws';
import { registerApi } from './api';
import { config } from './config';
import { Store } from './db';
import { AgentHub, TrafficStore } from './hub';
import { hashPassword, newId, randomPassword } from './security';
import { TunnelManager } from './tunnels';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const store = new Store(path.join(config.dataDir, 'tunnel.db'));
  store.deleteExpiredSessions(Date.now());

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  const traffic = new TrafficStore();
  const hub = new AgentHub(store, traffic, app.log, config.version);
  const tunnelManager = new TunnelManager(store, hub, app.log);

  hub.setHooks({
    onClientOnline: () => {
      void tunnelManager.reconcile();
    },
    onClientOffline: () => {
      void tunnelManager.reconcile();
    },
  });

  await app.register(cookie);
  registerApi(app, { store, hub, tunnelManager, traffic, config, startedAt });

  const indexFile = path.join(config.webDist, 'index.html');
  if (existsSync(indexFile)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: '接口不存在' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`未找到前端构建产物: ${config.webDist}，仅提供 API`);
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: '接口不存在' });
      }
      return reply.code(404).send({ error: '前端尚未构建，请先执行 pnpm build' });
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/agent') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      hub.handleConnection(ws);
    });
  });

  if (store.countUsers() === 0) {
    const password = config.adminPassword || randomPassword(16);
    store.createUser({
      id: newId(),
      username: config.adminUsername,
      password_hash: hashPassword(password),
      created_at: Date.now(),
    });
    app.log.info(`已创建管理员账号: ${config.adminUsername}`);
    if (config.adminPassword) {
      app.log.info('管理员密码来自 ADMIN_PASSWORD 环境变量');
    } else {
      app.log.warn(`随机生成的管理员密码: ${password}`);
      app.log.warn('该密码只显示一次，请立即记录并通过 ADMIN_PASSWORD 重新初始化');
    }
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`控制台地址: http://${config.host}:${config.port}`);
  app.log.info(`Agent 接入地址: ws://${config.host}:${config.port}/agent`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    wss.close();
    hub.closeAll();
    await tunnelManager.close();
    await app.close();
    store.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('服务启动失败', error);
  process.exit(1);
});
