import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useCurrentUser } from '../lib/auth';
import { FormAlert } from './AuthPageShell';

/**
 * Renders its children (or the child routes) only for a logged-in user.
 * Logged-out visitors go to /login?next=<this page> and come back after logging in.
 */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const location = useLocation();
  const currentUser = useCurrentUser();

  if (currentUser.isPending) return null;
  if (currentUser.isError) {
    return (
      <FormAlert>Could not check whether you are logged in. Please reload the page.</FormAlert>
    );
  }
  if (!currentUser.data) {
    const next = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return children ?? <Outlet />;
}
