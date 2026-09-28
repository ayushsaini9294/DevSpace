import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { useLiveStore } from '../lib/liveStore';
import { sockets } from './fakeSocket';

// The first render of a page (cold module loads) can pass 1 s on a busy machine.
configure({ asyncUtilTimeout: 3000 });

// No real connections in tests: the live socket (Phase 9) is a FakeSocket a test can drive.
vi.mock('socket.io-client', async () => {
  const { createFakeSocket } = await import('./fakeSocket');
  return { io: createFakeSocket };
});

afterEach(() => {
  cleanup();
  sockets.length = 0;
  useLiveStore.setState({ connected: false, rooms: {} });
});
