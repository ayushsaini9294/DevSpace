import { useId } from 'react';
import { Link, Outlet, useNavigate } from 'react-router';
import { NotificationBell } from '../components/NotificationBell';
import { ShareFileSwitch } from '../components/ShareFileSwitch';
import { popoverPanel, usePopover } from '../components/usePopover';
import { LogoMark } from '../components/LogoMark';
import { linkStyle } from '../components/ui';
import { AI_SETTINGS_URL } from '../lib/ai';
import { useCurrentUser, useLogOut } from '../lib/auth';
import { GITHUB_SETTINGS_URL } from '../lib/github';

const navLink =
  'rounded-lg px-3 py-1.5 text-sm font-medium text-fg-soft hover:bg-muted hover:text-fg focus-visible:ring-4 focus-visible:ring-accent-ring/50 focus-visible:outline-none';

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
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent shadow-card hover:bg-accent-hover focus-visible:ring-4 focus-visible:ring-accent-ring/50 focus-visible:outline-none"
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
        className={`${navLink} shrink-0 border border-line-strong disabled:opacity-60`}
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
        className="flex max-w-full items-center gap-2 rounded-lg py-1 pr-2 pl-1 text-sm font-medium text-fg hover:bg-muted focus-visible:ring-4 focus-visible:ring-accent-ring/50 focus-visible:outline-none"
      >
        {/* The initial is drawn by CSS so the button's text stays exactly the name. */}
        <span
          aria-hidden="true"
          data-initial={name.trim().charAt(0).toUpperCase()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-accent-fg ring-1 ring-accent-line before:content-[attr(data-initial)]"
        />
        <span className="truncate">{name}</span>
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Your settings"
          className={`${popoverPanel} space-y-3 p-4`}
        >
          <p className="truncate text-xs text-fg-muted" title={email}>
            {email}
          </p>
          <ShareFileSwitch />
          <Link to={AI_SETTINGS_URL} onClick={toggle} className={`${linkStyle} block text-sm`}>
            AI settings
          </Link>
          <Link
            to={GITHUB_SETTINGS_URL}
            onClick={toggle}
            data-testid="github-settings-link"
            className={`${linkStyle} block text-sm`}
          >
            GitHub settings
          </Link>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  return (
    <div className="min-h-screen bg-canvas text-fg">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/80 backdrop-blur-md supports-[backdrop-filter]:bg-surface/70">
        <nav
          aria-label="Main"
          className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-2.5"
        >
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2 rounded-lg text-lg font-bold tracking-tight focus-visible:ring-4 focus-visible:ring-accent-ring/50 focus-visible:outline-none"
          >
            <LogoMark />
            DevSpace
          </Link>
          <AccountMenu />
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
        <Outlet />
      </main>
    </div>
  );
}
