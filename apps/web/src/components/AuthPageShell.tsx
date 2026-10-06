import type { ReactNode } from 'react';
import { LogoMark } from './LogoMark';

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
    <section className="mx-auto w-full max-w-sm space-y-6 pt-4 sm:pt-10">
      <div className="space-y-3 text-center">
        <LogoMark className="mx-auto h-10 w-10" />
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      </div>
      <div className="rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-7">
        {children}
      </div>
      <p className="text-center text-sm text-fg-soft">{footer}</p>
    </section>
  );
}

/** Form-level error, announced to screen readers as soon as it appears. */
export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger-fg"
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
      className="w-full rounded-lg bg-accent px-4 py-2.5 font-semibold text-on-accent shadow-card hover:bg-accent-hover focus-visible:ring-4 focus-visible:ring-accent-ring/50 focus-visible:outline-none active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}
