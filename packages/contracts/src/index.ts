import { z } from 'zod';

export const Target = z.enum(['mihomo', 'clash', 'sing-box']);
export type Target = z.infer<typeof Target>;
export const Rule = z
  .object({
    type: z.enum(['domain', 'domain-suffix', 'domain-keyword', 'ip-cidr']),
    value: z.string().trim().min(1).max(1024),
    action: z.string().trim().min(1).max(128).default('DIRECT'),
  })
  .strict();
export type Rule = z.infer<typeof Rule>;
export const Schedule = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('manual') }),
  z.object({ mode: z.literal('interval'), minutes: z.number().int().min(5).max(43200) }),
  z.object({
    mode: z.literal('cron'),
    expression: z.string().min(1).max(100),
    timezone: z.string().min(1).max(80).default('UTC'),
  }),
]);
export const SourceInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(['subscription', 'manual']),
    url: z.string().max(4096).default(''),
    content: z
      .string()
      .max(10 * 1024 * 1024)
      .default(''),
    headers: z.record(z.string(), z.string().max(8192)).default({}),
    enabled: z.boolean().default(true),
    schedule: Schedule.default({ mode: 'interval', minutes: 360 }),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.kind === 'subscription' && !URL.canParse(s.url))
      ctx.addIssue({ code: 'custom', message: '订阅 URL 无效', path: ['url'] });
    if (s.kind === 'manual' && !s.content.trim())
      ctx.addIssue({ code: 'custom', message: '请填写节点内容', path: ['content'] });
  });
export type SourceInput = z.infer<typeof SourceInput>;
export const RulePackInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    url: z.string().max(4096).default(''),
    content: z
      .string()
      .max(10 * 1024 * 1024)
      .default(''),
    defaultAction: z.string().trim().min(1).max(128).default('PROXY'),
    schedule: Schedule.default({ mode: 'interval', minutes: 1440 }),
  })
  .strict();
export type RulePackInput = z.infer<typeof RulePackInput>;
const Group = z
  .object({ name: z.string().trim().min(1).max(80), filter: z.string().max(120).default('') })
  .strict();
export const ConfigInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    sourceIds: z.array(z.string()).max(100).default([]),
    extraNodes: z
      .string()
      .max(1024 * 1024)
      .default(''),
    rulePackIds: z.array(z.string()).max(100).default([]),
    customRules: z.array(Rule).max(10000).default([]),
    groups: z.array(Group).max(100).default([]),
    include: z.string().max(120).default(''),
    exclude: z.string().max(120).default(''),
    prefix: z.string().max(80).default(''),
    deduplicate: z.boolean().default(true),
    sort: z.boolean().default(false),
    strict: z.boolean().default(false),
    dnsServers: z.array(z.string().min(1).max(100)).min(1).max(8).default(['1.1.1.1', '223.5.5.5']),
    finalAction: z.string().min(1).max(80).default('PROXY'),
    scriptIds: z.array(z.string()).max(10).default([]),
    scriptParams: z.record(z.string(), z.unknown()).default({}),
    maxStaleHours: z.number().int().min(1).max(8760).default(168),
  })
  .strict();
export type ConfigInput = z.infer<typeof ConfigInput>;
export const ScriptInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    stage: z.enum(['nodes', 'config']),
    targets: z.array(Target).min(1),
    code: z
      .string()
      .min(1)
      .max(256 * 1024),
  })
  .strict();
export type ScriptInput = z.infer<typeof ScriptInput>;
export const ShareInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    configId: z.string(),
    target: Target,
    mode: z.enum(['full', 'nodes']).default('full'),
    expiresAt: z.string().datetime().nullable().default(null),
    pinned: z.boolean().default(false),
  })
  .strict();
export type ShareInput = z.infer<typeof ShareInput>;
export type Entity<T> = T & { id: string; revision: number; createdAt: string; updatedAt: string };
export type Source = Entity<SourceInput> & {
  snapshot?: Node[];
  diagnostics?: string[];
  fetchedAt?: string;
  nextRunAt?: string;
  error?: string;
  failures?: number;
  etag?: string;
  lastModified?: string;
};
export type RulePack = Entity<RulePackInput> & {
  snapshotContent?: string;
  rules?: Rule[];
  fetchedAt?: string;
  nextRunAt?: string;
  error?: string;
  failures?: number;
  etag?: string;
  lastModified?: string;
};
export type SubscriptionConfig = Entity<ConfigInput>;
export type Script = Entity<ScriptInput>;
export type Share = Entity<ShareInput> & {
  digest: string;
  revokedAt?: string;
  artifactId?: string;
  lastUsedAt?: string;
};
export type Job = {
  id: string;
  resourceId: string;
  kind: 'source' | 'rule-pack' | 'publish';
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
};
export type Artifact = {
  id: string;
  configId: string;
  target: Target;
  mode: 'full' | 'nodes';
  body: string;
  etag: string;
  generatedAt: string;
  expiresAt: string;
  warnings: string[];
  active: boolean;
};
export const NodeSchema = z
  .object({
    name: z.string().min(1).max(200),
    type: z.enum(['ss', 'vmess', 'vless', 'trojan', 'http', 'socks5', 'hysteria2', 'tuic']),
    server: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    password: z.string().optional(),
    username: z.string().optional(),
    uuid: z.string().optional(),
    cipher: z.string().optional(),
    alterId: z.number().optional(),
    tls: z
      .object({
        enabled: z.boolean(),
        serverName: z.string().optional(),
        insecure: z.boolean().optional(),
        fingerprint: z.string().optional(),
        alpn: z.array(z.string()).optional(),
        reality: z.object({ publicKey: z.string(), shortId: z.string() }).optional(),
      })
      .optional(),
    transport: z
      .object({
        type: z.enum(['ws', 'grpc']),
        path: z.string().optional(),
        host: z.string().optional(),
        serviceName: z.string().optional(),
      })
      .optional(),
    flow: z.string().optional(),
    obfs: z.object({ type: z.literal('salamander'), password: z.string() }).optional(),
    congestionControl: z.string().optional(),
    udpRelayMode: z.string().optional(),
    sourceIds: z.array(z.string()).default([]),
  })
  .strict();
export type Node = z.infer<typeof NodeSchema>;
