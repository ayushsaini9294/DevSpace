import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentUser } from '../lib/auth';
import { connectLive } from '../lib/live';

/** Keeps one live connection open for this tab while someone is logged in. */
export function LiveUpdates() {
  const queryClient = useQueryClient();
  const myId = useCurrentUser().data?.id;
  useEffect(() => {
    if (!myId) return;
    return connectLive(queryClient, myId);
  }, [queryClient, myId]);
  return null;
}

/** The root of every page: the live connection, then the page. */
export function AppRoot() {
  return (
    <>
      <LiveUpdates />
      <Outlet />
    </>
  );
}
