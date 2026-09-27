import { Link, Outlet, useNavigate } from 'react-router';
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
      <span
        data-testid="current-user"
        className="truncate text-sm font-medium text-gray-800"
        title={currentUser.data.email}
      >
        {currentUser.data.name}
      </span>
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
