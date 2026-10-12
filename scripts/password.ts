import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { hashPassword } from '../apps/server/src/settings.js';
if (!process.stdin.isTTY) throw new Error('请在交互式终端运行，避免把密码写入命令或日志');
let mute = false;
const output = new Writable({
  write(chunk, _encoding, done) {
    if (!mute) process.stdout.write(chunk);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: true });
process.stdout.write('Administrator password (hidden): ');
mute = true;
const password = await rl.question('');
rl.close();
process.stdout.write('\n');
if (password.length < 12) throw new Error('密码至少 12 个字符');
process.stdout.write(hashPassword(password) + '\n');
