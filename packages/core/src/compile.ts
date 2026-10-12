import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import {
  NodeSchema,
  type Node,
  type SubscriptionConfig,
  type Target,
  type Rule,
} from '../../contracts/src/index.js';
import { parseNodes, parseRules, validateRule } from '../../adapters/src/parse.js';

export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stableJSON(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}

export function aggregate(nodes: Node[], config: SubscriptionConfig, key: Buffer): Node[] {
  const result: Node[] = [],
    byFingerprint = new Map<string, Node>();
  for (const node of nodes) {
    if (config.include && !node.name.includes(config.include)) continue;
    if (config.exclude && node.name.includes(config.exclude)) continue;
    const { name, sourceIds, ...connection } = node;
    const fingerprint = createHmac('sha256', key).update(stableJSON(connection)).digest('hex');
    const existing = byFingerprint.get(fingerprint);
    if (existing && config.deduplicate) {
      existing.sourceIds = [...new Set([...existing.sourceIds, ...sourceIds])];
      continue;
    }
    const copy = structuredClone(node);
    copy.name = config.prefix + name;
    result.push(copy);
    byFingerprint.set(fingerprint, copy);
  }
  if (config.sort) result.sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set(['PROXY', 'AUTO', 'DIRECT', 'REJECT', ...config.groups.map((g) => g.name)]);
  for (const n of result) {
    const base = n.name;
    let suffix = 1;
    while (seen.has(n.name)) n.name = `${base} (${++suffix})`;
    seen.add(n.name);
  }
  return result;
}

export function compatible(nodes: Node[], target: Target, strict: boolean) {
  const kept: Node[] = [],
    warnings: string[] = [];
  for (const n of nodes) {
    let supported =
      target !== 'clash' || ['ss', 'vmess', 'trojan', 'http', 'socks5'].includes(n.type);
    if (target === 'clash' && n.type === 'ss' && n.cipher?.startsWith('2022-')) supported = false;
    if (target === 'clash' && (n.tls?.reality || n.transport?.type === 'grpc')) supported = false;
    if (!supported) {
      warnings.push(`目标 ${target} 不支持节点「${n.name}」的协议或参数`);
      continue;
    }
    kept.push(n);
  }
  if (strict && warnings.length) throw new Error('存在不兼容节点，严格模式拒绝生成');
  if (!kept.length) throw new Error('目标格式没有可用节点');
  return { nodes: kept, warnings };
}

function clashNode(n: Node): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: n.name,
    type: n.type,
    server: n.server,
    port: n.port,
    udp: true,
  };
  for (const k of ['password', 'username', 'uuid', 'flow'] as const) if (n[k]) p[k] = n[k];
  if (n.type === 'ss') p.cipher = n.cipher;
  if (n.type === 'vmess') {
    p.cipher = n.cipher || 'auto';
    p.alterId = n.alterId || 0;
  }
  if (n.tls?.enabled) {
    if (['vmess', 'vless', 'http'].includes(n.type)) p.tls = true;
    if (n.tls.serverName)
      p[['trojan', 'hysteria2', 'tuic'].includes(n.type) ? 'sni' : 'servername'] = n.tls.serverName;
    if (n.tls.insecure) p['skip-cert-verify'] = true;
    if (n.tls.fingerprint) p['client-fingerprint'] = n.tls.fingerprint;
    if (n.tls.alpn) p.alpn = n.tls.alpn;
    if (n.tls.reality)
      p['reality-opts'] = {
        'public-key': n.tls.reality.publicKey,
        'short-id': n.tls.reality.shortId,
      };
  }
  if (n.transport) {
    p.network = n.transport.type;
    if (n.transport.type === 'ws')
      p['ws-opts'] = {
        path: n.transport.path || '/',
        headers: n.transport.host ? { Host: n.transport.host } : undefined,
      };
    else p['grpc-opts'] = { 'grpc-service-name': n.transport.serviceName || '' };
  }
  if (n.obfs) {
    p.obfs = n.obfs.type;
    p['obfs-password'] = n.obfs.password;
  }
  if (n.congestionControl) p['congestion-controller'] = n.congestionControl;
  if (n.udpRelayMode) p['udp-relay-mode'] = n.udpRelayMode;
  return p;
}

function singNode(n: Node): Record<string, unknown> {
  const p: Record<string, unknown> = {
    tag: n.name,
    type: n.type === 'ss' ? 'shadowsocks' : n.type === 'socks5' ? 'socks' : n.type,
    server: n.server,
    server_port: n.port,
  };
  for (const k of ['password', 'username', 'uuid', 'flow'] as const) if (n[k]) p[k] = n[k];
  if (n.type === 'ss') p.method = n.cipher;
  if (n.type === 'vmess') {
    p.security = n.cipher || 'auto';
    p.alter_id = n.alterId || 0;
  }
  if (n.type === 'socks5') p.version = '5';
  if (n.tls?.enabled)
    p.tls = {
      enabled: true,
      server_name: n.tls.serverName,
      insecure: n.tls.insecure || undefined,
      alpn: n.tls.alpn,
      utls: n.tls.fingerprint ? { enabled: true, fingerprint: n.tls.fingerprint } : undefined,
      reality: n.tls.reality
        ? { enabled: true, public_key: n.tls.reality.publicKey, short_id: n.tls.reality.shortId }
        : undefined,
    };
  if (n.transport)
    p.transport =
      n.transport.type === 'ws'
        ? {
            type: 'ws',
            path: n.transport.path || '/',
            headers: n.transport.host ? { Host: n.transport.host } : undefined,
          }
        : { type: 'grpc', service_name: n.transport.serviceName || '' };
  if (n.obfs) p.obfs = n.obfs;
  if (n.congestionControl) p.congestion_control = n.congestionControl;
  if (n.udpRelayMode) p.udp_relay_mode = n.udpRelayMode;
  return p;
}

export function render(
  nodes: Node[],
  rules: Rule[],
  config: SubscriptionConfig,
  target: Target,
  mode: 'full' | 'nodes',
): Record<string, any> {
  for (const r of rules) validateRule(r);
  if (config.dnsServers.some((ip) => !isIP(ip)))
    throw new Error('DNS 设置目前只接受 DNS 服务器 IP 地址');
  const names = nodes.map((n) => n.name);
  const groups = config.groups.map((g) => ({
    name: g.name,
    nodes: names.filter((n) => !g.filter || n.includes(g.filter)),
  }));
  if (
    new Set(['PROXY', 'AUTO', 'DIRECT', 'REJECT', ...groups.map((g) => g.name)]).size !==
    4 + groups.length
  )
    throw new Error('策略组名称重复或使用保留名称');
  if (groups.some((g) => !g.nodes.length)) throw new Error('自定义策略组没有节点');
  const targets = new Set([
    ...names,
    'PROXY',
    'AUTO',
    'DIRECT',
    'REJECT',
    ...groups.map((g) => g.name),
  ]);
  if (!targets.has(config.finalAction) || config.finalAction === 'REJECT')
    throw new Error('兜底动作必须引用可用节点或策略组');
  for (const r of rules)
    if (!targets.has(r.action)) throw new Error('规则引用了不存在的节点或策略组');
  if (target !== 'sing-box') {
    const proxies = nodes.map(clashNode);
    if (mode === 'nodes') return { proxies };
    const map: Record<Rule['type'], string> = {
      domain: 'DOMAIN',
      'domain-suffix': 'DOMAIN-SUFFIX',
      'domain-keyword': 'DOMAIN-KEYWORD',
      'ip-cidr': 'IP-CIDR',
    };
    return {
      'mixed-port': 7890,
      'allow-lan': false,
      'bind-address': '127.0.0.1',
      mode: 'rule',
      'log-level': 'info',
      ipv6: true,
      dns: { enable: true, listen: '127.0.0.1:1053', nameserver: config.dnsServers },
      proxies,
      'proxy-groups': [
        {
          name: 'AUTO',
          type: 'url-test',
          proxies: names,
          url: 'https://www.gstatic.com/generate_204',
          interval: 300,
        },
        { name: 'PROXY', type: 'select', proxies: ['AUTO', ...names] },
        ...groups.map((g) => ({ name: g.name, type: 'select', proxies: g.nodes })),
      ],
      rules: [
        ...rules.map(
          (r) =>
            `${r.type === 'ip-cidr' && r.value.includes(':') ? 'IP-CIDR6' : map[r.type]},${r.value},${r.action}${r.type === 'ip-cidr' ? ',no-resolve' : ''}`,
        ),
        `MATCH,${config.finalAction}`,
      ],
    };
  }
  const outbounds = nodes.map(singNode);
  if (mode === 'nodes') return { outbounds };
  const action = (s: string) =>
    s === 'REJECT' ? { action: 'reject' } : { action: 'route', outbound: s };
  const fields: Record<Rule['type'], string> = {
    domain: 'domain',
    'domain-suffix': 'domain_suffix',
    'domain-keyword': 'domain_keyword',
    'ip-cidr': 'ip_cidr',
  };
  return {
    log: { level: 'info' },
    dns: {
      servers: config.dnsServers.map((server, i) => ({ tag: `dns-${i}`, type: 'udp', server })),
      final: 'dns-0',
    },
    inbounds: [{ tag: 'mixed-in', type: 'mixed', listen: '127.0.0.1', listen_port: 7890 }],
    outbounds: [
      ...outbounds,
      { tag: 'DIRECT', type: 'direct' },
      {
        tag: 'AUTO',
        type: 'urltest',
        outbounds: names,
        url: 'https://www.gstatic.com/generate_204',
        interval: '5m',
      },
      { tag: 'PROXY', type: 'selector', outbounds: ['AUTO', ...names], default: 'AUTO' },
      ...groups.map((g) => ({ tag: g.name, type: 'selector', outbounds: g.nodes })),
    ],
    route: {
      rules: rules.map((r) => ({ [fields[r.type]]: [r.value], ...action(r.action) })),
      final: config.finalAction,
      default_domain_resolver: 'dns-0',
    },
  };
}

export function validateOutput(output: unknown, target: Target, mode: 'full' | 'nodes'): void {
  if (!output || typeof output !== 'object' || Array.isArray(output))
    throw new Error('脚本必须返回配置对象');
  const obj = output as Record<string, any>;
  if (target === 'sing-box') {
    if (!Array.isArray(obj.outbounds) || !obj.outbounds.length) throw new Error('缺少 outbounds');
    const names = obj.outbounds.map((p: any) => p.tag);
    if (
      names.some((s: unknown) => typeof s !== 'string' || !s) ||
      new Set(names).size !== names.length
    )
      throw new Error('出站标签无效或重复');
    const edges = new Map<string, string[]>();
    for (const p of obj.outbounds) {
      if (['selector', 'urltest'].includes(p.type)) {
        if (
          !Array.isArray(p.outbounds) ||
          !p.outbounds.length ||
          p.outbounds.some((n: string) => !names.includes(n))
        )
          throw new Error('策略组引用无效');
        if (p.default && !p.outbounds.includes(p.default)) throw new Error('默认出站引用无效');
        edges.set(p.tag, p.outbounds);
      } else if (p.type === 'direct') {
        if (p.tag !== 'DIRECT') throw new Error('DIRECT 标签无效');
      } else parseNodes(JSON.stringify({ outbounds: [p] }));
    }
    checkCycles(edges);
    if (mode === 'full') {
      if (
        !Array.isArray(obj.inbounds) ||
        !obj.dns?.servers?.length ||
        !Array.isArray(obj.route?.rules) ||
        !names.includes(obj.route.final)
      )
        throw new Error('完整配置缺少入站、DNS 或路由');
      for (const rule of obj.route.rules) {
        if (!['route', 'reject'].includes(rule.action)) throw new Error('不支持的规则动作');
        if (rule.action === 'route' && !names.includes(rule.outbound))
          throw new Error('规则引用无效');
      }
    }
  } else {
    if (!Array.isArray(obj.proxies) || !obj.proxies.length) throw new Error('缺少 proxies');
    obj.proxies.forEach((p: any) =>
      compatible(parseNodes(JSON.stringify({ proxies: [p] })).nodes, target, true),
    );
    const groups = mode === 'full' ? obj['proxy-groups'] : [];
    if (!Array.isArray(groups)) throw new Error('策略组无效');
    const names = [
      ...obj.proxies.map((n: any) => n.name),
      ...groups.map((g: any) => g.name),
      'DIRECT',
      'REJECT',
    ];
    if (new Set(names).size !== names.length) throw new Error('节点或策略组名称重复');
    const edges = new Map<string, string[]>();
    for (const g of groups) {
      if (
        !['select', 'url-test'].includes(g.type) ||
        !g.proxies?.length ||
        g.proxies.some((n: string) => !names.includes(n))
      )
        throw new Error('策略组引用无效');
      edges.set(g.name, g.proxies);
    }
    checkCycles(edges);
    if (mode === 'full') {
      if (!Array.isArray(obj.rules) || !obj.rules.length || !obj.rules.at(-1)?.startsWith('MATCH,'))
        throw new Error('缺少最后一条 MATCH 规则');
      if (obj.rules.slice(0, -1).some((s: string) => s.startsWith('MATCH,')))
        throw new Error('MATCH 只能出现在最后');
      for (const r of obj.rules) {
        if (typeof r !== 'string') throw new Error('规则必须是字符串');
        const t = r.split(',');
        const action = t[0] === 'MATCH' ? t[1] : t[2];
        if (!names.includes(action)) throw new Error('规则引用无效');
        if (t[0] !== 'MATCH') parseRules(r);
      }
    }
  }
}
function checkCycles(edges: Map<string, string[]>) {
  const done = new Set<string>(),
    visiting = new Set<string>();
  function visit(name: string) {
    if (visiting.has(name)) throw new Error('策略组存在循环引用');
    if (done.has(name)) return;
    visiting.add(name);
    for (const child of edges.get(name) || []) visit(child);
    visiting.delete(name);
    done.add(name);
  }
  for (const name of edges.keys()) visit(name);
}
export function serialize(output: Record<string, any>, target: Target): string {
  const body =
    target === 'sing-box' ? JSON.stringify(output, null, 2) + '\n' : yamlStringify(output);
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('配置超过输出限额');
  if (target === 'sing-box') JSON.parse(body);
  else yamlParse(body, { maxAliasCount: 20 });
  return body;
}
export function validateNodes(value: unknown): Node[] {
  return NodeSchema.array().min(1).max(10000).parse(value);
}
