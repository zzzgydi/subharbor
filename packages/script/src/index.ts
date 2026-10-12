import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
let queue: Promise<unknown> = Promise.resolve();
export function runScript(code: string, value: unknown, context: unknown): Promise<unknown> {
  const task = queue.then(() => execute(code, value, context));
  queue = task.catch(() => undefined);
  return task;
}
function execute(code: string, value: unknown, context: unknown): Promise<unknown> {
  const body = JSON.stringify({ code, value, context });
  if (Buffer.byteLength(body) > 9 * 1024 * 1024 || Buffer.byteLength(code) > 256 * 1024)
    return Promise.reject(new Error('脚本输入超过限额'));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [resolve('dist/script-worker.js')], {
      env: {},
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      size = 0,
      settled = false;
    const finish = (error?: Error, data?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise(data);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('脚本超过 3 秒执行时间'));
    }, 3000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 8 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new Error('脚本输出超过限额'));
      } else output += chunk;
    });
    child.stderr.resume();
    child.stdin.on('error', () => finish(new Error('脚本执行失败')));
    child.on('error', () => finish(new Error('无法启动脚本进程')));
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error('脚本执行失败、超时或返回非法结果'));
      try {
        finish(undefined, JSON.parse(output));
      } catch {
        finish(new Error('脚本必须返回可序列化的对象'));
      }
    });
    child.stdin.end(body);
  });
}
