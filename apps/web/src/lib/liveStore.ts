import { useEffect } from 'react';
import { create } from 'zustand';

/** While the live connection is up, pages poll this rarely: events tell them what changed. */
export const LIVE_POLL_MS = 60_000;

type LiveState = {
  /** The app's socket is connected right now. */
  connected: boolean;
  /** Projects whose room this tab wants, with how many open views want each. */
  rooms: Record<string, number>;
};

export const useLiveStore = create<LiveState>(() => ({ connected: false, rooms: {} }));

export function setLiveConnected(connected: boolean) {
  useLiveStore.setState({ connected });
}

/** The project ids whose rooms this tab wants. */
export function wantedRooms(state: LiveState = useLiveStore.getState()): string[] {
  return Object.keys(state.rooms);
}

function changeRoom(projectId: string, by: 1 | -1) {
  useLiveStore.setState((state) => {
    const count = (state.rooms[projectId] ?? 0) + by;
    const rooms = { ...state.rooms };
    if (count > 0) rooms[projectId] = count;
    else delete rooms[projectId];
    return { rooms };
  });
}

/** Receive the project's live events while this component is shown. */
export function useProjectRoom(projectId: string) {
  useEffect(() => {
    if (!projectId) return;
    changeRoom(projectId, 1);
    return () => changeRoom(projectId, -1);
  }, [projectId]);
}

/** Whether the live connection is up. */
export function useLiveConnected(): boolean {
  return useLiveStore((state) => state.connected);
}

/**
 * How often to poll: `ms` without a live connection, and at most every 60 s with one (events
 * refresh the data in between). `false` stays false.
 */
export function usePollInterval<T extends number | false>(ms: T): T | number {
  const connected = useLiveConnected();
  if (ms === false) return ms;
  return connected ? Math.max(ms, LIVE_POLL_MS) : ms;
}
