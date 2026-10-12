import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { z } from 'zod';
import {
  SourceInput,
  RulePackInput,
  ConfigInput,
  ScriptInput,
  type Source,
  type RulePack,
  type SubscriptionConfig,
  type Script,
  type Share,
  type ShareInput,
  type Artifact,
  type Job,
  type Target,
  type Entity,
} from '../../../packages/contracts/src/index.js';
import { parseNodes, parseRules } from '../../../packages/adapters/src/parse.js';
import {
  aggregate,
  compatible,
  render,
  serialize,
  stableJSON,
  validateOutput,
  validateNodes,
} from '../../../packages/core/src/compile.js';
import { runScript } from '../../../packages/script/src/index.js';
import { Store, Conflict } from './store.js';
import { fetchSubscription } from './fetch.js';
import type { Settings } from './settings.js';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const now = () => new Date().toISOString();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const kinds = ['source', 'rule-pack', 'config', 'script'] as const;
export type Kind = (typeof kinds)[number];
function scope(config: SubscriptionConfig) {
  return stableJSON({
    enabled: config.enabled,
    sourceIds: [...config.sourceIds].sort(),
    extraNodes: config.extraNodes,
    include: config.include,
    exclude: config.exclude,
    maxStaleHours: config.maxStaleHours,
  });
}
function comparable(config: SubscriptionConfig) {
  const { name, updatedAt, revision, ...rest } = config;
  return stableJSON(rest);
}
function nextRun(
  schedule: z.infer<typeof SourceInput>['schedule'],
  failures = 0,
): string | undefined {
  if (schedule.mode === 'manual') return undefined;
  if (failures)
    return new Date(
      Date.now() + Math.min(360, 5 * 2 ** Math.min(failures - 1, 7)) * 60000,
    ).toISOString();
  if (schedule.mode === 'cron') {
    const cron = CronExpressionParser.parse(schedule.expression, { tz: schedule.timezone });
    const next = cron.next();
    if (cron.next().getTime() - next.getTime() < 300000)
      throw new Error('自动更新间隔不能短于 5 分钟');
    return next.toISOString()!;
  }
  return new Date(
    Date.now() + schedule.minutes * 60000 + Math.floor(Math.random() * 30000),
  ).toISOString();
}

export class Service {
  private running = new Map<string, Promise<void>>();
  private publishing = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  constructor(
    readonly store: Store,
    readonly settings: Settings,
  ) {}
  start() {
    for (const job of this.store.list<Job>('job').filter((j) => j.status === 'running'))
      this.store.save('job', {
        ...job,
        status: 'failed',
        error: '进程重启中断了任务，请重试',
        finishedAt: now(),
      });
    this.timer = setInterval(() => void this.tick(), 30000);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    clearInterval(this.timer);
    while (this.running.size || this.publishing.size)
      await Promise.allSettled([...this.running.values(), ...this.publishing.values()]);
  }
  list(kind: Kind): any[] {
    if (kind === 'source')
      return this.store
        .list<Source>('source')
        .map(({ content, url, headers, snapshot, ...safe }) => ({
          ...safe,
          nodeCount: snapshot?.length || 0,
          hasUrl: !!url,
        }));
    return this.store.list(kind);
  }
  get<T>(kind: string, id: string): T {
    const value = this.store.get<T>(kind, id);
    if (!value) throw new HttpError(404, '记录不存在');
    return value;
  }
  save(kind: Kind, body: unknown, id?: string, expected?: number): any {
    const schema = {
      source: SourceInput,
      'rule-pack': RulePackInput,
      config: ConfigInput,
      script: ScriptInput,
    }[kind];
    const value = schema.parse(body);
    const previous = id ? this.get<any>(kind, id) : undefined;
    if (previous && expected !== previous.revision) throw new Conflict();
    if ('schedule' in value) {
      try {
        nextRun(value.schedule);
      } catch {
        throw new HttpError(400, '定时表达式或时区无效');
      }
    }
    if (kind === 'config') {
      const cfg = value as z.infer<typeof ConfigInput>;
      for (const ref of cfg.sourceIds) this.get('source', ref);
      for (const ref of cfg.rulePackIds) this.get('rule-pack', ref);
      for (const ref of cfg.scriptIds) this.get('script', ref);
    }
    const entity = {
      ...previous,
      ...value,
      id: id || randomUUID(),
      revision: (previous?.revision || 0) + 1,
      createdAt: previous?.createdAt || now(),
      updatedAt: now(),
    } as any;
    if (kind === 'source') {
      const source = entity as Source;
      if (source.kind === 'manual') {
        const parsed = parseNodes(source.content, source.id);
        source.snapshot = parsed.nodes;
        source.diagnostics = parsed.diagnostics;
        source.fetchedAt = now();
        source.error = undefined;
        source.nextRunAt = undefined;
      } else {
        source.nextRunAt = nextRun(source.schedule);
        if (
          !previous ||
          previous.url !== source.url ||
          stableJSON(previous.headers) !== stableJSON(source.headers) ||
          previous.kind !== source.kind
        ) {
          source.snapshot = undefined;
          source.fetchedAt = undefined;
          source.etag = undefined;
          source.lastModified = undefined;
        }
      }
    }
    if (kind === 'rule-pack') {
      const pack = entity as RulePack;
      if (pack.url) {
        if (!URL.canParse(pack.url)) throw new HttpError(400, '规则 URL 无效');
        pack.nextRunAt = nextRun(pack.schedule);
        if (previous?.defaultAction !== pack.defaultAction && pack.snapshotContent)
          pack.rules = parseRules(pack.snapshotContent, pack.defaultAction);
        if (previous?.url !== pack.url) {
          pack.snapshotContent = undefined;
          pack.rules = undefined;
          pack.fetchedAt = undefined;
          pack.etag = undefined;
          pack.lastModified = undefined;
        }
      } else {
        pack.rules = parseRules(pack.content, pack.defaultAction);
        pack.fetchedAt = now();
        pack.error = undefined;
        pack.nextRunAt = undefined;
      }
    }
    this.store.transaction(() => {
      this.store.save(kind, entity, previous?.revision);
      if (kind === 'config') {
        if (previous && scope(previous) !== scope(entity)) this.invalidate(entity.id);
      } else if (kind === 'source') this.invalidateDependents(kind, entity.id);
    });
    if (kind === 'config') void this.publishAll(entity.id);
    else void this.rebuildDependents(kind, entity.id);
    return kind === 'source' ? this.list('source').find((s) => s.id === entity.id) : entity;
  }
  delete(kind: Kind, id: string) {
    this.get(kind, id);
    this.store.transaction(() => {
      this.store.delete(kind, id);
      if (kind === 'config') this.invalidate(id);
      else this.invalidateDependents(kind, id);
    });
  }
  private dependents(kind: Kind, id: string) {
    return this.store
      .list<SubscriptionConfig>('config')
      .filter((c) =>
        kind === 'source'
          ? c.sourceIds.includes(id)
          : kind === 'rule-pack'
            ? c.rulePackIds.includes(id)
            : kind === 'script'
              ? c.scriptIds.includes(id)
              : false,
      );
  }
  private invalidateDependents(kind: Kind, id: string) {
    for (const c of this.dependents(kind, id)) this.invalidate(c.id);
  }
  private invalidate(configId: string) {
    for (const a of this.store
      .list<Artifact>('artifact')
      .filter((a) => a.configId === configId && a.active))
      this.store.save('artifact', { ...a, active: false });
  }
  private async rebuildDependents(kind: Kind, id: string) {
    for (const c of this.dependents(kind, id)) await this.publishAll(c.id);
  }
  private job(kind: Job['kind'], resourceId: string): Job {
    const j: Job = { id: randomUUID(), kind, resourceId, status: 'running', startedAt: now() };
    this.store.save('job', j);
    const jobs = this.store.list<Job>('job').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const old of jobs.slice(200))
      if (old.status !== 'running') this.store.delete('job', old.id);
    return j;
  }
  refresh(kind: 'source' | 'rule-pack', id: string): Job {
    const key = kind + ':' + id;
    if (this.running.has(key)) throw new HttpError(409, '该来源已经在更新');
    const resource = this.get<Source | RulePack>(kind, id);
    if (kind === 'source' && !(resource as Source).enabled) throw new HttpError(400, '来源已停用');
    const job = this.job(kind, id);
    const task = this.updateResource(kind, resource, job).finally(() => this.running.delete(key));
    this.running.set(key, task);
    return job;
  }
  private async updateResource(
    kind: 'source' | 'rule-pack',
    resource: Source | RulePack,
    job: Job,
  ) {
    try {
      let response;
      if (resource.url) {
        const headers = {
          ...('headers' in resource ? resource.headers : {}),
          ...(resource.etag ? { 'If-None-Match': resource.etag } : {}),
          ...(resource.lastModified ? { 'If-Modified-Since': resource.lastModified } : {}),
        };
        response = await fetchSubscription(resource.url, headers, this.settings.allowHttp);
      } else response = { content: resource.content, notModified: false };
      const next = { ...resource };
      if (response.notModified) {
        if (!('snapshot' in resource ? resource.snapshot : (resource as RulePack).rules))
          throw new Error('首次抓取不能使用 304');
      } else if (kind === 'source') {
        const parsed = parseNodes(response.content || '', resource.id);
        (next as Source).snapshot = parsed.nodes;
        (next as Source).diagnostics = parsed.diagnostics;
      } else {
        const pack = next as RulePack;
        pack.snapshotContent = response.content || '';
        pack.rules = parseRules(pack.snapshotContent, pack.defaultAction);
      }
      next.fetchedAt = now();
      next.error = undefined;
      next.failures = 0;
      next.etag = response.etag || resource.etag;
      next.lastModified = response.lastModified || resource.lastModified;
      next.nextRunAt = resource.url ? nextRun(resource.schedule) : undefined;
      this.store.save(kind, next, resource.revision);
      this.store.save('job', { ...job, status: 'succeeded', finishedAt: now() });
      await this.rebuildDependents(kind, resource.id);
    } catch (error) {
      const current = this.store.get<Source | RulePack>(kind, resource.id);
      if (current?.revision === resource.revision)
        this.store.save(
          kind,
          {
            ...current,
            error: error instanceof Error ? error.message : '更新失败',
            failures: (current.failures || 0) + 1,
            nextRunAt: current.url
              ? nextRun(current.schedule, (current.failures || 0) + 1)
              : undefined,
          },
          current.revision,
        );
      this.store.save('job', {
        ...job,
        status: 'failed',
        error: error instanceof Error ? error.message : '更新失败',
        finishedAt: now(),
      });
    }
  }
  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const kind of ['source', 'rule-pack'] as const)
        for (const resource of this.store.list<Source | RulePack>(kind)) {
          if ('enabled' in resource && !resource.enabled) continue;
          if (
            !resource.url ||
            !resource.nextRunAt ||
            resource.nextRunAt > now() ||
            this.running.has(kind + ':' + resource.id)
          )
            continue;
          this.refresh(kind, resource.id);
          await this.running.get(kind + ':' + resource.id);
        }
    } finally {
      this.ticking = false;
    }
  }
  async preview(
    configId: string,
    target: Target,
    mode: 'full' | 'nodes' = 'full',
  ): Promise<Omit<Artifact, 'active'>> {
    const config = this.get<SubscriptionConfig>('config', configId);
    if (!config.enabled) throw new HttpError(400, '配置已停用');
    const sources = config.sourceIds.map((id) => this.get<Source>('source', id));
    if (sources.some((s) => !s.enabled || !s.snapshot?.length || !s.fetchedAt))
      throw new HttpError(400, '有来源已停用或尚未成功获取');
    const packs = config.rulePackIds.map((id) => this.get<RulePack>('rule-pack', id));
    if (packs.some((p) => !p.rules || !p.fetchedAt)) throw new HttpError(400, '规则包尚未成功获取');
    const oldest = Math.min(
      ...[...sources, ...packs].map((s) => Date.parse(s.fetchedAt!)),
      Date.now(),
    );
    if (Date.now() - oldest > config.maxStaleHours * 3600000)
      throw new HttpError(400, '依赖快照超过允许的陈旧时间');
    let nodes = aggregate(
      [
        ...sources.flatMap((s) => s.snapshot!),
        ...(config.extraNodes.trim() ? parseNodes(config.extraNodes).nodes : []),
      ],
      config,
      this.store.fingerprintKey,
    );
    const scripts = config.scriptIds
      .map((id) => this.get<Script>('script', id))
      .filter((s) => s.targets.includes(target));
    const context = { target, configId, params: config.scriptParams };
    for (const script of scripts.filter((s) => s.stage === 'nodes'))
      nodes = validateNodes(await runScript(script.code, nodes, context));
    nodes = aggregate(
      nodes,
      { ...config, include: '', exclude: '', prefix: '', sort: false, deduplicate: false },
      this.store.fingerprintKey,
    );
    const filtered = compatible(nodes, target, config.strict);
    let output = render(
      filtered.nodes,
      [...config.customRules, ...packs.flatMap((p) => p.rules!)],
      config,
      target,
      mode,
    );
    for (const script of scripts.filter((s) => s.stage === 'config'))
      output = (await runScript(script.code, output, context)) as typeof output;
    validateOutput(output, target, mode);
    const body = serialize(output, target);
    const current = this.get<SubscriptionConfig>('config', configId);
    if (
      comparable(config) !== comparable(current) ||
      sources.some((s) => {
        const c = this.store.get<Source>('source', s.id);
        return c?.revision !== s.revision || c.fetchedAt !== s.fetchedAt;
      }) ||
      packs.some((p) => {
        const c = this.store.get<RulePack>('rule-pack', p.id);
        return c?.revision !== p.revision || c.fetchedAt !== p.fetchedAt;
      }) ||
      scripts.some((s) => this.store.get<Script>('script', s.id)?.revision !== s.revision)
    )
      throw new Conflict();
    return {
      id: randomUUID(),
      configId,
      target,
      mode,
      body,
      etag: '"' + digest(body) + '"',
      generatedAt: now(),
      expiresAt: new Date(oldest + config.maxStaleHours * 3600000).toISOString(),
      warnings: [...sources.flatMap((s) => s.diagnostics || []), ...filtered.warnings],
    };
  }
  async publish(configId: string, target: Target, mode: 'full' | 'nodes' = 'full') {
    const job = this.job('publish', configId + ':' + target + ':' + mode);
    try {
      const result = await this.preview(configId, target, mode);
      this.store.transaction(() => {
        this.store.save('artifact', { ...result, active: true });
        const matching = this.store
          .list<Artifact>('artifact')
          .filter((a) => a.configId === configId && a.target === target && a.mode === mode)
          .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
        const pinned = new Set(
          this.store
            .list<Share>('share')
            .filter((s) => !s.revokedAt)
            .map((s) => s.artifactId),
        );
        for (const old of matching.slice(3))
          if (!pinned.has(old.id)) this.store.delete('artifact', old.id);
        this.store.save('job', { ...job, status: 'succeeded', finishedAt: now() });
      });
      return result;
    } catch (error) {
      this.store.save('job', {
        ...job,
        status: 'failed',
        error: error instanceof Error ? error.message : '生成失败',
        finishedAt: now(),
      });
      throw error;
    }
  }
  publishAll(configId: string): Promise<void> {
    const existing = this.publishing.get(configId);
    if (existing) return existing.then(() => this.publishAll(configId));
    const task = (async () => {
      for (const target of ['mihomo', 'clash', 'sing-box'] as const)
        for (const mode of ['full', 'nodes'] as const) {
          try {
            await this.publish(configId, target, mode);
          } catch {
            /* Each failure is recorded without replacing its last good artifact. */
          }
        }
    })().finally(() => this.publishing.delete(configId));
    this.publishing.set(configId, task);
    return task;
  }
  latest(configId: string, target: Target, mode: 'full' | 'nodes') {
    return this.store
      .list<Artifact>('artifact')
      .filter((a) => a.configId === configId && a.target === target && a.mode === mode && a.active)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  }
  async createShare(input: ShareInput) {
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
      throw new HttpError(400, '过期时间必须在未来');
    // Generate and validate before granting access; sharing does not fetch upstream.
    const artifact = await this.publish(input.configId, input.target, input.mode);
    const token = randomBytes(32).toString('base64url');
    const share: Share = {
      ...input,
      id: randomUUID(),
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
      digest: digest(token),
      artifactId: input.pinned ? artifact.id : undefined,
    };
    this.store.save('share', share);
    return {
      id: share.id,
      url: `${this.settings.publicUrl}/sub/${token}/${input.target === 'sing-box' ? 'sing-box.json' : input.target + '.yaml'}`,
    };
  }
  shares() {
    return this.store.list<Share>('share').map(({ digest, ...rest }) => rest);
  }
  revoke(id: string) {
    const s = this.get<Share>('share', id);
    this.store.save('share', { ...s, revokedAt: now(), revision: s.revision + 1 });
  }
  pull(token: string, file: string): Artifact {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(404, '订阅不存在');
    const share = this.store.list<Share>('share').find((s) => s.digest === digest(token));
    if (!share || share.revokedAt || (share.expiresAt && share.expiresAt <= now()))
      throw new HttpError(404, '订阅不存在');
    const expectedFile = share.target === 'sing-box' ? 'sing-box.json' : share.target + '.yaml';
    if (file !== expectedFile) throw new HttpError(404, '订阅不存在');
    const config = this.store.get<SubscriptionConfig>('config', share.configId);
    if (
      !config?.enabled ||
      config.sourceIds.some((id) => !this.store.get<Source>('source', id)?.enabled)
    )
      throw new HttpError(404, '订阅不存在');
    const artifact = share.artifactId
      ? this.store.get<Artifact>('artifact', share.artifactId)
      : this.latest(share.configId, share.target, share.mode);
    if (
      !artifact?.active ||
      artifact.configId !== share.configId ||
      artifact.target !== share.target ||
      artifact.mode !== share.mode ||
      artifact.expiresAt <= now()
    )
      throw new HttpError(503, '暂时没有有效配置，请联系管理员');
    this.store.save('share', { ...share, lastUsedAt: now() });
    return artifact;
  }
}
