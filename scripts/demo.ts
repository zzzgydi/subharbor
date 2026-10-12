import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../apps/server/src/app.js';
import { hashPassword } from '../apps/server/src/settings.js';

const port = Number(process.env.DEMO_PORT || 31457);
const { app, service } = await buildApp(
  {
    username: 'preview',
    passwordHash: hashPassword('synthetic-preview-only'),
    secret: randomBytes(32),
    publicUrl: `http://localhost:${port}`,
    dataDir: mkdtempSync(join(tmpdir(), 'subharbor-demo-')),
    port,
    trustProxy: false,
    allowHttp: false,
  },
  { scheduler: false },
);
const source = service.save('source', {
  name: '示例节点（不可连接）',
  kind: 'manual',
  content: readFileSync('fixtures/nodes.txt', 'utf8'),
});
for (const [name, customRules] of [
  ['日常使用', []],
  ['独立规则示例', [{ type: 'domain-suffix', value: 'office.example', action: 'DIRECT' }]],
] as const) {
  const config = service.save('config', { name, sourceIds: [source.id], customRules });
  await service.publishAll(config.id);
}
await app.listen({ host: '127.0.0.1', port });
console.log(`Synthetic demo: http://localhost:${port} — preview / synthetic-preview-only`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
