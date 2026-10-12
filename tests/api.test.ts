import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as yamlParse } from 'yaml';
import { buildApp } from '../apps/server/src/app.js';
import { hashPassword } from '../apps/server/src/settings.js';
import { Store } from '../apps/server/src/store.js';
import { ConfigInput, SourceInput } from '../packages/contracts/src/index.js';
const fixture = readFileSync('fixtures/nodes.txt', 'utf8');

test('login, independent configs, rename, optimistic concurrency, links, revoke-before-304, source disable', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'subharbor-api-'));
  const secret = randomBytes(32);
  const settings = {
    username: 'admin',
    passwordHash: hashPassword('synthetic-test-password'),
    secret,
    publicUrl: 'http://localhost:3000',
    dataDir,
    port: 3000,
    trustProxy: false as const,
    allowHttp: false,
  };
  const { app, service } = await buildApp(settings, { scheduler: false });
  try {
    assert.equal((await app.inject({ url: '/api/configs' })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'synthetic-test-password' },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: settings.publicUrl },
      payload: { username: 'admin', password: 'synthetic-test-password' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const sid = login.cookies[0]!,
      csrf = login.json().csrf;
    const headers = {
      cookie: `sid=${sid.value}`,
      origin: settings.publicUrl,
      'x-csrf-token': csrf,
    };
    const request = (method: any, url: string, payload?: any, revision?: number) =>
      app.inject({
        method,
        url,
        headers: { ...headers, ...(revision ? { 'if-match': String(revision) } : {}) },
        payload,
      });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/configs',
          headers: { cookie: headers.cookie, origin: settings.publicUrl },
          payload: { name: 'x' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/configs',
          headers: { ...headers, 'x-csrf-token': 'é'.repeat(csrf.length) },
          payload: { name: 'x' },
        })
      ).statusCode,
      403,
    );
    const source = (
      await request(
        'POST',
        '/api/sources',
        SourceInput.parse({ name: 'Synthetic', kind: 'manual', content: fixture }),
      )
    ).json();
    assert.equal(source.nodeCount, 2);
    const cfgA = ConfigInput.parse({
      name: '任意 A',
      sourceIds: [source.id],
      customRules: [{ type: 'domain-suffix', value: 'corp.example', action: 'DIRECT' }],
    });
    const cfgB = ConfigInput.parse({ name: '任意 B', sourceIds: [source.id] });
    const a = (await request('POST', '/api/configs', cfgA)).json(),
      b = (await request('POST', '/api/configs', cfgB)).json();
    const linkA = (
      await request('POST', '/api/shares', { name: 'A', configId: a.id, target: 'mihomo' })
    ).json();
    const linkBResponse = await request('POST', '/api/shares', {
      name: 'B',
      configId: b.id,
      target: 'mihomo',
    });
    assert.equal(linkBResponse.statusCode, 201, linkBResponse.body);
    const linkB = linkBResponse.json();
    const urlA = new URL(linkA.url).pathname,
      urlB = new URL(linkB.url).pathname;
    const outputA = await app.inject({ url: urlA }),
      outputB = await app.inject({ url: urlB });
    assert.equal(outputA.statusCode, 200, outputA.body);
    assert.equal(outputB.statusCode, 200, outputB.body);
    assert(yamlParse(outputA.body).rules.some((s: string) => s.includes('corp.example')));
    assert(!yamlParse(outputB.body).rules.some((s: string) => s.includes('corp.example')));
    assert.equal(
      (await app.inject({ url: urlA.replace('mihomo.yaml', 'sing-box.json') })).statusCode,
      404,
    );
    const renamed = await request(
      'PUT',
      `/api/configs/${a.id}`,
      { ...cfgA, name: '家庭' },
      a.revision,
    );
    assert.equal(renamed.statusCode, 200, renamed.body);
    const afterRename = await app.inject({ url: urlA });
    assert.equal(afterRename.statusCode, 200);
    assert.equal(afterRename.body, outputA.body);
    assert.equal((await request('PUT', `/api/configs/${a.id}`, cfgA, a.revision)).statusCode, 409);
    assert.equal(
      (
        await app.inject({
          url: urlA,
          headers: { 'if-none-match': outputA.headers.etag as string },
        })
      ).statusCode,
      304,
    );
    const head = await app.inject({ method: 'HEAD', url: urlA });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    await request('POST', `/api/shares/${linkA.id}/revoke`, {});
    assert.equal(
      (
        await app.inject({
          url: urlA,
          headers: { 'if-none-match': outputA.headers.etag as string },
        })
      ).statusCode,
      404,
    );
    assert.equal((await app.inject({ url: urlB })).statusCode, 200);
    const rawSource = (await request('GET', `/api/sources/${source.id}`)).json();
    await request(
      'PUT',
      `/api/sources/${source.id}`,
      SourceInput.parse({
        enabled: false,
        name: rawSource.name,
        kind: rawSource.kind,
        content: rawSource.content,
        url: rawSource.url,
        headers: rawSource.headers,
        schedule: rawSource.schedule,
      }),
      source.revision,
    );
    assert.equal((await app.inject({ url: urlB })).statusCode, 404);
    await service.stop();
    const raw = readFileSync(join(dataDir, 'subharbor.sqlite'));
    assert(!raw.includes(Buffer.from('synthetic-pass')));
    assert(!raw.includes(Buffer.from(new URL(linkB.url).pathname.split('/')[2]!)));
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
test('failed postprocessing preserves last published version and restart preserves grants', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'subharbor-state-')),
    secret = randomBytes(32);
  const settings = {
    username: 'admin',
    passwordHash: hashPassword('synthetic-test-password'),
    secret,
    publicUrl: 'http://localhost:3000',
    dataDir,
    port: 3000,
    trustProxy: false as const,
    allowHttp: false,
  };
  let result = await buildApp(settings, { scheduler: false });
  try {
    const source = result.service.save(
      'source',
      SourceInput.parse({ name: 's', kind: 'manual', content: fixture }),
    );
    const config = result.service.save(
      'config',
      ConfigInput.parse({ name: 'c', sourceIds: [source.id] }),
    );
    await result.service.publishAll(config.id);
    const share = await result.service.createShare({
      name: 'test',
      configId: config.id,
      target: 'sing-box',
      mode: 'full',
      expiresAt: null,
      pinned: false,
    });
    const token = new URL(share.url).pathname.split('/')[2]!;
    const before = result.service.pull(token, 'sing-box.json').body;
    // Simulate an upstream refresh error: successful snapshot and artifacts remain intact.
    const snapshot = result.store.get<any>('source', source.id)!;
    result.store.save('source', { ...snapshot, error: 'upstream failed' });
    assert.equal(result.service.pull(token, 'sing-box.json').body, before);
    await result.app.close();
    result = await buildApp(settings, { scheduler: false });
    assert.equal(result.service.pull(token, 'sing-box.json').body, before);
    const script = result.service.save('script', {
      name: 'invalid',
      stage: 'config',
      targets: ['sing-box'],
      code: 'function transform(v) { v.route.final="MISSING"; return v; }',
    });
    const changed = result.service.save(
      'config',
      ConfigInput.parse({
        scriptIds: [script.id],
        name: config.name,
        sourceIds: config.sourceIds,
        enabled: config.enabled,
        extraNodes: config.extraNodes,
        rulePackIds: config.rulePackIds,
        customRules: config.customRules,
        groups: config.groups,
        include: config.include,
        exclude: config.exclude,
        prefix: config.prefix,
        deduplicate: config.deduplicate,
        sort: config.sort,
        strict: config.strict,
        dnsServers: config.dnsServers,
        finalAction: config.finalAction,
        scriptParams: config.scriptParams,
        maxStaleHours: config.maxStaleHours,
      }),
      config.id,
      config.revision,
    );
    await result.service.publishAll(changed.id);
    await assert.rejects(result.service.publish(config.id, 'sing-box'));
    assert.equal(result.service.pull(token, 'sing-box.json').body, before);
  } finally {
    await result.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('encrypted backup restores records atomically, rejects wrong key and invalid backup', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'subharbor-backup-')),
    otherDir = mkdtempSync(join(tmpdir(), 'subharbor-other-'));
  const store = new Store(dataDir, randomBytes(32));
  const other = new Store(otherDir, randomBytes(32));
  try {
    store.save('source', {
      id: 'test-source',
      revision: 1,
      content: 'synthetic-sensitive-content',
    });
    const backup = store.exportBackup();
    assert(!JSON.stringify(backup).includes('synthetic-sensitive-content'));
    store.delete('source', 'test-source');
    assert.equal(store.get('source', 'test-source'), undefined);
    store.restoreBackup(backup);
    assert.equal(store.get<any>('source', 'test-source')!.content, 'synthetic-sensitive-content');
    assert.throws(() => other.restoreBackup(backup));
    assert.throws(() => store.restoreBackup({ format: 'invalid', rows: [] }));
    assert.equal(store.get<any>('source', 'test-source')!.content, 'synthetic-sensitive-content');
  } finally {
    store.close();
    other.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});
