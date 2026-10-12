import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigInput, type SubscriptionConfig } from '../packages/contracts/src/index.js';
import { parseNodes } from '../packages/adapters/src/parse.js';
import { render, serialize, compatible } from '../packages/core/src/compile.js';
const dir = process.argv[2] || '/tmp/subharbor-kernels';
mkdirSync(dir, { recursive: true });
const config = {
  ...ConfigInput.parse({
    name: 'Synthetic',
    customRules: [
      { type: 'domain-suffix', value: 'corp.example', action: 'DIRECT' },
      { type: 'ip-cidr', value: '2001:db8::/32', action: 'DIRECT' },
    ],
  }),
  id: 'test',
  revision: 1,
  createdAt: '',
  updatedAt: '',
} as SubscriptionConfig;
const vmess = Buffer.from(
  JSON.stringify({
    v: '2',
    ps: 'VMess WS',
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
const nodes = parseNodes(
  [
    readFileSync('fixtures/nodes.txt', 'utf8'),
    'vmess://' + vmess,
    'trojan://synthetic@trojan.example:443?type=grpc&serviceName=synthetic#TrojanGRPC',
    'hysteria2://synthetic@hy2.example:443?sni=hy2.example&obfs=salamander&obfs-password=synthetic#HY2',
    'tuic://11111111-1111-4111-8111-111111111111:synthetic@tuic.example:443?sni=tuic.example&alpn=h3#TUIC',
    'https://synthetic:synthetic@http.example:8443#HTTP',
    'socks5://synthetic:synthetic@socks.example:1080#SOCKS',
  ].join('\n'),
).nodes;
for (const target of ['mihomo', 'clash', 'sing-box'] as const)
  writeFileSync(
    join(dir, target + (target === 'sing-box' ? '.json' : '.yaml')),
    serialize(
      render(compatible(nodes, target, false).nodes, config.customRules, config, target, 'full'),
      target,
    ),
  );
console.log('Wrote synthetic kernel fixtures.');
