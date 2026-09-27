import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-gray-700">There is nothing at this address.</p>
      <Link to="/" className="text-blue-700 underline hover:text-blue-900">
        Go to the home page
      </Link>
    </section>
  );
}
