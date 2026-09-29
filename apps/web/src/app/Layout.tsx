import { useId } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';
import { NotificationBell } from '../components/NotificationBell';
import { ShareFileSwitch } from '../components/ShareFileSwitch';
import { popoverPanel, usePopover } from '../components/usePopover';
import { linkStyle } from '../components/ui';
import { AI_SETTINGS_URL } from '../lib/ai';
import { useCurrentUser, useLogOut } from '../lib/auth';

const navLink =
  'rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900';

function AccountMenu() {
  const currentUser = useCurrentUser();
  const logOut = useLogOut();
  const navigate = useNavigate();

  // Show nothing until we know, so logged-in users don't see a flash of "Log in".
  if (currentUser.isPending) return null;

  if (!currentUser.data) {
    return (
      <div className="flex items-center gap-1">
        <Link to="/login" className={navLink}>
          Log in
        </Link>
        <Link
          to="/signup"
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800"
        >
          Sign up
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <NotificationBell />
      <UserMenu name={currentUser.data.name} email={currentUser.data.email} />
      <button
        type="button"
        disabled={logOut.isPending}
        onClick={() => logOut.mutate(undefined, { onSuccess: () => navigate('/login') })}
        className={`${navLink} shrink-0 border border-gray-300 disabled:opacity-60`}
      >
        Log out
      </button>
    </div>
  );
}

/** My name in the top bar; it opens my personal settings (Share my open file). */
function UserMenu({ name, email }: { name: string; email: string }) {
  const { buttonRef, open, rootRef, toggle } = usePopover();
  const panelId = useId();
  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        data-testid="current-user"
        aria-expanded={open}
        aria-controls={panelId}
        title={email}
        onClick={toggle}
        className="block max-w-full truncate rounded-md px-2 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none"
      >
        {name}
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Your settings"
          className={`${popoverPanel} space-y-3 p-4`}
        >
          <p className="truncate text-xs text-gray-600" title={email}>
            {email}
          </p>
          <ShareFileSwitch />
          <Link to={AI_SETTINGS_URL} onClick={toggle} className={`${linkStyle} block text-sm`}>
            AI review settings
          </Link>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 bg-white">
        <nav
          aria-label="Main"
          className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3"
        >
          <Link to="/" className="shrink-0 text-lg font-semibold">
            DevSpace
          </Link>
          <AccountMenu />
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
