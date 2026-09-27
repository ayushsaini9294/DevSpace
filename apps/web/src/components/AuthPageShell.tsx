import type { ReactNode } from 'react';

/** Centered card used by the log-in and sign-up pages. */
export function AuthPageShell({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <section className="mx-auto w-full max-w-sm space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
        {children}
      </div>
      <p className="text-sm text-gray-700">{footer}</p>
    </section>
  );
}

/** Form-level error, announced to screen readers as soon as it appears. */
export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
    >
      {children}
    </p>
  );
}

export function SubmitButton({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      className="w-full rounded-md bg-blue-700 px-4 py-2 font-medium text-white hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}
