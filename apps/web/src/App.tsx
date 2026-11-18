import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  ApiError,
  api,
  type ClientInfo,
  type CertInfo,
  type OverviewResponse,
  type TunnelInfo,
  type TunnelProtocol,
  type TunnelStatus,
  type UserInfo,
  type UserRole,
} from './api';

type Page = 'overview' | 'clients' | 'tunnels' | 'users';
type ToastKind = 'ok' | 'error';
interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return '从未';
  const timestamp = new Date(iso).getTime();
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

type IconName =
  | 'grid'
  | 'server'
  | 'route'
  | 'users'
  | 'logout'
  | 'plus'
  | 'edit'
  | 'trash'
  | 'rotate'
  | 'copy'
  | 'check'
  | 'x'
  | 'refresh';

const ICON_PATHS: Record<IconName, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.5 6H14a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 4h5.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 5.5a3 3 0 0 1 0 5.6M17 14.8c2.2.4 3.5 2.1 3.5 4.7" />
    </>
  ),
  logout: (
    <>
      <path d="M9 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
      <path d="M16 16l4-4-4-4M20 12H9" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  edit: (
    <>
      <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 13h10l1-13M10 11v5M14 11v5" />
    </>
  ),
  rotate: (
    <>
      <path d="M20 11a8 8 0 1 0-2.3 6" />
      <path d="M20 4v7h-7" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </>
  ),
  check: <path d="M5 12l4 4 10-10" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-2.3 6" />
      <path d="M20 4v7h-7" />
    </>
  ),
};

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

function LogoMark() {
  return (
    <span className="logo-mark">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 8.5C4 6.6 5.6 5 7.5 5h9C18.4 5 20 6.6 20 8.5S18.4 12 16.5 12H12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M20 15.5c0 1.9-1.6 3.5-3.5 3.5h-9C5.6 19 4 17.4 4 15.5S5.6 12 7.5 12H12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

function StatusBadge({ status }: { status: TunnelStatus }) {
  const map: Record<TunnelStatus, { label: string; cls: string }> = {
    active: { label: '运行中', cls: 'ok' },
    offline: { label: '离线', cls: 'muted' },
    error: { label: '异常', cls: 'danger' },
    disabled: { label: '已停用', cls: 'warn' },
  };
  const item = map[status];
  return <span className={`badge ${item.cls}`}>{item.label}</span>;
}

function OnlineBadge({ online }: { online: boolean }) {
  return (
    <span className={`badge ${online ? 'ok' : 'muted'}`}>
      {online ? '在线' : '离线'}
    </span>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: string;
}) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-hint">{hint}</span>
    </div>
  );
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
  width = 460,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function Login({ onLogin }: { onLogin: (user: UserInfo) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.login(username.trim(), password);
      onLogin(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-orb" />
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <LogoMark />
          <div>
            <strong>Tunnel Console</strong>
            <span>自建内网穿透管理台</span>
          </div>
        </div>
        <h1>登录控制台</h1>
        <p className="muted login-sub">使用服务端初始化时创建的管理员账号</p>

        <Field label="用户名">
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </Field>
        <Field label="密码">
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        {error ? <div className="form-error">{error}</div> : null}

        <button type="submit" className="btn primary block" disabled={busy}>
          {busy ? '登录中...' : '登录'}
        </button>
        <p className="login-hint">
          默认账号 <code>admin</code>，密码见服务端首次启动日志或 <code>ADMIN_PASSWORD</code>
        </p>
      </form>
    </div>
  );
}

function OverviewPage({ data }: { data: OverviewResponse }) {
  const totalTraffic = data.tunnels.reduce(
    (sum, tunnel) => sum + tunnel.traffic.inbound + tunnel.traffic.outbound,
    0,
  );
  const activeConnections = data.tunnels.reduce(
    (sum, tunnel) => sum + tunnel.activeConnections,
    0,
  );
  const recentTunnels = useMemo(
    () =>
      [...data.tunnels].sort((a, b) => {
        const left = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
        const right = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
        return right - left;
      }),
    [data.tunnels],
  );

  return (
    <>
      <section className="stat-grid">
        <Stat
          label="在线客户端"
          value={`${data.server.onlineClients} / ${data.server.totalClients}`}
          hint={
            data.server.onlineClients > 0
              ? `${data.server.onlineClients} 个 Agent 在线`
              : '暂无 Agent 连接'
          }
          tone="accent"
        />
        <Stat
          label="隧道总数"
          value={String(data.server.totalTunnels)}
          hint={`正在监听 ${data.server.listeningPorts.length} 个端口`}
          tone="green"
        />
        <Stat
          label="活跃连接"
          value={String(activeConnections)}
          hint="当前经过隧道的 TCP/UDP 连接"
          tone="blue"
        />
        <Stat
          label="累计流量"
          value={formatBytes(totalTraffic)}
          hint="本次服务运行期间"
          tone="purple"
        />
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>客户端</h2>
            <span className="muted">{data.clients.length} 个</span>
          </div>
          {data.clients.length === 0 ? (
            <div className="empty">还没有客户端，先到「客户端」页面创建一个。</div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>状态</th>
                    <th>隧道</th>
                    <th>最后在线</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map((client) => (
                    <tr key={client.id}>
                      <td>
                        <div className="cell-title">{client.name}</div>
                        {client.note ? <div className="cell-sub">{client.note}</div> : null}
                      </td>
                      <td>
                        <OnlineBadge online={client.online} />
                      </td>
                      <td>{client.tunnelCount}</td>
                      <td className="muted">{formatTime(client.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>隧道</h2>
            <span className="muted">{data.tunnels.length} 条</span>
          </div>
          {recentTunnels.length === 0 ? (
            <div className="empty">还没有隧道，先到「隧道」页面添加一条转发规则。</div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>端口</th>
                    <th>状态</th>
                    <th>流量</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTunnels.map((tunnel) => (
                    <tr key={tunnel.id}>
                      <td>
                        <div className="cell-title">{tunnel.name}</div>
                        <div className="cell-sub">{tunnel.clientName}</div>
                      </td>
                      <td className="mono">{tunnel.remotePort}</td>
                      <td>
                        <StatusBadge status={tunnel.status} />
                      </td>
                      <td className="muted">
                        {formatBytes(tunnel.traffic.inbound + tunnel.traffic.outbound)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="panel meta-panel">
        <div className="meta-item">
          <span>服务端版本</span>
          <strong>{data.server.version}</strong>
        </div>
        <div className="meta-item">
          <span>运行时长</span>
          <strong>{formatUptime(data.server.uptimeSec)}</strong>
        </div>
        <div className="meta-item">
          <span>监听端口</span>
          <strong className="mono">
            {data.server.listeningPorts.length > 0
              ? data.server.listeningPorts.join(', ')
              : '暂无'}
          </strong>
        </div>
        {data.server.http.enabled ? (
          <div className="meta-item">
            <span>HTTP / HTTPS</span>
            <strong className="mono">
              :{data.server.http.port} / :{data.server.http.httpsPort}
              {' · '}
              {data.server.http.listening ? 'HTTP 已监听' : 'HTTP 未监听'}
              {' · '}
              {data.server.http.httpsListening ? 'HTTPS 已监听' : 'HTTPS 未监听'}
              {' · '}
              {data.server.http.acme ? 'ACME 证书' : '自签名证书'}
            </strong>
          </div>
        ) : null}
      </section>
    </>
  );
}

interface ClientFormProps {
  editing: ClientInfo | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onToken: (token: string, clientName: string) => void;
  notify: (message: string, kind?: ToastKind) => void;
}

function ClientFormModal({ editing, onClose, onSaved, onToken, notify }: ClientFormProps) {
  const [name, setName] = useState(editing?.name ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (editing) {
        await api.updateClient(editing.id, { name: name.trim(), note: note.trim() });
        notify('客户端已更新');
        await onSaved();
        onClose();
      } else {
        const result = await api.createClient({ name: name.trim(), note: note.trim() });
        await onSaved();
        onClose();
        onToken(result.token, result.client.name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? '编辑客户端' : '新建客户端'}
      subtitle="客户端代表一台运行 Agent 的内网机器"
      onClose={onClose}
    >
      <form className="form" onSubmit={submit}>
        <Field label="名称">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：办公室 NAS"
            maxLength={64}
            required
            autoFocus
          />
        </Field>
        <Field label="备注" hint="可选，方便区分不同机器">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="例如：群晖 920+，机房 A"
            maxLength={200}
          />
        </Field>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? '保存中...' : editing ? '保存修改' : '创建并生成令牌'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TokenModal({
  token,
  clientName,
  onClose,
}: {
  token: string;
  clientName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyText(token);
    setCopied(ok);
    if (!ok) {
      window.prompt('自动复制失败，请手动复制令牌：', token);
    }
  };

  return (
    <Modal
      title="客户端令牌"
      subtitle={`「${clientName}」的 Agent 接入令牌只显示这一次`}
      onClose={onClose}
    >
      <div className="token-box">
        <code>{token}</code>
        <button type="button" className="btn ghost small" onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} />
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <p className="hint">
        在内网机器上启动 Agent 时通过环境变量 <code>TUNNEL_TOKEN</code> 传入。令牌丢失后只能轮换。
      </p>
      <pre className="code-block">{`TUNNEL_SERVER=ws://你的服务器:8787/agent \\
TUNNEL_TOKEN=${token} \\
tunnel-agent`}</pre>
      <div className="modal-actions">
        <button type="button" className="btn primary" onClick={onClose}>
          我已保存
        </button>
      </div>
    </Modal>
  );
}

function ClientsPage({
  clients,
  changed,
  notify,
  showOwner,
}: {
  clients: ClientInfo[];
  changed: () => Promise<void>;
  notify: (message: string, kind?: ToastKind) => void;
  showOwner: boolean;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ClientInfo | null>(null);
  const [tokenModal, setTokenModal] = useState<{ token: string; name: string } | null>(null);
  const [busyId, setBusyId] = useState('');

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (client: ClientInfo) => {
    setEditing(client);
    setFormOpen(true);
  };

  const remove = async (client: ClientInfo) => {
    if (
      !window.confirm(
        `删除客户端「${client.name}」会同时删除它下面的 ${client.tunnelCount} 条隧道，确定继续？`,
      )
    ) {
      return;
    }
    setBusyId(client.id);
    try {
      await api.deleteClient(client.id);
      notify('客户端已删除');
      await changed();
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const rotate = async (client: ClientInfo) => {
    if (
      !window.confirm(
        `轮换「${client.name}」的令牌后，旧令牌立即失效，Agent 需要用新令牌重新连接。继续？`,
      )
    ) {
      return;
    }
    setBusyId(client.id);
    try {
      const result = await api.rotateToken(client.id);
      setTokenModal({ token: result.token, name: client.name });
      notify('令牌已轮换');
      await changed();
    } catch (err) {
      notify(err instanceof Error ? err.message : '轮换失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>客户端</h2>
            <p className="muted panel-sub">每台内网机器运行一个 Agent，用独立令牌接入</p>
          </div>
          <button type="button" className="btn primary" onClick={openCreate}>
            <Icon name="plus" />
            新建客户端
          </button>
        </div>

        {clients.length === 0 ? (
          <div className="empty">
            <p>还没有客户端</p>
            <button type="button" className="btn ghost" onClick={openCreate}>
              创建第一个客户端
            </button>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  {showOwner ? <th>所属用户</th> : null}
                  <th>状态</th>
                  <th>令牌</th>
                  <th>隧道</th>
                  <th>流量</th>
                  <th>最后在线</th>
                  <th className="right">操作</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.id}>
                    <td>
                      <div className="cell-title">{client.name}</div>
                      {client.note ? <div className="cell-sub">{client.note}</div> : null}
                    </td>
                    {showOwner ? (
                      <td className="muted">{client.ownerName ?? '—'}</td>
                    ) : null}
                    <td>
                      <OnlineBadge online={client.online} />
                    </td>
                    <td className="mono muted">{client.tokenPrefix}</td>
                    <td>{client.tunnelCount}</td>
                    <td className="muted">
                      {formatBytes(client.traffic.inbound + client.traffic.outbound)}
                    </td>
                    <td className="muted">{formatTime(client.lastSeenAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="编辑"
                          onClick={() => openEdit(client)}
                        >
                          <Icon name="edit" />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="轮换令牌"
                          disabled={busyId === client.id}
                          onClick={() => void rotate(client)}
                        >
                          <Icon name="rotate" />
                        </button>
                        <button
                          type="button"
                          className="icon-btn danger"
                          title="删除"
                          disabled={busyId === client.id}
                          onClick={() => void remove(client)}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {formOpen ? (
        <ClientFormModal
          editing={editing}
          onClose={() => setFormOpen(false)}
          onSaved={changed}
          onToken={(token, clientName) => setTokenModal({ token, name: clientName })}
          notify={notify}
        />
      ) : null}

      {tokenModal ? (
        <TokenModal
          token={tokenModal.token}
          clientName={tokenModal.name}
          onClose={() => setTokenModal(null)}
        />
      ) : null}
    </>
  );
}

interface TunnelFormProps {
  clients: ClientInfo[];
  editing: TunnelInfo | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: (message: string, kind?: ToastKind) => void;
}

function TunnelFormModal({ clients, editing, onClose, onSaved, notify }: TunnelFormProps) {
  const [clientId, setClientId] = useState(editing?.clientId ?? clients[0]?.id ?? '');
  const [protocol, setProtocol] = useState<TunnelProtocol>(editing?.protocol ?? 'tcp');
  const [name, setName] = useState(editing?.name ?? '');
  const [localHost, setLocalHost] = useState(editing?.localHost ?? '127.0.0.1');
  const [localPort, setLocalPort] = useState(String(editing?.localPort ?? 80));
  const [remotePort, setRemotePort] = useState(
    editing && editing.protocol !== 'http' ? String(editing.remotePort) : '',
  );
  const [domains, setDomains] = useState(editing?.domains.join('\n') ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const local = Number(localPort);
    if (!Number.isInteger(local) || local < 1 || local > 65535) {
      setError('内网端口必须是 1-65535 的整数');
      return;
    }

    const parsedDomains = domains
      .split(/[\s,]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    let remote: number | undefined;
    if (protocol === 'http') {
      if (parsedDomains.length === 0) {
        setError('HTTP 隧道至少需要一个域名');
        return;
      }
    } else {
      remote = Number(remotePort);
      if (!Number.isInteger(remote) || remote < 1 || remote > 65535) {
        setError('公网端口必须是 1-65535 的整数');
        return;
      }
    }

    setBusy(true);
    setError('');
    try {
      if (editing) {
        await api.updateTunnel(editing.id, {
          name: name.trim(),
          localHost: localHost.trim(),
          localPort: local,
          ...(protocol === 'http' ? { domains: parsedDomains } : { remotePort: remote }),
        });
        notify('隧道已更新');
      } else if (protocol === 'http') {
        await api.createTunnel({
          clientId,
          name: name.trim(),
          protocol,
          localHost: localHost.trim(),
          localPort: local,
          domains: parsedDomains,
        });
        notify('HTTP 隧道已创建');
      } else {
        await api.createTunnel({
          clientId,
          name: name.trim(),
          protocol,
          localHost: localHost.trim(),
          localPort: local,
          remotePort: remote as number,
        });
        notify('隧道已创建');
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? '编辑隧道' : '新建隧道'}
      subtitle="把公网流量转发到某台客户端所在内网的服务"
      onClose={onClose}
      width={540}
    >
      <form className="form" onSubmit={submit}>
        <Field label="隧道名称">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：远程桌面 / 博客"
            maxLength={64}
            required
            autoFocus
          />
        </Field>
        <Field label="客户端">
          <select
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            disabled={Boolean(editing)}
          >
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
                {client.online ? '' : '（离线）'}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="协议"
          hint={
            editing
              ? '协议创建后不可修改，需要切换请新建隧道'
              : 'TCP/UDP 使用独立公网端口；HTTP 使用共享的 80/443 并按域名路由'
          }
        >
          <select
            value={protocol}
            onChange={(event) => setProtocol(event.target.value as TunnelProtocol)}
            disabled={Boolean(editing)}
          >
            <option value="tcp">TCP 端口转发</option>
            <option value="udp">UDP 端口转发</option>
            <option value="http">HTTP 域名 + 自动 HTTPS</option>
          </select>
        </Field>
        <div className="field-row">
          <Field label="内网地址">
            <input
              value={localHost}
              onChange={(event) => setLocalHost(event.target.value)}
              placeholder="127.0.0.1"
              required
            />
          </Field>
          <Field label={protocol === 'udp' ? '内网 UDP 端口' : '内网端口'}>
            <input
              value={localPort}
              onChange={(event) => setLocalPort(event.target.value)}
              inputMode="numeric"
              placeholder="80"
              required
            />
          </Field>
        </div>
        {protocol === 'http' ? (
          <Field
            label="域名"
            hint="每行一个域名，DNS 需解析到本服务器；HTTP 与 HTTPS 自动生效"
          >
            <textarea
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              rows={3}
              placeholder={'app.example.com\napi.example.com'}
              required
            />
          </Field>
        ) : (
          <Field
            label="公网端口"
            hint={
              protocol === 'udp'
                ? '在服务器上监听的 UDP 端口，客户端连上后自动生效'
                : '在服务器上监听的 TCP 端口，客户端连上后自动生效'
            }
          >
            <input
              value={remotePort}
              onChange={(event) => setRemotePort(event.target.value)}
              inputMode="numeric"
              placeholder="例如：6000"
              required
            />
          </Field>
        )}
        {error ? <div className="form-error">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy || !clientId}>
            {busy ? '保存中...' : editing ? '保存修改' : '创建隧道'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TunnelsPage({
  tunnels,
  clients,
  changed,
  notify,
}: {
  tunnels: TunnelInfo[];
  clients: ClientInfo[];
  changed: () => Promise<void>;
  notify: (message: string, kind?: ToastKind) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TunnelInfo | null>(null);
  const [busyId, setBusyId] = useState('');

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (tunnel: TunnelInfo) => {
    setEditing(tunnel);
    setFormOpen(true);
  };

  const toggle = async (tunnel: TunnelInfo) => {
    setBusyId(tunnel.id);
    try {
      await api.updateTunnel(tunnel.id, { enabled: !tunnel.enabled });
      notify(tunnel.enabled ? '隧道已停用' : '隧道已启用');
      await changed();
    } catch (err) {
      notify(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const remove = async (tunnel: TunnelInfo) => {
    const target =
      tunnel.protocol === 'http'
        ? tunnel.domains.join(', ')
        : `公网端口 ${tunnel.remotePort}`;
    if (!window.confirm(`确定删除隧道「${tunnel.name}」？${target} 会被释放。`)) {
      return;
    }
    setBusyId(tunnel.id);
    try {
      await api.deleteTunnel(tunnel.id);
      notify('隧道已删除');
      await changed();
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>隧道</h2>
            <p className="muted panel-sub">公网端口 → 内网服务；停用后监听端口立即释放</p>
          </div>
          <button
            type="button"
            className="btn primary"
            onClick={openCreate}
            disabled={clients.length === 0}
            title={clients.length === 0 ? '请先创建客户端' : undefined}
          >
            <Icon name="plus" />
            新建隧道
          </button>
        </div>

        {tunnels.length === 0 ? (
          <div className="empty">
            <p>还没有隧道</p>
            {clients.length === 0 ? (
              <span className="muted">先创建客户端并让 Agent 上线，再来添加转发规则。</span>
            ) : (
              <button type="button" className="btn ghost" onClick={openCreate}>
                创建第一条隧道
              </button>
            )}
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>协议</th>
                  <th>客户端</th>
                  <th>转发规则</th>
                  <th>状态</th>
                  <th>流量</th>
                  <th>连接</th>
                  <th className="right">操作</th>
                </tr>
              </thead>
              <tbody>
                {tunnels.map((tunnel) => (
                  <tr key={tunnel.id}>
                    <td>
                      <div className="cell-title">{tunnel.name}</div>
                      {tunnel.error ? (
                        <div className="cell-sub danger-text">{tunnel.error}</div>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className={`badge ${tunnel.protocol === 'http' ? 'ok' : 'muted'}`}
                      >
                        {PROTOCOL_LABEL[tunnel.protocol] ?? tunnel.protocol}
                      </span>
                    </td>
                    <td className="muted">{tunnel.clientName}</td>
                    <td>
                      <span className="route mono">
                        {routeLabel(tunnel)}
                        <span className="route-arrow">→</span>
                        {tunnel.localHost}:{tunnel.localPort}
                      </span>
                      {tunnel.protocol === 'http' && tunnel.certs.length > 0 ? (
                        <div className="cell-sub">
                          {tunnel.certs
                            .map((cert) => `${cert.domain}: ${certLabel(cert)}`)
                            .join(' · ')}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge status={tunnel.status} />
                    </td>
                    <td className="muted">
                      {formatBytes(tunnel.traffic.inbound + tunnel.traffic.outbound)}
                    </td>
                    <td className="muted">
                      {tunnel.activeConnections}
                      <span className="muted"> / {tunnel.connections}</span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className={`switch ${tunnel.enabled ? 'on' : ''}`}
                          role="switch"
                          aria-checked={tunnel.enabled}
                          title={tunnel.enabled ? '停用' : '启用'}
                          disabled={busyId === tunnel.id}
                          onClick={() => void toggle(tunnel)}
                        >
                          <span />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="编辑"
                          onClick={() => openEdit(tunnel)}
                        >
                          <Icon name="edit" />
                        </button>
                        <button
                          type="button"
                          className="icon-btn danger"
                          title="删除"
                          disabled={busyId === tunnel.id}
                          onClick={() => void remove(tunnel)}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {formOpen ? (
        <TunnelFormModal
          clients={clients}
          editing={editing}
          onClose={() => setFormOpen(false)}
          onSaved={changed}
          notify={notify}
        />
      ) : null}
    </>
  );
}

function UserFormModal({
  onClose,
  onSaved,
  notify,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: (message: string, kind?: ToastKind) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 6) {
      setError('密码至少 6 位');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.createUser({ username: username.trim(), password, role });
      notify('用户已创建');
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="新建用户" subtitle="成员只能看到并管理自己名下的客户端" onClose={onClose} width={440}>
      <form className="form" onSubmit={submit}>
        <Field label="用户名" hint="3-64 位，支持字母、数字、下划线、点和短横线">
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            minLength={3}
            maxLength={64}
            required
            autoFocus
          />
        </Field>
        <Field label="初始密码" hint="至少 6 位，可在创建后重置">
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={6}
            required
          />
        </Field>
        <Field label="角色">
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as UserRole)}
          >
            <option value="member">成员 · 仅管理自己的客户端</option>
            <option value="admin">管理员 · 全局管理</option>
          </select>
        </Field>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? '创建中...' : '创建用户'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UsersPage({ notify }: { notify: (message: string, kind?: ToastKind) => void }) {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await api.users();
      setUsers(result.users);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetPassword = async (user: UserInfo) => {
    const password = window.prompt(`为「${user.username}」设置新密码（至少 6 位）`);
    if (!password) return;
    if (password.length < 6) {
      notify('密码至少 6 位', 'error');
      return;
    }
    setBusyId(user.id);
    try {
      await api.updateUser(user.id, { password });
      notify('密码已重置，该用户需要重新登录');
    } catch (err) {
      notify(err instanceof Error ? err.message : '重置失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const toggleRole = async (user: UserInfo) => {
    const next: UserRole = user.role === 'admin' ? 'member' : 'admin';
    if (
      !window.confirm(
        `确定把「${user.username}」${next === 'admin' ? '设为管理员' : '降为成员'}吗？`,
      )
    ) {
      return;
    }
    setBusyId(user.id);
    try {
      await api.updateUser(user.id, { role: next });
      notify('角色已更新');
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : '更新失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const remove = async (user: UserInfo) => {
    if (
      !window.confirm(
        `确定删除用户「${user.username}」？其名下的客户端会移交给当前管理员。`,
      )
    ) {
      return;
    }
    setBusyId(user.id);
    try {
      await api.deleteUser(user.id);
      notify('用户已删除');
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>控制台用户</h2>
          <p className="muted">管理员可查看全部客户端，成员只能访问自己创建的资源。</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          新建用户
        </button>
      </div>

      {error ? <div className="alert">{error}</div> : null}

      {loading ? (
        <div className="empty">正在加载...</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>用户名</th>
                <th>角色</th>
                <th>客户端</th>
                <th>创建时间</th>
                <th className="right">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div className="cell-title">{user.username}</div>
                  </td>
                  <td>
                    <span className={`badge ${user.role === 'admin' ? 'ok' : 'muted'}`}>
                      {user.role === 'admin' ? '管理员' : '成员'}
                    </span>
                  </td>
                  <td className="muted">{user.clientCount ?? 0}</td>
                  <td className="muted">
                    {user.createdAt
                      ? new Date(user.createdAt).toLocaleString('zh-CN', { hour12: false })
                      : '—'}
                  </td>
                  <td className="right">
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn ghost small"
                        disabled={busyId === user.id}
                        onClick={() => void resetPassword(user)}
                      >
                        重置密码
                      </button>
                      <button
                        type="button"
                        className="btn ghost small"
                        disabled={busyId === user.id}
                        onClick={() => void toggleRole(user)}
                      >
                        {user.role === 'admin' ? '设为成员' : '设为管理员'}
                      </button>
                      <button
                        type="button"
                        className="btn danger small"
                        disabled={busyId === user.id}
                        onClick={() => void remove(user)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <UserFormModal
          onClose={() => setCreating(false)}
          onSaved={load}
          notify={notify}
        />
      ) : null}
    </section>
  );
}

const PROTOCOL_LABEL: Record<TunnelProtocol, string> = {
  tcp: 'TCP',
  udp: 'UDP',
  http: 'HTTP',
};

function routeLabel(tunnel: TunnelInfo): string {
  if (tunnel.protocol === 'http') {
    return tunnel.domains.length > 0 ? tunnel.domains.join(', ') : '未配置域名';
  }
  return `:${tunnel.remotePort}`;
}

function certLabel(cert: CertInfo): string {
  if (cert.mode === 'acme') return 'ACME';
  if (cert.mode === 'self-signed') return '自签名';
  if (cert.mode === 'pending') return '签发中';
  return cert.error ? `异常：${cert.error}` : '异常';
}

const NAV_ITEMS: Array<{ key: Page; label: string; icon: IconName; title: string; subtitle: string }> =
  [
    {
      key: 'overview',
      label: '概览',
      icon: 'grid',
      title: '概览',
      subtitle: '服务端与隧道运行状态',
    },
    {
      key: 'clients',
      label: '客户端',
      icon: 'server',
      title: '客户端',
      subtitle: '管理内网 Agent 和接入令牌',
    },
    {
      key: 'tunnels',
      label: '隧道',
      icon: 'route',
      title: '隧道',
      subtitle: '配置 TCP / UDP / HTTP 转发规则',
    },
    {
      key: 'users',
      label: '用户',
      icon: 'users',
      title: '用户',
      subtitle: '管理控制台账号与权限',
    },
  ];

function ConsoleView({
  user,
  onSessionLost,
}: {
  user: UserInfo;
  onSessionLost: () => void;
}) {
  const [page, setPage] = useState<Page>('overview');
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, kind: ToastKind = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3_400);
  }, []);

  const load = useCallback(
    async (silent = false) => {
      try {
        const overview = await api.overview();
        setData(overview);
        setLoadError('');
        setLastUpdated(new Date());
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          onSessionLost();
          return;
        }
        if (!silent) {
          setLoadError(error instanceof Error ? error.message : '加载失败');
        }
      }
    },
    [onSessionLost],
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      onSessionLost();
    }
  };

  const visibleNav = NAV_ITEMS.filter((item) => item.key !== 'users' || user.role === 'admin');
  const active = visibleNav.find((item) => item.key === page) ?? visibleNav[0]!;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <LogoMark />
          <div>
            <strong>Tunnel Console</strong>
            <span>内网穿透控制台</span>
          </div>
        </div>

        <nav className="nav">
          {visibleNav.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-item ${page === item.key ? 'active' : ''}`}
              onClick={() => setPage(item.key)}
            >
              <Icon name={item.icon} size={17} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="avatar">{user.username.slice(0, 1).toUpperCase()}</div>
          <div className="user-meta">
            <strong>{user.username}</strong>
            <span>{user.role === 'admin' ? '管理员' : '成员'}</span>
          </div>
          <button type="button" className="icon-btn" title="退出登录" onClick={() => void logout()}>
            <Icon name="logout" />
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{active.title}</h1>
            <p className="muted">{active.subtitle}</p>
          </div>
          <div className="topbar-right">
            <span className="refresh-hint">
              {lastUpdated
                ? `更新于 ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}`
                : '加载中...'}
            </span>
            <button type="button" className="btn ghost small" onClick={() => void load()}>
              <Icon name="refresh" />
              刷新
            </button>
          </div>
        </header>

        {loadError ? (
          <div className="alert">
            <span>{loadError}</span>
            <button type="button" className="btn ghost small" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : null}

        {!data ? (
          <div className="loading">
            <span className="spinner" />
            正在加载数据...
          </div>
        ) : active.key === 'overview' ? (
          <OverviewPage data={data} />
        ) : active.key === 'clients' ? (
          <ClientsPage
            clients={data.clients}
            changed={() => load(true)}
            notify={notify}
            showOwner={user.role === 'admin'}
          />
        ) : active.key === 'tunnels' ? (
          <TunnelsPage
            tunnels={data.tunnels}
            clients={data.clients}
            changed={() => load(true)}
            notify={notify}
          />
        ) : (
          <UsersPage notify={notify} />
        )}
      </main>

      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <Icon name={toast.kind === 'ok' ? 'check' : 'x'} />
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .me()
      .then((result) => {
        if (alive) setUser(result.user);
      })
      .catch(() => {
        if (alive) setUser(null);
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (checking) {
    return (
      <div className="boot">
        <span className="spinner" />
        正在检查登录状态...
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return <ConsoleView user={user} onSessionLost={() => setUser(null)} />;
}
