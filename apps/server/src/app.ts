import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Target, ShareInput } from '../../../packages/contracts/src/index.js';
import { Store } from './store.js';
import { Service, HttpError, type Kind } from './service.js';
import { verifyPassword, type Settings } from './settings.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export async function buildApp(
  settings: Settings,
  options: { scheduler?: boolean; logger?: boolean } = {},
) {
  const app = Fastify({
    logger: options.logger ? { redact: ['req.headers', 'res.headers', 'req.url'] } : false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: settings.trustProxy,
    bodyLimit: 11 * 1024 * 1024,
  });
  const store = new Store(settings.dataDir, settings.secret);
  const service = new Service(store, settings);
  let restoring = false;
  const sessions = new Map<string, { csrf: string; expires: number }>();
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: '请求过于频繁，请稍后重试' }),
  });
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    );
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (restoring && !['GET', 'HEAD'].includes(req.method))
      throw new HttpError(503, '正在恢复备份，请稍后重试');
    const session = req.cookies.sid ? sessions.get(sha(req.cookies.sid)) : undefined;
    if (req.url.split('?')[0] === '/api/auth/login') {
      if (req.headers.origin !== settings.publicUrl) throw new HttpError(403, '请求来源不受信任');
      return;
    }
    if (!session || session.expires <= Date.now()) {
      if (req.cookies.sid) sessions.delete(sha(req.cookies.sid));
      throw new HttpError(401, '请先登录');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== settings.publicUrl) throw new HttpError(403, '请求来源不受信任');
      const csrf = req.headers['x-csrf-token'];
      if (
        typeof csrf !== 'string' ||
        Buffer.byteLength(csrf) !== Buffer.byteLength(session.csrf) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))
      )
        throw new HttpError(403, 'CSRF 校验失败');
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: '输入无效',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    const code = (error as { statusCode?: number }).statusCode;
    if (code && code >= 400 && code < 500)
      return reply.code(code).send({ error: error instanceof Error ? error.message : '请求无效' });
    if (error instanceof HttpError)
      return reply.code(error.statusCode).send({ error: error.message });
    return reply.code(500).send({ error: '操作失败，请检查后台任务状态或输入配置' });
  });
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const { username, password } = z
        .object({ username: z.string().max(120), password: z.string().max(1024) })
        .parse(req.body);
      const validPassword = verifyPassword(password, settings.passwordHash);
      if (username !== settings.username || !validPassword)
        throw new HttpError(401, '用户名或密码错误');
      for (const [id, s] of sessions) if (s.expires <= Date.now()) sessions.delete(id);
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
      const sid = randomBytes(32).toString('base64url'),
        csrf = randomBytes(24).toString('hex');
      if (req.cookies.sid) sessions.delete(sha(req.cookies.sid));
      sessions.set(sha(sid), { csrf, expires: Date.now() + 8 * 3600000 });
      reply.setCookie('sid', sid, {
        httpOnly: true,
        secure: settings.publicUrl.startsWith('https:'),
        sameSite: 'strict',
        path: '/',
        maxAge: 8 * 3600,
      });
      return { username: settings.username, csrf };
    },
  );
  app.get('/api/auth/me', async (req) => ({
    username: settings.username,
    csrf: sessions.get(sha(req.cookies.sid!))!.csrf,
  }));
  app.post('/api/auth/logout', async (req, reply) => {
    sessions.delete(sha(req.cookies.sid!));
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });
  const routes: [string, Kind][] = [
    ['sources', 'source'],
    ['configs', 'config'],
    ['rule-packs', 'rule-pack'],
    ['scripts', 'script'],
  ];
  for (const [route, kind] of routes) {
    app.get(`/api/${route}`, async () => service.list(kind));
    app.get<{ Params: { id: string } }>(`/api/${route}/:id`, async (req) =>
      service.get(kind, req.params.id),
    );
    app.post(`/api/${route}`, async (req, reply) => {
      try {
        return reply.code(201).send(service.save(kind, req.body));
      } catch (e) {
        if (e instanceof z.ZodError || e instanceof HttpError) throw e;
        throw new HttpError(400, e instanceof Error ? e.message : '配置无效');
      }
    });
    app.put<{ Params: { id: string } }>(`/api/${route}/:id`, async (req) => {
      const revision = Number(req.headers['if-match']);
      if (!Number.isInteger(revision) || revision < 1)
        throw new HttpError(428, '保存时必须提供 If-Match 版本');
      try {
        return service.save(kind, req.body, req.params.id, revision);
      } catch (e) {
        if (e instanceof z.ZodError || (e as any).statusCode) throw e;
        throw new HttpError(400, e instanceof Error ? e.message : '配置无效');
      }
    });
    app.delete<{ Params: { id: string } }>(`/api/${route}/:id`, async (req) => {
      service.delete(kind, req.params.id);
      return { ok: true };
    });
  }
  for (const [route, kind] of [
    ['sources', 'source'],
    ['rule-packs', 'rule-pack'],
  ] as const)
    app.post<{ Params: { id: string } }>(`/api/${route}/:id/refresh`, async (req, reply) =>
      reply.code(202).send(service.refresh(kind, req.params.id)),
    );
  for (const operation of ['preview', 'publish'] as const)
    app.post<{ Params: { id: string; target: string } }>(
      `/api/configs/:id/outputs/:target/${operation}`,
      async (req) => {
        const target = Target.parse(req.params.target),
          mode = z
            .object({ mode: z.enum(['full', 'nodes']).default('full') })
            .parse(req.body || {}).mode;
        try {
          return await service[operation](req.params.id, target, mode);
        } catch (e) {
          if ((e as any).statusCode) throw e;
          throw new HttpError(400, e instanceof Error ? e.message : '生成失败');
        }
      },
    );
  app.get('/api/shares', async () => service.shares());
  app.post('/api/shares', async (req, reply) => {
    try {
      return reply.code(201).send(await service.createShare(ShareInput.parse(req.body)));
    } catch (e) {
      if (e instanceof z.ZodError || (e as any).statusCode) throw e;
      throw new HttpError(400, e instanceof Error ? e.message : '无法生成链接');
    }
  });
  app.post<{ Params: { id: string } }>('/api/shares/:id/revoke', async (req) => {
    service.revoke(req.params.id);
    return { ok: true };
  });
  app.get('/api/jobs', async () =>
    store.list<any>('job').sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  );
  app.get('/api/artifacts', async () =>
    store.list<any>('artifact').map(({ body, ...rest }) => rest),
  );
  app.get('/api/backup', async (_req, reply) =>
    reply
      .header('Content-Disposition', 'attachment; filename="subharbor-backup.json"')
      .send(store.exportBackup()),
  );
  app.post('/api/backup/restore', { bodyLimit: 64 * 1024 * 1024 }, async (req) => {
    restoring = true;
    await service.stop();
    try {
      store.restoreBackup(req.body);
      sessions.clear();
      return { ok: true };
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : '恢复失败');
    } finally {
      restoring = false;
      if (options.scheduler !== false) service.start();
    }
  });
  app.get('/api/rule-catalog', async () => [
    {
      name: 'ACL4SSR 局域网',
      url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/LocalAreaNetwork.list',
      format: 'ACL list',
      license: 'CC-BY-SA-4.0',
    },
    {
      name: 'ACL4SSR 精简代理',
      url: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/ProxyLite.list',
      format: 'ACL list',
      license: 'CC-BY-SA-4.0',
    },
    {
      name: 'blackmatrix7 规则目录',
      url: 'https://github.com/blackmatrix7/ios_rule_script/tree/master/rule',
      format: '请选择 list 格式资源',
      license: 'GPL-2.0 / 另有声明',
    },
    {
      name: 'MetaCubeX 原生规则',
      url: 'https://github.com/MetaCubeX/meta-rules-dat',
      format: '目标原生资源（后续适配）',
      license: 'GPL-3.0',
    },
  ]);
  app.route<{ Params: { token: string; file: string } }>({
    method: ['GET', 'HEAD'],
    url: '/sub/:token/:file',
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
        keyGenerator: (req) => sha((req.params as any).token || req.ip),
      },
    },
    handler: async (req, reply) => {
      const artifact = service.pull(req.params.token, req.params.file);
      reply
        .header('Cache-Control', 'private, no-cache')
        .header('ETag', artifact.etag)
        .header('profile-update-interval', '6');
      reply.type(
        artifact.target === 'sing-box'
          ? 'application/json; charset=utf-8'
          : 'application/yaml; charset=utf-8',
      );
      if (req.headers['if-none-match'] === artifact.etag) return reply.code(304).send();
      if (req.method === 'HEAD')
        return reply.header('Content-Length', Buffer.byteLength(artifact.body)).send();
      return reply.send(artifact.body);
    },
  });
  app.get('/health/live', async () => ({ ok: true }));
  app.get('/health/ready', async () => {
    store.sqlite.prepare('SELECT 1').get();
    return { ok: true };
  });
  const web = resolve('dist/web');
  if (existsSync(web)) {
    await app.register(staticFiles, { root: web });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || req.url.startsWith('/sub/')
        ? reply.code(404).send({ error: '不存在' })
        : reply.sendFile('index.html'),
    );
  }
  if (options.scheduler !== false) service.start();
  app.addHook('onClose', async () => {
    await service.stop();
    store.close();
  });
  return { app, store, service };
}
