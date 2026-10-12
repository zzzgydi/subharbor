import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import ipaddr from 'ipaddr.js';

export function isPublicIP(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export type FetchResult = {
  content?: string;
  etag?: string;
  lastModified?: string;
  notModified: boolean;
};
export async function fetchSubscription(
  raw: string,
  headers: Record<string, string> = {},
  allowHttp = false,
  redirect = 0,
): Promise<FetchResult> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:'))
    throw new Error('来源必须使用 HTTPS（HTTP 需部署者显式启用）');
  if (url.username || url.password) throw new Error('URL 不接受内嵌用户名密码，请使用请求头');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicIP(a.address)))
    throw new Error('来源解析到非公网地址');
  const resolved = addresses[0]!;
  const clean: Record<string, string> = {
    'User-Agent': 'SubHarbor/0.1',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
  };
  for (const [name, value] of Object.entries(headers)) {
    if (
      !/^[\w-]+$/.test(name) ||
      /[\r\n]/.test(value) ||
      [
        'host',
        'connection',
        'transfer-encoding',
        'content-length',
        'forwarded',
        'x-forwarded-for',
      ].includes(name.toLowerCase())
    )
      throw new Error('不允许该请求头');
    clean[name] = value;
  }
  return new Promise((resolve, reject) => {
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester(
      url,
      {
        headers: clean,
        agent: false,
        lookup: (_host: string, options: any, callback: any) => {
          if (options.all) callback(null, [resolved]);
          else callback(null, resolved.address, resolved.family);
        },
      },
      async (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          clearTimeout(timer);
          if (!res.headers.location || redirect >= 3) {
            reject(new Error('重定向次数超过限制'));
            return;
          }
          try {
            const next = new URL(res.headers.location, url);
            const forwarded = next.origin === url.origin ? headers : {};
            resolve(await fetchSubscription(next.toString(), forwarded, allowHttp, redirect + 1));
          } catch {
            reject(new Error('重定向目标不可用或不满足公网限制'));
          }
          return;
        }
        if (status === 304) {
          res.resume();
          clearTimeout(timer);
          resolve({
            notModified: true,
            etag: res.headers.etag,
            lastModified: res.headers['last-modified'],
          });
          return;
        }
        if (status !== 200) {
          res.resume();
          clearTimeout(timer);
          reject(new Error(`订阅服务返回 HTTP ${status}`));
          return;
        }
        const encoding = res.headers['content-encoding'];
        const stream =
          encoding === 'gzip'
            ? res.pipe(createGunzip())
            : encoding === 'deflate'
              ? res.pipe(createInflate())
              : encoding === 'br'
                ? res.pipe(createBrotliDecompress())
                : res;
        const chunks: Buffer[] = [];
        let bytes = 0;
        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 10 * 1024 * 1024) {
            stream.destroy();
            req.destroy();
            clearTimeout(timer);
            reject(new Error('解压后内容超过 10 MiB'));
          } else chunks.push(chunk);
        });
        stream.on('error', () => {
          clearTimeout(timer);
          reject(new Error('订阅传输或解压失败'));
        });
        res.on('error', () => {
          clearTimeout(timer);
          reject(new Error('订阅传输失败'));
        });
        stream.on('end', () => {
          clearTimeout(timer);
          resolve({
            content: Buffer.concat(chunks).toString('utf8'),
            notModified: false,
            etag: res.headers.etag,
            lastModified: res.headers['last-modified'],
          });
        });
      },
    );
    const timer = setTimeout(() => req.destroy(), 15000);
    req.on('error', () => {
      clearTimeout(timer);
      reject(new Error('订阅请求失败或超时'));
    });
    req.end();
  });
}
