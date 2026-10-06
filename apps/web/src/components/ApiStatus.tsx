export type ApiStatusState = 'checking' | 'ok' | 'error';

const labels: Record<ApiStatusState, string> = {
  checking: 'API: checking…',
  ok: 'API: ok',
  error: 'API: error',
};

const dotColors: Record<ApiStatusState, string> = {
  checking: 'bg-fg-faint',
  ok: 'bg-success-solid',
  error: 'bg-danger-solid',
};

export function ApiStatus({ state }: { state: ApiStatusState }) {
  return (
    <p role="status" className="inline-flex items-center gap-2 text-sm text-fg-soft">
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dotColors[state]}`} />
      <span data-testid="api-status">{labels[state]}</span>
    </p>
  );
}
