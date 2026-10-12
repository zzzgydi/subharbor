import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ConfigInput, type SubscriptionConfig } from '../packages/contracts/src/index.js';
import { parseNodes, parseRules } from '../packages/adapters/src/parse.js';
import {
  aggregate,
  compatible,
  render,
  serialize,
  validateOutput,
} from '../packages/core/src/compile.js';
import { runScript } from '../packages/script/src/index.js';
import { isPublicIP, fetchSubscription } from '../apps/server/src/fetch.js';
const config = {
  ...ConfigInput.parse({ name: '任意名称' }),
  id: 'test',
  revision: 1,
  createdAt: '',
  updatedAt: '',
} as SubscriptionConfig;
const fixture = readFileSync('fixtures/nodes.txt', 'utf8');

test('URI/Base64/native parsing preserves REALITY parameters and IPv6', () => {
  const parsed = parseNodes(fixture, 'a');
  assert.equal(parsed.nodes.length, 2);
  assert.deepEqual(parsed.diagnostics, []);
  const n = parsed.nodes[1]!;
  assert.equal(n.flow, 'xtls-rprx-vision');
  assert.equal(n.tls?.reality?.shortId, '0123456789abcdef');
  assert.deepEqual(
    parseNodes(Buffer.from(fixture).toString('base64')).nodes.map((n) => n.type),
    ['ss', 'vless'],
  );
  const ipv6 = parseNodes('trojan://synthetic@[2001:db8::1]:443#IPv6').nodes[0]!;
  assert.equal(ipv6.server, '2001:db8::1');
  for (const target of ['mihomo', 'sing-box'] as const) {
    const out = render(parsed.nodes, [], config, target, 'full');
    validateOutput(out, target, 'full');
    const roundtrip = parseNodes(serialize(out, target)).nodes;
    assert.equal(roundtrip[1]!.tls?.reality?.publicKey, n.tls?.reality?.publicKey);
    assert.equal(roundtrip[1]!.flow, n.flow);
  }
});
test('dedup uses authentication and TLS parameters, retains provenance, makes names unique', () => {
  const a = parseNodes(fixture, 'a').nodes[0]!;
  const b = { ...structuredClone(a), name: 'Another name', sourceIds: ['b'] };
  const c = { ...structuredClone(a), password: 'different-synthetic-password' };
  const nodes = aggregate([a, b, c], config, randomBytes(32));
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0]!.sourceIds, ['a', 'b']);
  assert.notEqual(nodes[0]!.name, nodes[1]!.name);
});
test('configuration names do not affect output; per-config rules do', () => {
  const nodes = parseNodes(fixture).nodes;
  const rules = parseRules('DOMAIN-SUFFIX,corp.example,DIRECT');
  const a = render(nodes, rules, config, 'mihomo', 'full');
  const b = render(nodes, rules, { ...config, name: '公司' }, 'mihomo', 'full');
  assert.deepEqual(a, b);
  assert(
    !render(nodes, [], { ...config, name: '家庭' }, 'sing-box', 'full').route.rules.some((r: any) =>
      r.domain_suffix?.includes('corp.example'),
    ),
  );
});
test('Clash legacy filters incompatible nodes and strict mode rejects them', () => {
  const nodes = parseNodes(fixture).nodes;
  assert.equal(compatible(nodes, 'clash', false).nodes.length, 1);
  assert.equal(compatible(nodes, 'clash', false).warnings.length, 1);
  assert.throws(() => compatible(nodes, 'clash', true));
});
test('invalid rules, missing references and strategy cycles cannot be published', () => {
  assert.throws(() => parseRules('IP-CIDR,10.0.0.0/100,DIRECT'));
  assert.throws(() => parseRules('IP-CIDR,10.0.0.0/16/24,DIRECT'));
  const out = render(parseNodes(fixture).nodes, [], config, 'mihomo', 'full');
  out.rules.unshift('DOMAIN,corp.example,MISSING');
  assert.throws(() => validateOutput(out, 'mihomo', 'full'));
  out.rules.shift();
  out['proxy-groups'][0].proxies = ['PROXY'];
  assert.throws(() => validateOutput(out, 'mihomo', 'full'));
});
test('QuickJS performs transforms but cannot access Node/IO/environment; async and resource exhaustion fail', async () => {
  const out = await runScript(
    'function transform(input) { input.name="changed"; input.nodeAPI=typeof process; input.fileAPI=typeof require; input.networkAPI=typeof fetch; return input; }',
    { name: 'before' },
    {},
  );
  assert.deepEqual(out, {
    name: 'changed',
    nodeAPI: 'undefined',
    fileAPI: 'undefined',
    networkAPI: 'undefined',
  });
  await assert.rejects(runScript('function transform() { while(true) {} }', {}, {}));
  await assert.rejects(runScript('function transform() { return Promise.resolve({}); }', {}, {}));
  await assert.rejects(
    runScript(
      'function transform() { const values=[]; while(true) values.push(new Array(10000).fill("x")); }',
      {},
      {},
    ),
  );
  assert.deepEqual(await runScript('function transform(v) { return v; }', { alive: true }, {}), {
    alive: true,
  });
});
test('public fetch excludes localhost, private, link-local and mapped IPv6 addresses', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(isPublicIP(address), false, address);
  assert.equal(isPublicIP('1.1.1.1'), true);
  await assert.rejects(fetchSubscription('https://127.0.0.1/private'));
  await assert.rejects(fetchSubscription('file:///etc/passwd'));
});

test('modern protocols and VMess/HTTP/SOCKS input render in both modern targets', () => {
  const vmess = Buffer.from(
    JSON.stringify({
      v: '2',
      ps: 'VMess',
      add: 'vmess.example',
      port: '443',
      id: '11111111-1111-4111-8111-111111111111',
      aid: '0',
      scy: 'auto',
      net: 'ws',
      path: '/ws',
      host: 'edge.example',
      tls: 'tls',
      sni: 'edge.example',
    }),
  ).toString('base64');
  const content = [
    'vmess://' + vmess,
    'hysteria2://synthetic@hy2.example:443?sni=hy2.example&obfs=salamander&obfs-password=synthetic#HY2',
    'tuic://11111111-1111-4111-8111-111111111111:synthetic@tuic.example:443?sni=tuic.example&alpn=h3#TUIC',
    'https://synthetic:synthetic@http.example:8443#HTTP',
    'socks5://synthetic:synthetic@socks.example:1080#SOCKS',
  ].join('\n');
  const nodes = parseNodes(content).nodes;
  assert.equal(nodes.length, 5);
  for (const target of ['mihomo', 'sing-box'] as const) {
    const output = render(nodes, [], config, target, 'full');
    validateOutput(output, target, 'full');
    const parsed = parseNodes(serialize(output, target)).nodes;
    assert.equal(parsed.length, 5);
    assert.equal(parsed.find((n) => n.type === 'hysteria2')?.obfs?.password, 'synthetic');
    assert.equal(parsed.find((n) => n.type === 'vmess')?.transport?.path, '/ws');
  }
});

test('unsupported extensions are diagnosed and script-injected legacy nodes are rejected', () => {
  const good = parseNodes(fixture).nodes[0]!;
  const out = render([good], [], config, 'clash', 'full');
  const modern = render(parseNodes(fixture).nodes, [], config, 'mihomo', 'nodes');
  out.proxies.push(modern.proxies[1]);
  assert.throws(() => validateOutput(out, 'clash', 'full'));
  const native = render([good], [], config, 'mihomo', 'nodes');
  native.proxies.push({ ...native.proxies[0], name: 'unsupported', 'tcp-fast-open': true });
  const parsed = parseNodes(JSON.stringify(native));
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.diagnostics.length, 1);
  const ipv6 = render(
    [good],
    parseRules('IP-CIDR6,2001:db8::/32,DIRECT'),
    config,
    'mihomo',
    'full',
  );
  assert.equal(ipv6.rules[0], 'IP-CIDR6,2001:db8::/32,DIRECT,no-resolve');
});

test('ACL list syntax supports policy-free entries and no-resolve without losing explicit actions', () => {
  const rules = parseRules(
    'DOMAIN-SUFFIX,local\nIP-CIDR,192.168.0.0/16,no-resolve\nDOMAIN,corp.example,PROXY',
    'DIRECT',
  );
  assert.deepEqual(
    rules.map((r) => r.action),
    ['DIRECT', 'DIRECT', 'PROXY'],
  );
  assert.throws(() => parseRules('IP-ASN,20473,no-resolve'));
});
