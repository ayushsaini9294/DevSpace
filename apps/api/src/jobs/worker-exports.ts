/** What apps/worker imports for the automatic copy updates job (`@devspace/api/copy-updates`). */
export {
  COPY_UPDATE_JOB,
  COPY_UPDATE_QUEUE,
  closeCopyUpdateQueue,
  queueCopyUpdates,
  useCopyUpdateQueue,
  type CopyUpdateJobData,
} from './copy-updates.ts';
export { updateProjectCopies, type ProjectUpdateResult } from '../copies/update.ts';
/** Live updates the worker sends go through Redis (closed on shutdown). */
export { closeEmitter, useRealtimeKey } from '../realtime/emitter.ts';
