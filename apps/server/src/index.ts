import { buildApp } from './app.js';
import { loadSettings } from './settings.js';
const settings = loadSettings();
const { app } = await buildApp(settings, { logger: true });
await app.listen({ port: settings.port, host: process.env.HOST || '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
