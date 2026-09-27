import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { SignUpRequestSchema } from '@devspace/shared';
import { AuthPageShell, FormAlert, SubmitButton } from '../components/AuthPageShell';
import { TextField } from '../components/TextField';
import { useCurrentUser, useSignUp } from '../lib/auth';
import { describeServerError, validateForm, type FieldErrors } from '../lib/formErrors';
import { safeNext } from '../lib/safeNext';

const FIELDS = ['name', 'email', 'password'] as const;
type Field = (typeof FIELDS)[number];

export function SignUpPage() {
  const [searchParams] = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const currentUser = useCurrentUser();
  const signUp = useSignUp();
  const [clientErrors, setClientErrors] = useState<FieldErrors<Field>>({});

  if (currentUser.isPending) return null;
  if (currentUser.data) return <Navigate to={next} replace />;

  const server = describeServerError(signUp.error, FIELDS);
  const errorFor = (field: Field) => clientErrors[field] ?? server.fieldErrors[field];

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = validateForm(
      SignUpRequestSchema,
      {
        name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''),
        password: String(data.get('password') ?? ''),
      },
      FIELDS,
      { email: (value) => (value.trim() ? 'Enter a valid email address' : 'Enter your email') },
    );
    if (!result.ok) {
      signUp.reset();
      setClientErrors(result.errors);
      const input = form.elements.namedItem(result.firstField);
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setClientErrors({});
    signUp.mutate(result.data);
  }

  return (
    <AuthPageShell
      title="Create your account"
      footer={
        <>
          Already have an account?{' '}
          <Link
            to={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`}
            className="font-medium text-blue-700 underline hover:text-blue-900"
          >
            Log in
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        <TextField label="Name" name="name" autoComplete="name" required error={errorFor('name')} />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          error={errorFor('email')}
          errorIsAlert={server.alertField === 'email' && !clientErrors.email}
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          error={errorFor('password')}
        />
        {server.formError && <FormAlert>{server.formError}</FormAlert>}
        <SubmitButton pending={signUp.isPending}>Create account</SubmitButton>
      </form>
    </AuthPageShell>
  );
}
