import { env } from './config/env.ts';
import { prisma } from './lib/prisma.ts';
import { createApp } from './app.ts';
import { recoverInterruptedImports } from './repository/import.ts';
import { attachIdeUpgrades } from './ide/proxy.ts';
import { recoverIdeContainers } from './ide/service.ts';

// Imports that were running when the API last stopped can't resume: mark them failed.
try {
  const count = await recoverInterruptedImports();
  if (count > 0) console.log(`Marked ${count} interrupted repository import(s) as failed`);
} catch (err) {
  console.error(
    'Could not check for interrupted imports:',
    err instanceof Error ? err.message : err,
  );
}

// IDE containers the previous process left starting or running: watch them again or mark them
// stopped (never fatal: Docker may be down, and everything else still works).
try {
  const count = await recoverIdeContainers();
  if (count > 0) console.log(`Checked ${count} IDE container(s) left from the last run`);
} catch (err) {
  console.error('Could not check IDE containers:', err instanceof Error ? err.message : err);
}

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});
attachIdeUpgrades(server);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  server.close(async (err) => {
    await prisma.$disconnect().catch(() => undefined);
    process.exit(err ? 1 : 0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
