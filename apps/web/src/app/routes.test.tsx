import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from './routes';

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routes', () => {
  it('renders the home page heading with a pending API status', async () => {
    // Never settles, so the status stays in the checking state.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'DevSpace' })).toBeInTheDocument();
    expect(screen.getByTestId('api-status').textContent).toBe('API: checking…');
  });

  it('shows API: ok when the health check is ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 'ok', database: 'ok' })),
    );
    renderAt('/');
    expect(await screen.findByText('API: ok')).toBeInTheDocument();
  });

  it('shows API: error when the health check answers 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: 'error', database: 'error' }, 503)),
    );
    renderAt('/');
    expect(await screen.findByText('API: error')).toBeInTheDocument();
  });

  it('shows API: error when the body has the wrong shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ hello: 'world' })),
    );
    renderAt('/');
    expect(await screen.findByText('API: error')).toBeInTheDocument();
  });

  it('renders the 404 page for unknown paths', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderAt('/no/such/page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
