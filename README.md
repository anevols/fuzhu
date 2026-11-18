# Tunnel Console

自建内网穿透控制台：一台公网服务器 + 多个内网 Agent，把公网流量转发到内网服务。支持 TCP 端口、UDP 端口、HTTP 域名路由（含自动 HTTPS），内置 Web 管理台、客户端令牌、多用户权限、在线状态与流量统计，不依赖 frp/nps。

## 特性

- 自研 WebSocket 多路复用隧道协议，控制帧与数据帧共用一条长连接
- 三种隧道：TCP 端口转发、UDP 端口转发、HTTP 域名路由 + 自动 HTTPS
- HTTP 隧道按 Host/SNI 路由，支持 WebSocket 升级；证书支持 ACME（Let's Encrypt）或自签名兜底
- 多用户权限：管理员管理全局，成员只能看到并管理自己名下的客户端与隧道
- 单个端口（默认 `8787`）同时承载管理台、REST API 与 Agent 接入
- 管理台：登录、客户端管理、令牌轮换、隧道启停/编辑、实时状态与流量、用户管理
- SQLite 持久化（使用 Node 内置 `node:sqlite`，无原生编译依赖），旧库自动迁移
- Agent 断线指数退避重连，自动同步隧道配置

## 架构

```
 [浏览器] ──HTTP──▶ :8787 管理台 / API
 [公网用户] ──TCP/UDP──▶ :remotePort ─┐
 [公网用户] ──HTTP/HTTPS──▶ :80/:443 ─┤ 按 Host / SNI 路由
                                      ▼
                             ┌──────────────────┐
                             │   Tunnel Server  │  端口监听 + 流多路复用
                             └────────┬─────────┘
                                      │ WebSocket /agent（二进制帧）
                                      ▼
                             ┌──────────────────┐
                             │      Agent       │
                             └────────┬─────────┘
                                      │ TCP / UDP
                                      ▼
                             127.0.0.1:80 / 3389 / 53 ...
```

每个公网连接（或 UDP 会话）分配一个 `streamId`，通过 `OPEN / DATA / CLOSE` 帧复用同一条 WebSocket。帧格式为 `[1B type][4B streamId][payload]`。HTTP 隧道同样复用该数据通道，服务端只按域名选择隧道，不做 HTTP 解析（保留 WebSocket 升级等原始行为）；HTTPS 在服务端终止 TLS 后转发明文 HTTP/1.1。

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
HTTP_PORT=80 \
HTTPS_PORT=443 \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD='换成强密码' \
node dist/index.js
```

首次启动会创建管理员账号；未设置 `ADMIN_PASSWORD` 时会随机生成并打印到日志（只显示一次）。`HTTP_PORT` / `HTTPS_PORT` 只在存在 HTTP 隧道时才会监听，普通的 TCP/UDP 转发不会占用这两个端口。监听 1024 以下端口需要 root 或 `CAP_NET_BIND_SERVICE`。

然后：

1. 打开 `http://服务器IP:8787`，用管理员账号登录
2. 在「客户端」页新建客户端，复制生成的令牌（只显示一次）
3. 在内网机器启动 Agent：

```bash
TUNNEL_SERVER=ws://服务器IP:8787/agent \
TUNNEL_TOKEN='tk_xxx' \
node apps/agent/dist/index.js
```

4. 在「隧道」页新建隧道，选择客户端并填写内网地址/端口：
   - **TCP**：填写公网端口，客户端在线后自动监听
   - **UDP**：填写公网 UDP 端口，按来源地址维护会话，60 秒无流量自动回收
   - **HTTP**：填写域名（每行一个），共享 `HTTP_PORT` / `HTTPS_PORT` 并按域名路由
5. 停用或删除隧道会立即释放对应端口或域名

## 隧道类型

| 类型 | 公网入口 | 内网目标 | 说明 |
| --- | --- | --- | --- |
| TCP | `服务器IP:remotePort` | `localHost:localPort` (TCP) | 每个入站连接一个 stream |
| UDP | `服务器IP:remotePort` (UDP) | `localHost:localPort` (UDP) | 按 `来源IP:端口` 复用会话，空闲 60s 回收 |
| HTTP | `http://域名` / `https://域名` | `localHost:localPort` (HTTP) | 按 Host / SNI 路由，支持 WebSocket 升级 |

HTTP 隧道的域名需要先解析到服务器。TLS 证书策略：

- 配置 `ACME_EMAIL` 后，服务端通过 HTTP-01 自动向 Let's Encrypt 申请证书，证书保存在 `DATA_DIR/certs`，到期前自动续期
- 未配置或签发失败时，自动生成对应域名的自签名证书，保证 HTTPS 立即可用（浏览器会提示不受信任）
- 管理台「隧道」页会显示每个域名的证书来源（ACME / 自签名）与异常信息

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
| `HTTP_PORT` | `80` | HTTP 域名路由端口（有 HTTP 隧道时才监听） |
| `HTTPS_PORT` | `443` | HTTPS 终止端口（有 HTTP 隧道时才监听） |
| `HTTP_ROUTER` | `true` | 设为 `false` 完全禁用 HTTP 域名隧道 |
| `CERT_DIR` | `DATA_DIR/certs` | TLS 证书缓存目录 |
| `ACME_EMAIL` | 空 | 配置后启用 ACME 自动证书；留空使用自签名证书 |
| `ACME_DIRECTORY` | Let's Encrypt v2 | ACME 目录地址，测试可指向 staging |
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

## 多用户与权限

- 首次启动创建的管理员角色为 `admin`，可在「用户」页新建成员、重置密码、调整角色或删除账号
- **管理员**：查看和管理所有客户端、隧道与用户
- **成员**：只能看到自己创建的客户端，以及这些客户端名下的隧道；无法访问用户管理接口
- 成员新建客户端时自动归属自己；管理员删除成员时，其客户端会移交给当前管理员
- 至少保留一个管理员，不能删除或降级最后一个管理员；重置密码会强制该用户重新登录

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

- `users` / `sessions`：管理台账号（含 `role`）与会话
- `clients`：内网 Agent，`owner_id` 记录归属用户，令牌只存 SHA-256 哈希
- `tunnels`：转发规则，`protocol` 为 `tcp` / `udp` / `http`
- `tunnel_domains`：HTTP 隧道与域名的映射，域名全局唯一

旧版本数据库会在启动时自动补充 `users.role`、`clients.owner_id` 与 `tunnel_domains` 表，无需手动迁移。

## 当前边界与路线图

已支持：TCP、UDP、HTTP 域名路由与自动 HTTPS、多客户端、多用户权限、单连接多路复用、断线重连、隧道启停、流量与连接统计。

暂未支持：P2P 打洞、多 relay 节点、流量配额、HTTP/2 与 HTTP/3。

## 安全说明

- 管理密码使用 scrypt 加盐哈希
- Agent 令牌只存哈希，轮换后旧令牌立即失效并断开 Agent
- 会话 Cookie 为 `httpOnly` + `SameSite=Lax`
- 登录失败按来源 IP 限速
- 成员数据在 API 层强制隔离，越权访问返回 404
- 生产环境请务必启用 HTTPS/WSS，并限制公网暴露的隧道端口；HTTP 隧道使用 ACME 证书时需保证 80 端口可从公网访问
