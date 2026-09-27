import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { healthOk, loggedOut, renderApp, stubApi } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routes', () => {
  it('renders the home page heading with a pending API status', async () => {
    // Never settles, so the status stays in the checking state.
    stubApi({ 'GET /api/health': 'pending', 'GET /api/auth/me': 'pending' });
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'DevSpace' })).toBeInTheDocument();
    expect(screen.getByTestId('api-status').textContent).toBe('API: checking…');
  });

  it('shows API: ok when the health check is ok', async () => {
    stubApi({ 'GET /api/health': healthOk, 'GET /api/auth/me': loggedOut });
    renderApp('/');
    expect(await screen.findByText('API: ok')).toBeInTheDocument();
  });

  it('shows API: error when the health check answers 503', async () => {
    stubApi({
      'GET /api/health': { status: 503, body: { status: 'error', database: 'error' } },
      'GET /api/auth/me': loggedOut,
    });
    renderApp('/');
    expect(await screen.findByText('API: error')).toBeInTheDocument();
  });

  it('shows API: error when the body has the wrong shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ hello: 'world' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    renderApp('/');
    expect(await screen.findByText('API: error')).toBeInTheDocument();
  });

  it('renders the 404 page for unknown paths', async () => {
    stubApi({ 'GET /api/auth/me': 'pending' });
    renderApp('/no/such/page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
