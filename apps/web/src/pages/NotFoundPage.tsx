import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-fg-soft">There is nothing at this address.</p>
      <Link to="/" className="text-accent-fg underline hover:text-accent-strong">
        Go to the home page
      </Link>
    </section>
  );
}
