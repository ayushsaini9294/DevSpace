import { Navigate, useSearchParams } from 'react-router';
import { AuthPageShell, FormAlert, SubmitButton } from '../components/AuthPageShell';
import { useCurrentUser, useLogIn } from '../lib/auth';
import { errorMessage } from '../lib/formErrors';
import { safeNext } from '../lib/safeNext';

/**
 * The log-in and sign-up pages in the demo: there are no accounts, so they say so and let the
 * visitor straight in as Demo Leader.
 */
export function DemoAuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const currentUser = useCurrentUser();
  const logIn = useLogIn();

  if (currentUser.isPending) return null;
  if (currentUser.data) return <Navigate to={next} replace />;

  return (
    <AuthPageShell
      title={mode === 'login' ? 'Log in' : 'Sign up'}
      footer="In the real DevSpace you sign up with your name, email and a password."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          logIn.mutate({ email: 'demo.leader@example.com', password: 'demo' });
        }}
      >
        <p className="text-fg-soft">
          This is a demo with sample data, so you don’t need an account. You’ll go in as{' '}
          <strong className="text-fg">Demo Leader</strong>, the leader of a small sample team.
        </p>
        {logIn.isError && <FormAlert>{errorMessage(logIn.error)}</FormAlert>}
        <SubmitButton pending={logIn.isPending}>Go in as Demo Leader</SubmitButton>
      </form>
    </AuthPageShell>
  );
}
