import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { LogInRequestSchema } from '@devspace/shared';
import { AuthPageShell, FormAlert, SubmitButton } from '../components/AuthPageShell';
import { TextField } from '../components/TextField';
import { useCurrentUser, useLogIn } from '../lib/auth';
import { describeServerError, validateForm, type FieldErrors } from '../lib/formErrors';
import { safeNext } from '../lib/safeNext';

const FIELDS = ['email', 'password'] as const;
type Field = (typeof FIELDS)[number];

export function LogInPage() {
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const currentUser = useCurrentUser();
  const logIn = useLogIn();
  const [clientErrors, setClientErrors] = useState<FieldErrors<Field>>({});

  if (currentUser.isPending) return null;
  // Also where a successful login lands: the mutation puts the user into the cache.
  if (currentUser.data) return <Navigate to={next} replace />;

  const server = describeServerError(logIn.error, FIELDS);
  const errorFor = (field: Field) => clientErrors[field] ?? server.fieldErrors[field];

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = validateForm(
      LogInRequestSchema,
      {
        email: String(data.get('email') ?? ''),
        password: String(data.get('password') ?? ''),
      },
      FIELDS,
      { email: (value) => (value.trim() ? 'Enter a valid email address' : 'Enter your email') },
    );
    if (!result.ok) {
      logIn.reset();
      setClientErrors(result.errors);
      const input = form.elements.namedItem(result.firstField);
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setClientErrors({});
    logIn.mutate(result.data);
  }

  return (
    <AuthPageShell
      title="Log in"
      footer={
        <>
          New to DevSpace?{' '}
          <Link
            to={next === '/' ? '/signup' : `/signup?next=${encodeURIComponent(next)}`}
            className="font-medium text-accent-fg underline hover:text-accent-strong"
          >
            Sign up
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          error={errorFor('email')}
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          error={errorFor('password')}
        />
        {server.formError && <FormAlert>{server.formError}</FormAlert>}
        <SubmitButton pending={logIn.isPending}>Log in</SubmitButton>
      </form>
    </AuthPageShell>
  );
}
