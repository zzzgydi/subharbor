import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
export type Settings = {
  username: string;
  passwordHash: string;
  secret: Buffer;
  publicUrl: string;
  dataDir: string;
  port: number;
  trustProxy: string | false;
  allowHttp: boolean;
};
function env(name: string): string {
  const file = process.env[name + '_FILE'];
  return file ? readFileSync(file, 'utf8').trim() : process.env[name] || '';
}
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [kind, salt, hex] = encoded.split(':');
    if (kind !== 'scrypt' || !salt || !hex || !/^[a-f0-9]{128}$/.test(hex)) return false;
    return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hex, 'hex'));
  } catch {
    return false;
  }
}
export function loadSettings(): Settings {
  const username = env('SUBHARBOR_ADMIN_USERNAME');
  const password = env('SUBHARBOR_ADMIN_PASSWORD');
  const digest = env('SUBHARBOR_ADMIN_PASSWORD_HASH');
  const key = env('SUBHARBOR_SECRET_KEY');
  if (!username || (!password && !digest) || (password && digest))
    throw new Error('管理员用户名和密码/密码摘要必须配置，密码方式二选一');
  if (password && password.length < 12) throw new Error('管理员密码至少 12 个字符');
  if (digest && !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(digest))
    throw new Error('密码摘要格式无效，请使用 pnpm password 生成');
  if (!/^[a-f0-9]{64}$/i.test(key))
    throw new Error('SUBHARBOR_SECRET_KEY 必须是 32 字节密钥的 64 位 hex 编码');
  const publicUrl = env('SUBHARBOR_PUBLIC_URL');
  const url = new URL(publicUrl);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('PUBLIC_URL 必须是无路径的 HTTP(S) 基址');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('公网部署必须使用 HTTPS');
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  return {
    username,
    passwordHash: digest || hashPassword(password),
    secret: Buffer.from(key, 'hex'),
    publicUrl: url.origin,
    dataDir: resolve(env('SUBHARBOR_DATA_DIR') || 'data'),
    port,
    trustProxy: env('SUBHARBOR_TRUST_PROXY') || false,
    allowHttp: env('SUBHARBOR_ALLOW_HTTP_SOURCES') === 'true',
  };
}
