import { createServer } from 'node:http';
import { env } from './config/env.ts';
import { prisma } from './lib/prisma.ts';
import { createApp } from './app.ts';
import { recoverInterruptedImports } from './repository/import.ts';
import { createIdeServer } from './ide/proxy.ts';
import { startAiGateway } from './ai/gateway.ts';
import { recoverIdeContainers } from './ide/service.ts';
import { backfillCopyBaseShas } from './copies/service.ts';
import { closeCopyUpdateQueue } from './jobs/copy-updates.ts';
import { closeAiReviewQueue } from './jobs/ai-reviews.ts';
import { closeGithubSyncQueue } from './jobs/github-sync.ts';
import { closeEmitter } from './realtime/emitter.ts';
import { attachRealtime } from './realtime/io.ts';
import { sweepPresence } from './realtime/presence.ts';

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

// Copies made before Phase 6 get their base commit (the project's main at that time).
try {
  const count = await backfillCopyBaseShas();
  if (count > 0) console.log(`Set the base commit of ${count} older copies`);
} catch (err) {
  console.error('Could not set base commits:', err instanceof Error ? err.message : err);
}

const app = createApp();

// The IDE site first, so it is up by the time /api/health answers.
const ideServer = createIdeServer();
await new Promise<void>((resolve, reject) => {
  ideServer.once('error', reject);
  ideServer.listen(env.IDE_PORT, env.IDE_HOST, () => {
    ideServer.off('error', reject);
    resolve();
  });
});
console.log(`IDE site listening on ${env.IDE_HOST}:${env.IDE_PORT} (public: ${env.IDE_ORIGIN})`);

// The app's API and its live connection (Socket.io at /socket.io) share the main port.
const server = createServer(app);
const realtime = await attachRealtime(server);
server.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// The AI gateway for IDE assistants (Phase 12), only on the IDE network's host address. If that
// address doesn't exist yet it logs why and keeps retrying; nothing else waits for it.
const aiGateway = startAiGateway();

// IDE reports that ran out (an IDE was closed): tell teammates the member is no longer active.
const PRESENCE_SWEEP_MS = 15_000;
const presenceSweep = setInterval(() => {
  sweepPresence().catch((err: unknown) =>
    console.error('Presence sweep failed:', err instanceof Error ? err.message : err),
  );
}, PRESENCE_SWEEP_MS);
presenceSweep.unref();

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
  clearInterval(presenceSweep);
  aiGateway.close();
  await realtime.close().catch(() => undefined);
  ideServer.close();
  ideServer.closeAllConnections();
  server.close(async (err) => {
    await closeCopyUpdateQueue();
    await closeAiReviewQueue();
    await closeGithubSyncQueue();
    await closeEmitter();
    await prisma.$disconnect().catch(() => undefined);
    process.exit(err ? 1 : 0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
