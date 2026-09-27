import { ApiStatus } from '../components/ApiStatus';
import { useApiStatus } from '../lib/health';

export function HomePage() {
  const status = useApiStatus();
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">DevSpace</h1>
      <p className="text-gray-700">
        A team workspace: everyone works on their own copy, and leaders merge reviewed work into
        main.
      </p>
      <ApiStatus state={status} />
    </section>
  );
}
