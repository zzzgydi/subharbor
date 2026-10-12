import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import React from 'react';
import { ConfigInput } from '../packages/contracts/src/index.js';

// A simulated DOM validates state and payloads, not browser layout or visual appearance.
const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { value: dom.navigator, configurable: true });
const { render, screen, fireEvent, waitFor, within, cleanup } =
  await import('@testing-library/react');
const cache = mkdtempSync(join(tmpdir(), 'subharbor-ui-test-'));
const require = createRequire(import.meta.url);
const outfile = join(cache, 'app.mjs');
await build({
  entryPoints: ['apps/web/src/main.tsx'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'shared-react',
      setup(builder) {
        builder.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, (args) => ({
          path: require.resolve(args.path),
          external: true,
        }));
      },
    },
  ],
});
const { App } = await import(pathToFileURL(outfile).href);
let records: Record<string, unknown[]> & { configs: unknown[] };
let saved: Record<string, any> | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  saved = undefined;
  const entity = (name: string, id: string) => ({
    ...ConfigInput.parse({ name, sourceIds: ['source-1'] }),
    id,
    revision: 1,
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T00:00:00Z',
  });
  records = {
    configs: [entity('Alpha', 'config-a'), entity('Beta', 'config-b')],
    sources: [{ id: 'source-1', name: 'Synthetic source', nodeCount: 2, enabled: true }],
    'rule-packs': [],
    scripts: [],
    shares: [],
    jobs: [
      {
        id: 'job-1',
        kind: 'publish',
        resourceId: 'config-a:mihomo:full',
        status: 'succeeded',
        startedAt: '2026-10-10T00:00:00Z',
      },
    ],
  };
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace('/api/', '');
    if (path === 'auth/me')
      return Response.json({ username: 'synthetic-admin', csrf: 'synthetic-csrf' });
    if (init?.method === 'PUT' && path === 'configs/config-a') {
      saved = JSON.parse(String(init.body));
      records.configs[0] = { ...saved, id: 'config-a', revision: 2 };
      return Response.json(records.configs[0]);
    }
    assert.equal(init?.method || 'GET', 'GET', 'Only expected mock API requests are allowed');
    assert(path in records, 'Unexpected mock API route');
    return Response.json(records[path]);
  };
});
afterEach(() => cleanup());
after(() => {
  globalThis.fetch = originalFetch;
  dom.happyDOM.abort();
  rmSync(cache, { recursive: true, force: true });
});

test('list search filters records, clears results and resets when changing sections', async () => {
  render(React.createElement(App));
  await screen.findByText('Alpha');
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索订阅配置' }), {
    target: { value: 'beta' },
  });
  assert.equal(screen.queryByText('Alpha'), null);
  assert(screen.getByText('Beta'));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } });
  assert(screen.getByText('没有匹配记录'));
  fireEvent.click(screen.getByRole('button', { name: '清除' }));
  assert(screen.getByText('Alpha'));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Beta' } });
  fireEvent.click(screen.getByRole('button', { name: /节点来源/ }));
  assert(screen.getByText('Synthetic source'));
  assert.equal((screen.getByRole('searchbox') as HTMLInputElement).value, '');
  fireEvent.click(screen.getByRole('button', { name: '更新记录' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '配置生成' } });
  assert(screen.getByText('配置生成'));
  assert(screen.getByText('Alpha · mihomo · 完整配置'));
});

test('configuration tab switching retains edits and submits rules, DNS and selected sources together', async () => {
  render(React.createElement(App));
  await screen.findByText('Alpha');
  fireEvent.click(
    within(screen.getByRole('row', { name: /Alpha/ })).getByRole('button', { name: '编辑' }),
  );
  await screen.findByRole('tab', { name: '规则' });
  assert.equal(screen.queryByRole('searchbox'), null);
  fireEvent.click(screen.getByRole('tab', { name: '规则' }));
  fireEvent.click(screen.getByRole('button', { name: '添加规则' }));
  fireEvent.change(screen.getByRole('textbox', { name: '规则内容' }), {
    target: { value: 'office.example' },
  });
  const ruleTab = screen.getByRole('tab', { name: '规则' });
  ruleTab.focus();
  fireEvent.keyDown(ruleTab, { key: 'ArrowRight' });
  assert.equal(screen.getByRole('tab', { name: '路由' }).getAttribute('aria-selected'), 'true');
  fireEvent.change(screen.getByRole('textbox', { name: /DNS 服务器/ }), {
    target: { value: '9.9.9.9, 223.5.5.5' },
  });
  fireEvent.click(screen.getByRole('tab', { name: '节点' }));
  assert.equal(
    (screen.getByRole('checkbox', { name: 'Synthetic source' }) as HTMLInputElement).checked,
    true,
  );
  fireEvent.click(screen.getByRole('tab', { name: '规则' }));
  assert.equal(
    (screen.getByRole('textbox', { name: '规则内容' }) as HTMLInputElement).value,
    'office.example',
  );
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => assert(saved));
  assert.deepEqual(saved!.sourceIds, ['source-1']);
  assert.deepEqual(saved!.dnsServers, ['9.9.9.9', '223.5.5.5']);
  assert.deepEqual(saved!.customRules, [
    { type: 'domain-suffix', value: 'office.example', action: 'DIRECT' },
  ]);
});
