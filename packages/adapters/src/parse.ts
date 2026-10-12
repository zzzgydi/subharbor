import { parse as yamlParse } from 'yaml';
import { isIP } from 'node:net';
import { NodeSchema, type Node, Rule, type Rule as RuleType } from '../../contracts/src/index.js';

const decode64 = (value: string) =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const text = (value: unknown) => (value === undefined ? undefined : String(value));
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('节点结构必须是对象');
  return value as Record<string, any>;
};

function checkKeys(value: Record<string, any>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('包含尚未支持的字段');
}

function validateNode(value: unknown): Node {
  const n = NodeSchema.parse(value);
  if (['vmess', 'vless', 'tuic'].includes(n.type) && !n.uuid) throw new Error('节点缺少 UUID');
  if (['ss', 'trojan', 'hysteria2', 'tuic'].includes(n.type) && !n.password)
    throw new Error('节点缺少密码');
  if (n.type === 'ss' && !n.cipher) throw new Error('SS 节点缺少 cipher');
  if (n.transport && !['vmess', 'vless', 'trojan'].includes(n.type))
    throw new Error('协议不支持该传输');
  if (n.flow && (n.type !== 'vless' || n.transport || !n.tls?.enabled))
    throw new Error('Vision 需要 VLESS TCP TLS');
  if (n.obfs && n.type !== 'hysteria2') throw new Error('仅 Hysteria2 支持 salamander');
  if (n.type === 'tuic' && !['native', 'quic', undefined].includes(n.udpRelayMode))
    throw new Error('不支持该 TUIC UDP 模式');
  if (n.flow && n.flow !== 'xtls-rprx-vision') throw new Error('不支持该 VLESS flow');
  if (n.tls?.reality && n.type !== 'vless') throw new Error('REALITY 仅支持 VLESS');
  if (n.tls?.reality && n.transport) throw new Error('REALITY 目前仅支持 TCP');
  if (n.type === 'tuic' && !['cubic', 'new_reno', 'bbr', undefined].includes(n.congestionControl))
    throw new Error('不支持该 TUIC 拥塞控制');
  return n;
}

function uri(line: string): Node {
  if (line.startsWith('vmess://')) {
    const v = object(JSON.parse(decode64(line.slice(8))));
    checkKeys(v, [
      'v',
      'ps',
      'add',
      'port',
      'id',
      'aid',
      'scy',
      'net',
      'type',
      'host',
      'path',
      'tls',
      'sni',
      'alpn',
      'fp',
    ]);
    if (v.type && v.type !== 'none') throw new Error('不支持该 VMess 头部');
    if (!['tcp', 'ws', 'grpc', undefined, ''].includes(v.net))
      throw new Error('不支持该 VMess 传输');
    return validateNode({
      name: v.ps || 'VMess',
      type: 'vmess',
      server: v.add,
      port: Number(v.port),
      uuid: v.id,
      cipher: v.scy || 'auto',
      alterId: Number(v.aid || 0),
      tls: {
        enabled: v.tls === 'tls',
        serverName: v.sni || v.host || undefined,
        alpn: v.alpn ? String(v.alpn).split(',') : undefined,
        fingerprint: v.fp || undefined,
      },
      transport:
        v.net === 'ws'
          ? { type: 'ws', path: v.path || '/', host: v.host || undefined }
          : v.net === 'grpc'
            ? { type: 'grpc', serviceName: v.path || '' }
            : undefined,
    });
  }
  // SIP002 permits Base64 userinfo and the legacy Base64 of the entire authority.
  if (line.startsWith('ss://')) {
    let value = line;
    const tail = line.slice(5).split('#')[0]!;
    if (!tail.includes('@'))
      value =
        'ss://' +
        decode64(tail) +
        (line.includes('#') ? '#' + line.split('#').slice(1).join('#') : '');
    const u = new URL(value);
    checkKeys(Object.fromEntries(u.searchParams), []);
    if (u.searchParams.has('plugin')) throw new Error('SS plugin 尚未支持');
    const credentials = u.password
      ? decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)
      : decode64(decodeURIComponent(u.username));
    const colon = credentials.indexOf(':');
    if (colon < 1) throw new Error('SS 认证格式无效');
    return validateNode({
      name: decodeURIComponent(u.hash.slice(1)) || 'SS',
      type: 'ss',
      server: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port),
      cipher: credentials.slice(0, colon),
      password: credentials.slice(colon + 1),
    });
  }
  const u = new URL(line);
  const scheme = u.protocol.slice(0, -1);
  const type = scheme === 'hy2' ? 'hysteria2' : scheme === 'https' ? 'http' : scheme;
  if (!['vless', 'trojan', 'http', 'socks5', 'hysteria2', 'tuic'].includes(type))
    throw new Error('不支持该协议');
  const q = u.searchParams;
  const allowed = ['security', 'sni', 'peer', 'insecure', 'allowInsecure', 'fp', 'alpn'];
  if (['vless', 'trojan'].includes(type)) allowed.push('type', 'path', 'host', 'serviceName');
  if (type === 'vless') allowed.push('flow', 'pbk', 'sid');
  if (type === 'tuic') allowed.push('congestion_control', 'udp_relay_mode');
  if (type === 'hysteria2') allowed.push('obfs', 'obfs-password');
  checkKeys(Object.fromEntries(q), allowed);
  const security = q.get('security');
  if (security && !['none', 'tls', 'reality'].includes(security)) throw new Error('不支持该安全层');
  const transport = q.get('type') || 'tcp';
  if (!['tcp', 'ws', 'grpc'].includes(transport)) throw new Error('不支持该传输');
  const tls = {
    enabled:
      security === 'tls' ||
      security === 'reality' ||
      ['trojan', 'hysteria2', 'tuic'].includes(type) ||
      scheme === 'https',
    serverName: q.get('sni') || q.get('peer') || undefined,
    insecure: ['1', 'true'].includes(q.get('insecure') || q.get('allowInsecure') || ''),
    fingerprint: q.get('fp') || undefined,
    alpn: q.get('alpn')?.split(','),
    reality:
      security === 'reality'
        ? { publicKey: q.get('pbk') || '', shortId: q.get('sid') || '' }
        : undefined,
  };
  if (tls.reality && !tls.reality.publicKey) throw new Error('缺少 REALITY 公钥');
  const n: Record<string, unknown> = {
    name: decodeURIComponent(u.hash.slice(1)) || type,
    type,
    server: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(
      u.port || (['trojan', 'hysteria2', 'tuic'].includes(type) || scheme === 'https' ? 443 : 0),
    ),
    tls,
    transport:
      transport === 'ws'
        ? { type: 'ws', path: q.get('path') || '/', host: q.get('host') || undefined }
        : transport === 'grpc'
          ? { type: 'grpc', serviceName: q.get('serviceName') || '' }
          : undefined,
  };
  if (type === 'vless') {
    n.uuid = decodeURIComponent(u.username);
    n.flow = q.get('flow') || undefined;
  } else if (type === 'tuic') {
    n.uuid = decodeURIComponent(u.username);
    n.password = decodeURIComponent(u.password);
    n.congestionControl = q.get('congestion_control') || 'cubic';
    n.udpRelayMode = q.get('udp_relay_mode') || 'native';
  } else if (['http', 'socks5'].includes(type)) {
    n.username = decodeURIComponent(u.username) || undefined;
    n.password = decodeURIComponent(u.password) || undefined;
  } else n.password = decodeURIComponent(u.username + (u.password ? ':' + u.password : ''));
  if (type === 'hysteria2' && q.get('obfs'))
    n.obfs = { type: q.get('obfs'), password: q.get('obfs-password') || '' };
  return validateNode(n);
}

function native(value: unknown, format: 'clash' | 'sing'): Node {
  const p = object(value);
  const sing = format === 'sing';
  if (
    p.plugin ||
    p['plugin-opts'] ||
    p['dialer-proxy'] ||
    p.detour ||
    p.multiplex ||
    p.smux ||
    p['packet-encoding'] ||
    p['packet-addr'] ||
    p['hop-interval'] ||
    p['ports']
  )
    throw new Error('包含尚未支持的插件、链式或扩展设置');
  checkKeys(
    p,
    sing
      ? [
          'tag',
          'type',
          'server',
          'server_port',
          'password',
          'username',
          'uuid',
          'method',
          'security',
          'alter_id',
          'flow',
          'tls',
          'transport',
          'obfs',
          'congestion_control',
          'udp_relay_mode',
          'version',
        ]
      : [
          'name',
          'type',
          'server',
          'port',
          'password',
          'username',
          'uuid',
          'cipher',
          'alterId',
          'flow',
          'tls',
          'servername',
          'sni',
          'skip-cert-verify',
          'alpn',
          'client-fingerprint',
          'reality-opts',
          'network',
          'ws-opts',
          'grpc-opts',
          'obfs',
          'obfs-password',
          'congestion-controller',
          'udp-relay-mode',
          'udp',
        ],
  );
  if (p.udp === false || (p.version !== undefined && p.version !== '5'))
    throw new Error('尚未支持关闭 UDP 或 SOCKS4');
  const type = p.type === 'shadowsocks' ? 'ss' : p.type === 'socks' ? 'socks5' : p.type;
  const n: Record<string, unknown> = {
    name: p.name || p.tag || type,
    type,
    server: p.server,
    port: Number(sing ? p.server_port : p.port),
    password: p.password,
    username: p.username,
    uuid: p.uuid,
    cipher: sing ? p.method || p.security : p.cipher,
    alterId: sing ? p.alter_id : p.alterId,
    flow: p.flow,
  };
  if (sing) {
    const t = p.tls;
    if (t) {
      checkKeys(object(t), ['enabled', 'server_name', 'insecure', 'alpn', 'utls', 'reality']);
      if (t.utls) checkKeys(object(t.utls), ['enabled', 'fingerprint']);
      if (t.reality) checkKeys(object(t.reality), ['enabled', 'public_key', 'short_id']);
    }
    if (t)
      n.tls = {
        enabled: t.enabled ?? true,
        serverName: t.server_name,
        insecure: t.insecure,
        alpn: t.alpn,
        fingerprint: t.utls?.enabled ? t.utls.fingerprint : undefined,
        reality: t.reality?.enabled
          ? { publicKey: t.reality.public_key, shortId: t.reality.short_id || '' }
          : undefined,
      };
    if (p.transport) {
      checkKeys(object(p.transport), ['type', 'path', 'headers', 'service_name']);
      if (p.transport.headers) checkKeys(object(p.transport.headers), ['Host']);
      if (!['ws', 'grpc'].includes(p.transport.type)) throw new Error('不支持该传输');
      n.transport = {
        type: p.transport.type,
        path: p.transport.path,
        host: p.transport.headers?.Host,
        serviceName: p.transport.service_name,
      };
    }
    n.obfs = p.obfs;
    n.congestionControl = p.congestion_control;
    n.udpRelayMode = p.udp_relay_mode;
  } else {
    const reality = p['reality-opts'];
    if (reality) checkKeys(object(reality), ['public-key', 'short-id']);
    if (p['ws-opts']) {
      checkKeys(object(p['ws-opts']), ['path', 'headers']);
      if (p['ws-opts'].headers) checkKeys(object(p['ws-opts'].headers), ['Host']);
    }
    if (p['grpc-opts']) checkKeys(object(p['grpc-opts']), ['grpc-service-name']);
    const enabled = p.tls || ['trojan', 'hysteria2', 'tuic'].includes(type);
    n.tls = {
      enabled: !!enabled,
      serverName: p.servername || p.sni,
      insecure: p['skip-cert-verify'],
      alpn: p.alpn,
      fingerprint: p['client-fingerprint'],
      reality: reality
        ? { publicKey: reality['public-key'], shortId: reality['short-id'] || '' }
        : undefined,
    };
    if (p.network && p.network !== 'tcp') {
      if (!['ws', 'grpc'].includes(p.network)) throw new Error('不支持该传输');
      n.transport =
        p.network === 'ws'
          ? { type: 'ws', path: p['ws-opts']?.path, host: p['ws-opts']?.headers?.Host }
          : { type: 'grpc', serviceName: p['grpc-opts']?.['grpc-service-name'] };
    }
    if (p.obfs) n.obfs = { type: p.obfs, password: p['obfs-password'] };
    n.congestionControl = p['congestion-controller'];
    n.udpRelayMode = p['udp-relay-mode'];
  }
  return validateNode(n);
}

export function parseNodes(
  content: string,
  sourceId = '',
): { nodes: Node[]; diagnostics: string[] } {
  const trimmed = content.trim();
  if (!trimmed || /^\s*</.test(trimmed)) throw new Error('订阅为空或返回 HTML');
  const nodes: Node[] = [],
    diagnostics: string[] = [];
  let entries: unknown[],
    format: 'uri' | 'clash' | 'sing' = 'uri';
  if (/^(\{|\[)/.test(trimmed) || /^\s*proxies\s*:/m.test(trimmed)) {
    const obj = yamlParse(trimmed, { maxAliasCount: 20 });
    if (Array.isArray(obj)) entries = obj;
    else if (obj && Array.isArray(obj.proxies)) {
      entries = obj.proxies;
      format = 'clash';
    } else if (obj && Array.isArray(obj.outbounds)) {
      entries = obj.outbounds.filter(
        (p: any) => !['direct', 'block', 'dns', 'selector', 'urltest'].includes(p?.type),
      );
      format = 'sing';
    } else throw new Error('未找到节点列表（远程 provider 须另行登记）');
    if (Array.isArray(obj)) format = entries.some((p: any) => p?.server_port) ? 'sing' : 'clash';
  } else {
    const decoded = trimmed.includes('://') ? trimmed : decode64(trimmed);
    entries = decoded
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  }
  if (entries.length > 10000) throw new Error('节点数量超过 10000');
  entries.forEach((entry, index) => {
    try {
      const node = format === 'uri' ? uri(String(entry)) : native(entry, format);
      nodes.push({ ...node, sourceIds: sourceId ? [sourceId] : [] });
    } catch {
      diagnostics.push(`第 ${index + 1} 个节点无法解析或包含不支持的参数`);
    }
  });
  if (!nodes.length) throw new Error('没有可用节点，请检查协议、认证和传输参数');
  return { nodes, diagnostics };
}

export function parseRules(content: string, defaultAction = 'PROXY'): RuleType[] {
  const types: Record<string, RuleType['type']> = {
    DOMAIN: 'domain',
    'DOMAIN-SUFFIX': 'domain-suffix',
    'DOMAIN-KEYWORD': 'domain-keyword',
    'IP-CIDR': 'ip-cidr',
    'IP-CIDR6': 'ip-cidr',
  };
  const result: RuleType[] = [];
  for (const [i, line] of content.split(/\r?\n/).entries()) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith(';')) continue;
    const [t, value, third, flag, ...extra] = s.split(',').map((x) => x.trim());
    if (!t || !types[t] || !value || extra.length || (flag && flag !== 'no-resolve'))
      throw new Error(`规则第 ${i + 1} 行不在支持范围`);
    if (third === 'no-resolve' && flag) throw new Error(`规则第 ${i + 1} 行格式无效`);
    const action = !third || third === 'no-resolve' ? defaultAction : third;
    const rule = Rule.parse({ type: types[t], value, action });
    validateRule(rule);
    result.push(rule);
    if (result.length > 10000) throw new Error('规则数量超过 10000');
  }
  if (!result.length) throw new Error('规则集没有有效条目');
  return result;
}

export function validateRule(rule: RuleType): void {
  if (/[\r\n,]/.test(rule.value) || /[\r\n,]/.test(rule.action))
    throw new Error('规则不能包含逗号或换行');
  if (rule.type === 'ip-cidr') {
    const parts = rule.value.split('/');
    const [ip, mask] = parts;
    const family = isIP(ip || '');
    if (
      !family ||
      parts.length !== 2 ||
      mask === undefined ||
      !/^\d+$/.test(mask) ||
      Number(mask) > (family === 4 ? 32 : 128)
    )
      throw new Error('IP CIDR 无效');
  }
}
