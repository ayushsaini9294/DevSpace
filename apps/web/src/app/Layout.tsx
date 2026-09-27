import { Link, Outlet } from 'react-router';

export function Layout() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 bg-white">
        <nav aria-label="Main" className="mx-auto flex max-w-4xl items-center px-4 py-3">
          <Link to="/" className="text-lg font-semibold">
            DevSpace
          </Link>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
