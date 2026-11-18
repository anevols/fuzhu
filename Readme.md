# Tunnel Console

自建内网穿透控制台：一台公网服务器 + 多个内网 Agent，把公网 TCP 端口转发到内网服务。内置 Web 管理台、客户端令牌、隧道增删改查、在线状态与流量统计，不依赖 frp/nps。

## 特性

- 自研 WebSocket 多路复用隧道协议，控制帧与数据帧共用一条长连接
- 单个端口（默认 `8787`）同时承载管理台、REST API 与 Agent 接入
- 管理台：登录、客户端管理、令牌轮换、隧道启停/编辑、实时状态与流量
- SQLite 持久化（使用 Node 内置 `node:sqlite`，无原生编译依赖）
- Agent 断线指数退避重连，自动同步隧道配置
- 数据模型预留 `node_id`、`protocol` 字段，便于扩展多节点与 UDP/HTTP

## 架构

```
 [浏览器] ──HTTP──▶ :8787 管理台 / API
 [公网用户] ──TCP──▶ :remotePort ─┐
                                  ▼
                         ┌──────────────────┐
                         │   Tunnel Server  │  端口监听 + 流多路复用
                         └────────┬─────────┘
                                  │ WebSocket /agent（二进制帧）
                                  ▼
                         ┌──────────────────┐
                         │      Agent       │
                         └────────┬─────────┘
                                  │ TCP
                                  ▼
                         127.0.0.1:80 / 3389 / ...
```

每个公网 TCP 连接分配一个 `streamId`，通过 `OPEN / DATA / CLOSE` 帧复用同一条 WebSocket。帧格式为 `[1B type][4B streamId][payload]`。

## 环境要求

- Node.js >= 24
- pnpm >= 10

## 快速开始

```bash
pnpm install
pnpm build
```

启动服务端：

```bash
cd apps/server
PORT=8787 \
DATA_DIR=./data \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD='换成强密码' \
node dist/index.js
```

首次启动会创建管理员账号；未设置 `ADMIN_PASSWORD` 时会随机生成并打印到日志（只显示一次）。

然后：

1. 打开 `http://服务器IP:8787`，用管理员账号登录
2. 在「客户端」页新建客户端，复制生成的令牌（只显示一次）
3. 在内网机器启动 Agent：

```bash
TUNNEL_SERVER=ws://服务器IP:8787/agent \
TUNNEL_TOKEN='tk_xxx' \
node apps/agent/dist/index.js
```

4. 在「隧道」页新建隧道，选择客户端，填写内网地址/端口和公网端口
5. 客户端在线后公网端口自动开始监听，访问 `服务器IP:公网端口` 即可

停用或删除隧道会立即释放对应公网端口。

## 开发模式

```bash
pnpm dev:server              # tsx watch，默认 8787
pnpm dev:web                 # Vite，5173，代理 /api 到 8787
pnpm dev:agent -- --server ws://127.0.0.1:8787/agent --token tk_xxx
pnpm typecheck
```

开发时前端访问 `http://127.0.0.1:5173`。

## 配置项

服务端环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 管理台 / API / Agent 接入端口 |
| `HOST` | `0.0.0.0` | 监听地址，用反向代理时可改为 `127.0.0.1` |
| `DATA_DIR` | `./data` | SQLite 数据目录 |
| `ADMIN_USERNAME` | `admin` | 首次初始化管理员用户名 |
| `ADMIN_PASSWORD` | 随机 | 首次初始化管理员密码，仅首次生效 |
| `COOKIE_SECURE` | `false` | HTTPS 部署时设为 `true` |
| `WEB_DIST` | `../web/dist` | 前端构建产物路径 |
| `LOG_LEVEL` | `info` | pino 日志级别 |

Agent 参数 / 环境变量：

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--server` | `TUNNEL_SERVER` | `ws://` 或 `wss://` 地址，需带 `/agent` |
| `--token` | `TUNNEL_TOKEN` | 客户端令牌（推荐用环境变量） |
| `--insecure` | `TUNNEL_INSECURE=1` | 跳过 TLS 证书校验，仅调试自签名证书 |
| `--verbose` | `TUNNEL_DEBUG=1` | 输出连接级调试日志 |

## 生产部署建议

- 用 Nginx/Caddy 反向代理 8787 并启用 HTTPS，Agent 使用 `wss://`，同时设置 `COOKIE_SECURE=true`
- 只开放 8787 和需要的隧道端口，其余端口在防火墙限制来源
- 令牌放在环境变量或受保护的配置文件中，不要写在命令行参数里
- 不要把数据库、RDP 等敏感服务直接暴露公网，建议叠加 VPN 或 IP 白名单
- 定期备份 `DATA_DIR/tunnel.db`

Nginx 示例：

```nginx
server {
  listen 443 ssl;
  server_name tunnel.example.com;
  ssl_certificate     /path/fullchain.pem;
  ssl_certificate_key /path/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  location /agent {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
}
```

## 数据模型

- `users` / `sessions`：管理台账号与会话
- `clients`：内网 Agent，令牌只存 SHA-256 哈希，管理台仅显示前缀
- `tunnels`：转发规则，`protocol` 当前固定 `tcp`，`clients.node_id` 预留多节点

## 当前边界与路线图

已支持：TCP 端口转发、多客户端、单连接多路复用、断线重连、隧道启停、流量与连接统计。

暂未支持：UDP、HTTP 域名路由与自动 HTTPS、P2P 打洞、多用户权限、多 relay 节点、流量配额。协议帧类型和数据模型已留出扩展位。

## 安全说明

- 管理密码使用 scrypt 加盐哈希
- Agent 令牌只存哈希，轮换后旧令牌立即失效并断开 Agent
- 会话 Cookie 为 `httpOnly` + `SameSite=Lax`
- 登录失败按来源 IP 限速
- 生产环境请务必启用 HTTPS/WSS，并限制公网暴露的隧道端口
