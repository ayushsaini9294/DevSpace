import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Layout } from '../app/Layout';
import { LogInPage } from '../pages/LogInPage';
import { loggedIn, loggedOut, renderApp, stubApi, testUser } from '../test/utils';
import { RequireAuth } from './RequireAuth';

const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { path: 'login', element: <LogInPage /> },
      {
        element: <RequireAuth />,
        children: [{ path: 'secret', element: <h1>Secret page</h1> }],
      },
    ],
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RequireAuth', () => {
  it('renders the page for a logged-in user', async () => {
    stubApi({ 'GET /api/auth/me': loggedIn });
    renderApp('/secret', routes);
    expect(await screen.findByRole('heading', { name: 'Secret page' })).toBeInTheDocument();
  });

  it('sends a logged-out user to /login?next=… and back after logging in', async () => {
    const user = userEvent.setup();
    // Like the real server: /me answers with the user once the login has set the cookie.
    let session = loggedOut;
    stubApi({
      'GET /api/auth/me': () => session,
      'POST /api/auth/login': () => {
        session = loggedIn;
        return { status: 200, body: { user: testUser } };
      },
    });
    const { router } = renderApp('/secret?tab=1', routes);

    const email = await screen.findByLabelText('Email', { exact: true });
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/secret?tab=1');
    expect(screen.queryByRole('heading', { name: 'Secret page' })).not.toBeInTheDocument();

    await user.type(email, 'ada@example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'secret');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('heading', { name: 'Secret page' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/secret');
    expect(router.state.location.search).toBe('?tab=1');
  });

  it('ignores an off-site next and goes to /', async () => {
    const user = userEvent.setup();
    let session = loggedOut;
    stubApi({
      'GET /api/auth/me': () => session,
      'POST /api/auth/login': () => {
        session = loggedIn;
        return { status: 200, body: { user: testUser } };
      },
    });
    const { router } = renderApp('/login?next=%2F%2Fevil.example.com', [
      ...routes,
      { path: '/', element: <h1>Home</h1> },
    ]);

    await user.type(await screen.findByLabelText('Email', { exact: true }), 'ada@example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'secret');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });
});
