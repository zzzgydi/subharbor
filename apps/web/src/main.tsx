import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ConfigInput,
  SourceInput,
  RulePackInput,
  ScriptInput,
  Rule,
  Target,
} from '../../../packages/contracts/src/index';
import './style.css';

type Item = { id: string; name: string; revision: number; [key: string]: any };
type Page = 'configs' | 'sources' | 'rules' | 'scripts' | 'shares' | 'jobs';
type ConfigTab = 'nodes' | 'rules' | 'routing' | 'scripts';
const configTabs: [ConfigTab, string][] = [
  ['nodes', '节点'],
  ['rules', '规则'],
  ['routing', '路由'],
  ['scripts', '后处理'],
];
const navigation: Page[] = ['configs', 'shares', 'sources', 'rules', 'scripts', 'jobs'];
let csrf = '';
async function api<T = any>(
  path: string,
  method = 'GET',
  body?: unknown,
  revision?: number,
): Promise<T> {
  const response = await fetch('/api/' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }),
      ...(revision ? { 'If-Match': String(revision) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.issues?.map((i: any) => i.path + ': ' + i.message).join('；') ||
        data.error ||
        '操作失败',
    );
  return data;
}
const defaultConfig: ConfigInput = {
  name: '',
  enabled: true,
  sourceIds: [],
  extraNodes: '',
  rulePackIds: [],
  customRules: [],
  groups: [],
  include: '',
  exclude: '',
  prefix: '',
  deduplicate: true,
  sort: false,
  strict: false,
  dnsServers: ['1.1.1.1', '223.5.5.5'],
  finalAction: 'PROXY',
  scriptIds: [],
  scriptParams: {},
  maxStaleHours: 168,
};
const defaultSource: SourceInput = {
  name: '',
  kind: 'subscription',
  url: '',
  content: '',
  headers: {},
  enabled: true,
  schedule: { mode: 'interval', minutes: 360 },
};
const defaultPack: RulePackInput = {
  defaultAction: 'PROXY',
  name: '',
  url: '',
  content: '',
  schedule: { mode: 'interval', minutes: 1440 },
};
const defaultScript: ScriptInput = {
  name: '',
  stage: 'config',
  targets: ['mihomo'],
  code: 'function transform(input, context) {\n  // 修改 input，然后返回结果。\n  return input;\n}',
};
const targets: Target[] = ['mihomo', 'clash', 'sing-box'];
const labels: Record<Page, string> = {
  configs: '订阅配置',
  sources: '节点来源',
  rules: '规则包',
  scripts: '处理脚本',
  shares: '订阅链接',
  jobs: '更新记录',
};
function formatTime(s?: string) {
  return s ? new Date(s).toLocaleString() : '尚未更新';
}
function clean<T extends object>(item: Item, defaults: T): T {
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [key, item[key] ?? defaults[key as keyof T]]),
  ) as T;
}
function ScheduleEditor({
  value,
  onChange,
}: {
  value: SourceInput['schedule'];
  onChange: (v: SourceInput['schedule']) => void;
}) {
  return (
    <div className="row">
      <label>
        更新方式
        <select
          value={value.mode}
          onChange={(e) =>
            onChange(
              e.target.value === 'manual'
                ? { mode: 'manual' }
                : e.target.value === 'interval'
                  ? { mode: 'interval', minutes: 360 }
                  : { mode: 'cron', expression: '0 */6 * * *', timezone: 'Asia/Shanghai' },
            )
          }
        >
          <option value="interval">固定间隔</option>
          <option value="cron">Cron 定时</option>
          <option value="manual">仅手动</option>
        </select>
      </label>
      {value.mode === 'interval' && (
        <label>
          间隔（分钟）
          <input
            type="number"
            min="5"
            required
            value={value.minutes}
            onChange={(e) => onChange({ ...value, minutes: Number(e.target.value) })}
          />
        </label>
      )}
      {value.mode === 'cron' && (
        <>
          <label>
            Cron 表达式
            <input
              required
              value={value.expression}
              onChange={(e) => onChange({ ...value, expression: e.target.value })}
            />
          </label>
          <label>
            时区
            <input
              required
              value={value.timezone}
              onChange={(e) => onChange({ ...value, timezone: e.target.value })}
            />
          </label>
        </>
      )}
    </div>
  );
}
function ToggleList({
  title,
  items,
  selected,
  onChange,
}: {
  title: string;
  items: Item[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset>
      <legend>{title}</legend>
      {!items.length && <p className="muted">尚未添加</p>}
      <div className="checks">
        {items.map((i) => (
          <label key={i.id}>
            <input
              type="checkbox"
              checked={selected.includes(i.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, i.id] : selected.filter((id) => id !== i.id),
                )
              }
            />
            {i.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
export function App() {
  const [user, setUser] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>('configs');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<Record<Page, Item[]>>({
    configs: [],
    sources: [],
    rules: [],
    scripts: [],
    shares: [],
    jobs: [],
  });
  const [editing, setEditing] = useState<Item | null>(null);
  const [editor, setEditor] = useState(false);
  const [configTab, setConfigTab] = useState<ConfigTab>('nodes');
  const [search, setSearch] = useState('');
  const [config, setConfig] = useState<ConfigInput>(defaultConfig);
  const [source, setSource] = useState<SourceInput>(defaultSource);
  const [pack, setPack] = useState<RulePackInput>(defaultPack);
  const [script, setScript] = useState<ScriptInput>(defaultScript);
  const [headersText, setHeadersText] = useState('{}');
  const [paramsText, setParamsText] = useState('{}');
  const [target, setTarget] = useState<Target>('mihomo');
  const [mode, setMode] = useState<'full' | 'nodes'>('full');
  const [preview, setPreview] = useState<{ body: string; warnings: string[] } | null>(null);
  const [newLink, setNewLink] = useState('');
  const [shareForm, setShareForm] = useState({
    name: '',
    configId: '',
    target: 'mihomo' as Target,
    mode: 'full',
    expiresAt: '',
    pinned: false,
  });
  async function refresh() {
    const routes = ['configs', 'sources', 'rule-packs', 'scripts', 'shares', 'jobs'];
    const values = await Promise.all(routes.map((p) => api<Item[]>(p)));
    setData({
      configs: values[0]!,
      sources: values[1]!,
      rules: values[2]!,
      scripts: values[3]!,
      shares: values[4]!,
      jobs: values[5]!,
    });
  }
  useEffect(() => {
    api('auth/me')
      .then((u) => {
        csrf = u.csrf;
        setUser(u.username);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => void refresh().catch(() => undefined), 5000);
    return () => clearInterval(timer);
  }, [user]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await fn();
      if (result !== false) await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  function navigate(next: Page) {
    setPage(next);
    setSearch('');
    setEditor(false);
    setEditing(null);
    setPreview(null);
    setError('');
    setNotice('');
    setNewLink('');
  }
  async function edit(item?: Item) {
    setConfigTab('nodes');
    setEditing(item || null);
    setPreview(null);
    setError('');
    let full = item;
    if (page === 'sources' && item) full = await api<Item>('sources/' + item.id);
    if (page === 'configs') {
      const c = full ? clean(full, defaultConfig) : structuredClone(defaultConfig);
      setConfig(c);
      setParamsText(JSON.stringify(c.scriptParams, null, 2));
    }
    if (page === 'sources') {
      const s = full ? clean(full, defaultSource) : structuredClone(defaultSource);
      setSource(s);
      setHeadersText(JSON.stringify(s.headers, null, 2));
    }
    if (page === 'rules') setPack(full ? clean(full, defaultPack) : structuredClone(defaultPack));
    if (page === 'scripts')
      setScript(full ? clean(full, defaultScript) : structuredClone(defaultScript));
    setEditor(true);
  }
  async function save() {
    let body: unknown;
    const route = page === 'rules' ? 'rule-packs' : page;
    if (page === 'configs') body = { ...config, scriptParams: JSON.parse(paramsText) };
    if (page === 'sources') body = { ...source, headers: JSON.parse(headersText) };
    if (page === 'rules') body = pack;
    if (page === 'scripts') body = script;
    const result = await api<Item>(
      route + (editing ? '/' + editing.id : ''),
      editing ? 'PUT' : 'POST',
      body,
      editing?.revision,
    );
    setEditing(result);
    setNotice('已保存。生成状态可在更新记录中查看。');
    if (page === 'sources' && source.kind === 'subscription')
      await api('sources/' + result.id + '/refresh', 'POST', {});
    if (page === 'rules' && pack.url) await api('rule-packs/' + result.id + '/refresh', 'POST', {});
  }
  function jobResource(item: Item) {
    const [id, target, mode] = String(item.resourceId || '').split(':');
    const collection =
      item.kind === 'source' ? data.sources : item.kind === 'rule-pack' ? data.rules : data.configs;
    const name = collection.find((resource) => resource.id === id)?.name || '资源已删除';
    return item.kind === 'publish'
      ? `${name} · ${target} · ${mode === 'nodes' ? '节点片段' : '完整配置'}`
      : name;
  }
  const visibleItems = data[page].filter((item) => {
    const name =
      item.name ||
      (
        { source: '来源更新', 'rule-pack': '规则更新', publish: '配置生成' } as Record<
          string,
          string
        >
      )[item.kind] ||
      '';
    return `${name} ${page === 'jobs' ? jobResource(item) : ''}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  });
  function closeEditor() {
    setEditor(false);
    setPreview(null);
    setNewLink('');
  }
  if (loading)
    return (
      <main className="login">
        <p>正在连接 SubHarbor…</p>
      </main>
    );
  if (!user)
    return (
      <main className="login">
        <div className="login-card">
          <div className="login-brand">SubHarbor</div>
          <h1>管理员登录</h1>
          <p className="muted">使用部署时设置的管理员账号。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setBusy(true);
              api('auth/login', 'POST', {
                username: f.get('username'),
                password: f.get('password'),
              })
                .then((u) => {
                  csrf = u.csrf;
                  setUser(u.username);
                  setError('');
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              管理员用户名
              <input name="username" autoComplete="username" required autoFocus />
            </label>
            <label>
              密码
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            {error && (
              <div role="alert" className="error">
                {error}
              </div>
            )}
            <button className="primary" disabled={busy}>
              {busy ? '正在登录…' : '登录管理台'}
            </button>
          </form>
        </div>
      </main>
    );
  return (
    <div className="layout">
      <div className="app-bar">
        <strong className="wordmark">SubHarbor</strong>
        <span className="app-divider" aria-hidden="true">
          /
        </span>
        <span className="app-location">{labels[page]}</span>
        <div className="account">
          <span>{user}</span>
          <button
            onClick={() =>
              action(async () => {
                await api('auth/logout', 'POST', {});
                setUser('');
                csrf = '';
                return false;
              })
            }
          >
            退出
          </button>
        </div>
      </div>
      <aside>
        <nav aria-label="主导航">
          {navigation.map((p) => (
            <React.Fragment key={p}>
              {['configs', 'sources', 'jobs'].includes(p) && (
                <div className="nav-group">
                  {
                    { configs: '订阅', sources: '资源', jobs: '系统' }[
                      p as 'configs' | 'sources' | 'jobs'
                    ]
                  }
                </div>
              )}
              <button
                className={page === p ? 'nav active' : 'nav'}
                aria-current={page === p ? 'page' : undefined}
                onClick={() => navigate(p)}
              >
                <span>{labels[p]}</span>
                {p !== 'jobs' && <span className="nav-count">{data[p].length}</span>}
              </button>
            </React.Fragment>
          ))}
        </nav>
      </aside>
      <main>
        <header className="page-header">
          <div>
            {editor && (
              <div className="breadcrumb">
                {labels[page]} <span aria-hidden="true">/</span> {editing ? '编辑' : '新建'}
              </div>
            )}
            <h1>
              {editor
                ? editing?.name || (page === 'shares' ? '签发订阅链接' : '新建' + labels[page])
                : labels[page]}
            </h1>
          </div>
          {editor ? (
            <button onClick={closeEditor}>返回列表</button>
          ) : (
            ['configs', 'sources', 'rules', 'scripts', 'shares'].includes(page) && (
              <button className="primary" disabled={busy} onClick={() => action(() => edit())}>
                {page === 'shares'
                  ? '签发链接'
                  : '新建' +
                    labels[page].replace('订阅', '').replace('节点', '').replace('处理', '')}
              </button>
            )
          )}
        </header>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            {notice}
          </div>
        )}
        {editor && page !== 'shares' && (
          <section className="panel editor-panel">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(save);
              }}
            >
              {page === 'configs' && (
                <>
                  <div className="row">
                    <label>
                      配置名称
                      <input
                        required
                        value={config.name}
                        onChange={(e) => setConfig({ ...config, name: e.target.value })}
                        placeholder="配置名称"
                      />
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={config.enabled}
                        onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
                      />
                      启用配置
                    </label>
                  </div>
                  <div
                    className="config-tabs"
                    role="tablist"
                    aria-label="配置设置"
                    onKeyDown={(e) => {
                      const keys = configTabs.map(([key]) => key);
                      const index = keys.indexOf(configTab);
                      const next =
                        e.key === 'ArrowRight'
                          ? (index + 1) % keys.length
                          : e.key === 'ArrowLeft'
                            ? (index + keys.length - 1) % keys.length
                            : e.key === 'Home'
                              ? 0
                              : e.key === 'End'
                                ? keys.length - 1
                                : -1;
                      if (next >= 0) {
                        e.preventDefault();
                        setConfigTab(keys[next]!);
                        e.currentTarget
                          .querySelectorAll<HTMLButtonElement>('[role="tab"]')
                          [next]?.focus();
                      }
                    }}
                  >
                    {configTabs.map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        id={'config-tab-' + key}
                        aria-selected={configTab === key}
                        aria-controls="config-panel"
                        tabIndex={configTab === key ? 0 : -1}
                        onClick={() => setConfigTab(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div
                    className="tab-content"
                    role="tabpanel"
                    id="config-panel"
                    aria-labelledby={'config-tab-' + configTab}
                  >
                    {configTab === 'nodes' && (
                      <>
                        <ToggleList
                          title="节点来源"
                          items={data.sources}
                          selected={config.sourceIds}
                          onChange={(sourceIds) => setConfig({ ...config, sourceIds })}
                        />
                        <label>
                          本配置追加的节点
                          <textarea
                            rows={3}
                            value={config.extraNodes}
                            onChange={(e) => setConfig({ ...config, extraNodes: e.target.value })}
                            placeholder="节点 URI，每行一个；也支持 proxies YAML"
                          />
                        </label>
                        <div className="row">
                          <label>
                            名称包含
                            <input
                              value={config.include}
                              onChange={(e) => setConfig({ ...config, include: e.target.value })}
                              placeholder="按文字筛选"
                            />
                          </label>
                          <label>
                            名称排除
                            <input
                              value={config.exclude}
                              onChange={(e) => setConfig({ ...config, exclude: e.target.value })}
                            />
                          </label>
                          <label>
                            统一名称前缀
                            <input
                              value={config.prefix}
                              onChange={(e) => setConfig({ ...config, prefix: e.target.value })}
                            />
                          </label>
                        </div>
                        <div className="checks">
                          {(['deduplicate', 'sort', 'strict'] as const).map((k, i) => (
                            <label key={k}>
                              <input
                                type="checkbox"
                                checked={config[k]}
                                onChange={(e) => setConfig({ ...config, [k]: e.target.checked })}
                              />
                              {['连接参数去重', '按名称排序', '不兼容时拒绝生成'][i]}
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                    {configTab === 'rules' && (
                      <>
                        <ToggleList
                          title="共享规则包"
                          items={data.rules}
                          selected={config.rulePackIds}
                          onChange={(rulePackIds) => setConfig({ ...config, rulePackIds })}
                        />
                        <fieldset>
                          <legend>专属规则 · 按顺序匹配</legend>
                          {config.customRules.map((rule, i) => (
                            <div className="rule-row" key={i}>
                              <select
                                aria-label="规则类型"
                                value={rule.type}
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    customRules: config.customRules.map((r, j) =>
                                      i === j ? { ...r, type: e.target.value as Rule['type'] } : r,
                                    ),
                                  })
                                }
                              >
                                {['domain', 'domain-suffix', 'domain-keyword', 'ip-cidr'].map(
                                  (t) => (
                                    <option key={t}>{t}</option>
                                  ),
                                )}
                              </select>
                              <input
                                aria-label="规则内容"
                                required
                                value={rule.value}
                                placeholder="corp.example"
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    customRules: config.customRules.map((r, j) =>
                                      i === j ? { ...r, value: e.target.value } : r,
                                    ),
                                  })
                                }
                              />
                              <input
                                aria-label="规则动作"
                                required
                                value={rule.action}
                                placeholder="DIRECT / PROXY / 组名"
                                onChange={(e) =>
                                  setConfig({
                                    ...config,
                                    customRules: config.customRules.map((r, j) =>
                                      i === j ? { ...r, action: e.target.value } : r,
                                    ),
                                  })
                                }
                              />
                              <button
                                type="button"
                                disabled={!i}
                                aria-label="规则上移"
                                onClick={() => {
                                  const rules = [...config.customRules];
                                  [rules[i - 1], rules[i]] = [rules[i]!, rules[i - 1]!];
                                  setConfig({ ...config, customRules: rules });
                                }}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                aria-label="删除规则"
                                onClick={() =>
                                  setConfig({
                                    ...config,
                                    customRules: config.customRules.filter((_, j) => j !== i),
                                  })
                                }
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() =>
                              setConfig({
                                ...config,
                                customRules: [
                                  ...config.customRules,
                                  { type: 'domain-suffix', value: '', action: 'DIRECT' },
                                ],
                              })
                            }
                          >
                            添加规则
                          </button>
                        </fieldset>
                      </>
                    )}
                    {configTab === 'routing' && (
                      <>
                        <fieldset>
                          <legend>自定义策略组</legend>
                          {config.groups.map((g, i) => (
                            <div className="row" key={i}>
                              <label>
                                组名
                                <input
                                  required
                                  value={g.name}
                                  onChange={(e) =>
                                    setConfig({
                                      ...config,
                                      groups: config.groups.map((v, j) =>
                                        i === j ? { ...v, name: e.target.value } : v,
                                      ),
                                    })
                                  }
                                />
                              </label>
                              <label>
                                选入名称包含
                                <input
                                  value={g.filter}
                                  onChange={(e) =>
                                    setConfig({
                                      ...config,
                                      groups: config.groups.map((v, j) =>
                                        i === j ? { ...v, filter: e.target.value } : v,
                                      ),
                                    })
                                  }
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  setConfig({
                                    ...config,
                                    groups: config.groups.filter((_, j) => j !== i),
                                  })
                                }
                              >
                                删除
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() =>
                              setConfig({
                                ...config,
                                groups: [...config.groups, { name: '', filter: '' }],
                              })
                            }
                          >
                            添加策略组
                          </button>
                        </fieldset>
                        <div className="row">
                          <label>
                            DNS 服务器 IP（逗号分隔）
                            <input
                              required
                              value={config.dnsServers.join(', ')}
                              onChange={(e) =>
                                setConfig({
                                  ...config,
                                  dnsServers: e.target.value.split(',').map((s) => s.trim()),
                                })
                              }
                            />
                          </label>
                          <label>
                            兜底动作
                            <input
                              required
                              value={config.finalAction}
                              onChange={(e) =>
                                setConfig({ ...config, finalAction: e.target.value })
                              }
                            />
                          </label>
                          <label>
                            快照有效期（小时）
                            <input
                              type="number"
                              min="1"
                              max="8760"
                              value={config.maxStaleHours}
                              onChange={(e) =>
                                setConfig({ ...config, maxStaleHours: Number(e.target.value) })
                              }
                            />
                          </label>
                        </div>
                      </>
                    )}
                    {configTab === 'scripts' && (
                      <>
                        <ToggleList
                          title="后处理脚本"
                          items={data.scripts}
                          selected={config.scriptIds}
                          onChange={(scriptIds) => setConfig({ ...config, scriptIds })}
                        />
                        <details>
                          <summary>脚本参数（JSON）</summary>
                          <textarea
                            rows={4}
                            aria-label="脚本参数 JSON"
                            value={paramsText}
                            onChange={(e) => setParamsText(e.target.value)}
                          />
                        </details>
                      </>
                    )}
                  </div>
                </>
              )}
              {page === 'sources' && (
                <>
                  <div className="row">
                    <label>
                      来源名称
                      <input
                        required
                        value={source.name}
                        onChange={(e) => setSource({ ...source, name: e.target.value })}
                      />
                    </label>
                    <label>
                      来源类型
                      <select
                        value={source.kind}
                        onChange={(e) =>
                          setSource({ ...source, kind: e.target.value as SourceInput['kind'] })
                        }
                      >
                        <option value="subscription">机场订阅</option>
                        <option value="manual">自建 / 手动节点</option>
                      </select>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={source.enabled}
                        onChange={(e) => setSource({ ...source, enabled: e.target.checked })}
                      />
                      启用
                    </label>
                  </div>
                  {source.kind === 'subscription' ? (
                    <>
                      <label>
                        订阅 URL
                        <input
                          type="url"
                          required
                          value={source.url}
                          onChange={(e) => setSource({ ...source, url: e.target.value })}
                          placeholder="https://…"
                        />
                      </label>
                      <ScheduleEditor
                        value={source.schedule}
                        onChange={(schedule) => setSource({ ...source, schedule })}
                      />
                      <details>
                        <summary>自定义请求头（JSON）</summary>
                        <textarea
                          value={headersText}
                          onChange={(e) => setHeadersText(e.target.value)}
                        />
                      </details>
                    </>
                  ) : (
                    <label>
                      节点内容
                      <textarea
                        rows={8}
                        required
                        value={source.content}
                        onChange={(e) => setSource({ ...source, content: e.target.value })}
                        placeholder="URI / Base64 列表 / Clash YAML / sing-box JSON"
                      />
                    </label>
                  )}
                </>
              )}
              {page === 'rules' && (
                <>
                  <div className="toolbar">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setPack({
                          ...pack,
                          name: 'ACL4SSR 局域网',
                          url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list',
                          defaultAction: 'DIRECT',
                        })
                      }
                    >
                      引用 ACL4SSR 局域网
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        setPack({
                          ...pack,
                          name: 'ACL4SSR ProxyLite',
                          url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ProxyLite.list',
                          defaultAction: 'PROXY',
                        })
                      }
                    >
                      引用 ACL4SSR ProxyLite
                    </button>
                  </div>
                  <p className="muted">
                    引用上游 URL，保存后下载；规则采用上游许可证。IP-ASN、GEOIP
                    和原生规则集暂不支持。
                  </p>
                  <label>
                    未写动作时使用
                    <input
                      required
                      value={pack.defaultAction}
                      onChange={(e) => setPack({ ...pack, defaultAction: e.target.value })}
                      placeholder="DIRECT / PROXY / 自定义策略组"
                    />
                  </label>
                  <label>
                    规则包名称
                    <input
                      required
                      value={pack.name}
                      onChange={(e) => setPack({ ...pack, name: e.target.value })}
                    />
                  </label>
                  <label>
                    远程规则 URL（选填）
                    <input
                      type="url"
                      value={pack.url}
                      onChange={(e) => setPack({ ...pack, url: e.target.value })}
                      placeholder="支持 ACL list 格式"
                    />
                  </label>
                  {pack.url ? (
                    <ScheduleEditor
                      value={pack.schedule}
                      onChange={(schedule) => setPack({ ...pack, schedule })}
                    />
                  ) : (
                    <label>
                      规则内容
                      <textarea
                        rows={8}
                        required
                        value={pack.content}
                        onChange={(e) => setPack({ ...pack, content: e.target.value })}
                        placeholder={
                          'DOMAIN-SUFFIX,example.com,DIRECT\nIP-CIDR,10.0.0.0/8,DIRECT,no-resolve'
                        }
                      />
                    </label>
                  )}
                  <p className="muted">
                    可参考 ACL4SSR、blackmatrix7 的 list 规则。目标原生 YAML / SRS / MRS 尚未接入。
                  </p>
                </>
              )}
              {page === 'scripts' && (
                <>
                  <div className="row">
                    <label>
                      脚本名称
                      <input
                        required
                        value={script.name}
                        onChange={(e) => setScript({ ...script, name: e.target.value })}
                      />
                    </label>
                    <label>
                      处理阶段
                      <select
                        value={script.stage}
                        onChange={(e) =>
                          setScript({ ...script, stage: e.target.value as ScriptInput['stage'] })
                        }
                      >
                        <option value="config">生成后的配置</option>
                        <option value="nodes">归一化节点</option>
                      </select>
                    </label>
                  </div>
                  <fieldset>
                    <legend>适用目标</legend>
                    <div className="checks">
                      {targets.map((t) => (
                        <label key={t}>
                          <input
                            type="checkbox"
                            checked={script.targets.includes(t)}
                            onChange={(e) =>
                              setScript({
                                ...script,
                                targets: e.target.checked
                                  ? [...script.targets, t]
                                  : script.targets.filter((s) => s !== t),
                              })
                            }
                          />
                          {t}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label>
                    JavaScript
                    <textarea
                      className="code"
                      rows={12}
                      required
                      value={script.code}
                      onChange={(e) => setScript({ ...script, code: e.target.value })}
                      spellCheck={false}
                    />
                  </label>
                  <p className="muted">
                    定义同步 transform(input, context) 并返回结果。context 包含
                    target、configId、params；不提供 Node、网络或文件 API。
                  </p>
                </>
              )}
              <div className="actions">
                <button className="primary" disabled={busy}>
                  {busy ? '保存中…' : '保存'}
                </button>
                <button type="button" onClick={closeEditor}>
                  取消
                </button>
              </div>
            </form>
            {page === 'configs' && editing && (
              <div className="preview-tools">
                <select
                  aria-label="输出格式"
                  value={target}
                  onChange={(e) => setTarget(e.target.value as Target)}
                >
                  {targets.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <select
                  aria-label="输出模式"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as 'full' | 'nodes')}
                >
                  <option value="full">完整配置</option>
                  <option value="nodes">节点片段</option>
                </select>
                <button
                  disabled={busy}
                  onClick={() =>
                    action(async () =>
                      setPreview(
                        await api(`configs/${editing.id}/outputs/${target}/preview`, 'POST', {
                          mode,
                        }),
                      ),
                    )
                  }
                >
                  预览已保存配置
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      setPreview(
                        await api(`configs/${editing.id}/outputs/${target}/publish`, 'POST', {
                          mode,
                        }),
                      );
                      setNotice('配置已发布，现有链接使用新版本。');
                    })
                  }
                >
                  校验并发布
                </button>
              </div>
            )}
            {preview && (
              <div className="preview">
                {preview.warnings.map((w, i) => (
                  <p className="warning" key={i}>
                    {w}
                  </p>
                ))}
                <label>
                  生成结果（含节点认证信息）
                  <textarea rows={15} readOnly className="code" value={preview.body} />
                </label>
              </div>
            )}
          </section>
        )}
        {page === 'shares' && editor && (
          <section className="panel editor-panel">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  const result = await api('shares', 'POST', {
                    ...shareForm,
                    expiresAt: shareForm.expiresAt
                      ? new Date(shareForm.expiresAt).toISOString()
                      : null,
                  });
                  setNewLink(result.url);
                });
              }}
            >
              <div className="row">
                <label>
                  链接名称
                  <input
                    required
                    value={shareForm.name}
                    onChange={(e) => setShareForm({ ...shareForm, name: e.target.value })}
                    placeholder="用于区分接收者"
                  />
                </label>
                <label>
                  所属配置
                  <select
                    required
                    value={shareForm.configId}
                    onChange={(e) => setShareForm({ ...shareForm, configId: e.target.value })}
                  >
                    <option value="">选择一份配置</option>
                    {data.configs.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  客户端格式
                  <select
                    value={shareForm.target}
                    onChange={(e) =>
                      setShareForm({ ...shareForm, target: e.target.value as Target })
                    }
                  >
                    {targets.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="row">
                <label>
                  输出内容
                  <select
                    value={shareForm.mode}
                    onChange={(e) => setShareForm({ ...shareForm, mode: e.target.value })}
                  >
                    <option value="full">完整配置</option>
                    <option value="nodes">节点片段（供手动集成）</option>
                  </select>
                </label>
                <label>
                  过期时间（选填）
                  <input
                    type="datetime-local"
                    value={shareForm.expiresAt}
                    onChange={(e) => setShareForm({ ...shareForm, expiresAt: e.target.value })}
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={shareForm.pinned}
                    onChange={(e) => setShareForm({ ...shareForm, pinned: e.target.checked })}
                  />
                  固定当前版本
                </label>
              </div>
              <button className="primary" disabled={busy}>
                生成链接
              </button>
            </form>
            {newLink && (
              <div className="new-link">
                <strong>请保存此链接，离开页面后不再显示</strong>
                <div className="row">
                  <input
                    aria-label="新订阅链接"
                    readOnly
                    value={newLink}
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    onClick={() =>
                      action(async () => {
                        await navigator.clipboard.writeText(newLink);
                        setNotice('已复制');
                      })
                    }
                  >
                    复制
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
        {!editor && (
          <section className="panel list">
            <div className="list-toolbar">
              <input
                type="search"
                aria-label={'搜索' + labels[page]}
                placeholder={page === 'jobs' ? '搜索任务或资源' : '搜索名称'}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className="muted">
                {search ? `${visibleItems.length} / ${data[page].length}` : data[page].length} 项
              </span>
              {search && (
                <button className="text-button" onClick={() => setSearch('')}>
                  清除
                </button>
              )}
            </div>
            {!visibleItems.length ? (
              <div className="empty">
                <h3>{search ? '没有匹配记录' : '暂无' + labels[page]}</h3>
                <p className="muted">
                  {search
                    ? '换一个关键词，或清除搜索。'
                    : page === 'configs'
                      ? '添加节点来源后，新建配置。'
                      : page === 'jobs'
                        ? '更新来源或发布配置后，会显示执行记录。'
                        : '使用右上角操作添加记录。'}
                </p>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{page === 'jobs' ? '任务' : '名称'}</th>
                      <th>{page === 'configs' ? '状态' : '内容 / 状态'}</th>
                      {page === 'configs' && (
                        <>
                          <th>来源</th>
                          <th>专属规则</th>
                        </>
                      )}
                      <th>{page === 'jobs' ? '执行时间' : '更新时间'}</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>
                            {item.name ||
                              (
                                {
                                  source: '来源更新',
                                  'rule-pack': '规则更新',
                                  publish: '配置生成',
                                } as any
                              )[item.kind]}
                          </strong>
                          {page === 'jobs' && <small>{jobResource(item)}</small>}
                        </td>
                        <td>
                          {page === 'configs' ? (
                            <span className={'badge ' + (item.enabled ? '' : 'dim')}>
                              {item.enabled ? '启用' : '停用'}
                            </span>
                          ) : page === 'sources' ? (
                            `${item.nodeCount} 个节点${item.enabled ? '' : ' · 已停用'}`
                          ) : page === 'rules' ? (
                            `${item.rules?.length || 0} 条规则`
                          ) : page === 'scripts' ? (
                            `${item.stage} · ${item.targets.join(', ')}`
                          ) : page === 'shares' ? (
                            <>
                              <span
                                className={
                                  'badge ' +
                                  (item.revokedAt ||
                                  (item.expiresAt && item.expiresAt < new Date().toISOString())
                                    ? 'dim'
                                    : '')
                                }
                              >
                                {item.revokedAt
                                  ? '已撤销'
                                  : item.expiresAt && item.expiresAt < new Date().toISOString()
                                    ? '已过期'
                                    : '有效'}
                              </span>{' '}
                              {data.configs.find((c) => c.id === item.configId)?.name ||
                                '配置已删除'}{' '}
                              / {item.target}
                            </>
                          ) : (
                            <span
                              className={
                                'badge ' +
                                (item.status === 'failed'
                                  ? 'bad'
                                  : item.status === 'running'
                                    ? 'dim'
                                    : '')
                              }
                            >
                              {
                                ({ running: '执行中', succeeded: '成功', failed: '失败' } as any)[
                                  item.status
                                ]
                              }
                            </span>
                          )}
                          {item.error && <small className="warning">{item.error}</small>}
                          {item.diagnostics?.length > 0 && (
                            <small className="warning">
                              {item.diagnostics.length} 个节点有解析问题
                            </small>
                          )}
                        </td>
                        {page === 'configs' && (
                          <>
                            <td className="numeric">{item.sourceIds.length}</td>
                            <td className="numeric">{item.customRules.length}</td>
                          </>
                        )}
                        <td className="time-cell">
                          {formatTime(
                            page === 'jobs' ? item.startedAt : item.fetchedAt || item.updatedAt,
                          )}
                          {item.nextRunAt && <small>下次：{formatTime(item.nextRunAt)}</small>}
                        </td>
                        <td className="table-actions">
                          {['configs', 'sources', 'rules', 'scripts'].includes(page) && (
                            <>
                              <button disabled={busy} onClick={() => action(() => edit(item))}>
                                编辑
                              </button>
                              {page === 'configs' && (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    action(async () => {
                                      const copy = clean(item, defaultConfig);
                                      await api('configs', 'POST', {
                                        ...copy,
                                        name: copy.name + ' 副本',
                                      });
                                    })
                                  }
                                >
                                  复制
                                </button>
                              )}
                              {['sources', 'rules'].includes(page) && (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    action(() =>
                                      api(
                                        `${page === 'rules' ? 'rule-packs' : page}/${item.id}/refresh`,
                                        'POST',
                                        {},
                                      ),
                                    )
                                  }
                                >
                                  更新
                                </button>
                              )}
                              <button
                                className="danger"
                                disabled={busy}
                                onClick={() => {
                                  if (confirm('删除这条记录？引用它的配置可能需要重新编辑。'))
                                    void action(() =>
                                      api(
                                        `${page === 'rules' ? 'rule-packs' : page}/${item.id}`,
                                        'DELETE',
                                      ),
                                    );
                                }}
                              >
                                删除
                              </button>
                            </>
                          )}
                          {page === 'shares' && !item.revokedAt && (
                            <button
                              className="danger"
                              disabled={busy}
                              onClick={() =>
                                action(() => api(`shares/${item.id}/revoke`, 'POST', {}))
                              }
                            >
                              撤销
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        {page === 'jobs' && (
          <details className="backup-section">
            <summary>备份与恢复</summary>
            <section className="panel">
              <div className="section-title">
                <h2>加密备份</h2>
              </div>
              <p className="muted">
                导出数据库记录，主密钥需要另外保存。恢复会替换当前数据并退出登录。
              </p>
              <div className="actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      const backup = await api('backup');
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(backup)], { type: 'application/json' }),
                      );
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = 'subharbor-backup.json';
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  导出备份
                </button>
                <label className="restore-label">
                  恢复备份
                  <input
                    type="file"
                    accept="application/json,.json"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file || !confirm('恢复将替换当前全部数据并退出登录，继续？')) return;
                      void action(async () => {
                        await api('backup/restore', 'POST', JSON.parse(await file.text()));
                        setUser('');
                        csrf = '';
                        return false;
                      });
                    }}
                  />
                </label>
              </div>
            </section>
          </details>
        )}
      </main>
    </div>
  );
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
