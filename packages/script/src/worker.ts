import { getQuickJS } from 'quickjs-emscripten';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > 9 * 1024 * 1024) process.exit(2);
});
process.stdin.on('end', async () => {
  try {
    const { code, value, context } = JSON.parse(input);
    const quick = await getQuickJS();
    const runtime = quick.newRuntime();
    runtime.setMemoryLimit(32 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    const deadline = Date.now() + 1000;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const vm = runtime.newContext();
    try {
      const expression = `${code}\n;(() => { const result = transform(JSON.parse(${JSON.stringify(JSON.stringify(value))}), JSON.parse(${JSON.stringify(JSON.stringify(context))})); if (result && typeof result.then === 'function') throw new Error('Async transforms are unsupported'); return JSON.stringify(result); })()`;
      const result = vm.evalCode(expression, 'transform.js');
      if (result.error) {
        result.error.dispose();
        throw new Error('Script failed');
      }
      try {
        const body = vm.getString(result.value);
        if (!body || Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Invalid output');
        JSON.parse(body);
        process.stdout.write(body);
      } finally {
        result.value.dispose();
      }
    } finally {
      vm.dispose();
      runtime.dispose();
    }
  } catch {
    process.stderr.write('脚本执行失败、超时或输出无效');
    process.exitCode = 1;
  }
});
