export type ApiStatusState = 'checking' | 'ok' | 'error';

const labels: Record<ApiStatusState, string> = {
  checking: 'API: checking…',
  ok: 'API: ok',
  error: 'API: error',
};

const dotColors: Record<ApiStatusState, string> = {
  checking: 'bg-gray-400',
  ok: 'bg-green-600',
  error: 'bg-red-600',
};

export function ApiStatus({ state }: { state: ApiStatusState }) {
  return (
    <p role="status" className="inline-flex items-center gap-2 text-sm text-gray-700">
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dotColors[state]}`} />
      <span data-testid="api-status">{labels[state]}</span>
    </p>
  );
}
