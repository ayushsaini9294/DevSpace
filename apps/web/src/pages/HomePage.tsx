import { Link } from 'react-router';
import { ApiStatus } from '../components/ApiStatus';
import { useCurrentUser } from '../lib/auth';
import { useApiStatus } from '../lib/health';

function Account() {
  const currentUser = useCurrentUser();
  if (currentUser.isPending) return null;

  if (currentUser.data) {
    return (
      <div className="space-y-2 rounded-lg border border-gray-200 bg-white p-4">
        <p className="text-lg font-medium">Welcome, {currentUser.data.name}</p>
        <p className="text-gray-700">
          Your account is ready. Teams and projects arrive in the next phase, so there is nothing
          else to do here yet.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Link
        to="/signup"
        className="rounded-md bg-blue-700 px-4 py-2 text-center font-medium text-white hover:bg-blue-800"
      >
        Create an account
      </Link>
      <Link
        to="/login"
        className="rounded-md border border-gray-300 bg-white px-4 py-2 text-center font-medium text-gray-800 hover:bg-gray-100"
      >
        Log in to your account
      </Link>
    </div>
  );
}

export function HomePage() {
  const status = useApiStatus();
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">DevSpace</h1>
      <p className="text-gray-700">
        A team workspace: everyone works on their own copy, and leaders merge reviewed work into
        main.
      </p>
      <Account />
      <ApiStatus state={status} />
    </section>
  );
}
