import { createWebServer } from './server.js';

const server = createWebServer();

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down Web UI...`);
  await server.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  const addr = await server.start();
  console.log(`AI Office Web UI listening on http://${addr.host}:${addr.port}`);
} catch (err) {
  console.error(err?.message || err);
  process.exit(1);
}
