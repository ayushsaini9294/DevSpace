import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogInRequestSchema, SignUpRequestSchema } from '@devspace/shared';
import {
  emptyDashboard,
  healthOk,
  loggedIn,
  loggedOut,
  renderApp,
  stubApi,
  testUser,
} from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestBody(fetchMock: ReturnType<typeof stubApi>, key: string): unknown {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => `${init?.method ?? 'GET'} ${String(url)}` === key,
  );
  if (!call) throw new Error(`no request ${key}`);
  const init = call[1];
  expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  return JSON.parse(String(init?.body));
}

function expectFieldError(label: string, message: string) {
  const input = screen.getByLabelText(label, { exact: true });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription(message);
}

describe('sign-up page', () => {
  it('shows per-field messages and sends nothing when the form is invalid', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({ 'GET /api/auth/me': loggedOut });
    renderApp('/signup');

    await user.click(await screen.findByRole('button', { name: 'Create account' }));

    expectFieldError('Name', 'Enter your name');
    expectFieldError('Email', 'Enter your email');
    expectFieldError('Password', 'Use at least 8 characters');
    expect(screen.getByLabelText('Name', { exact: true })).toHaveFocus();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

    await user.type(screen.getByLabelText('Email', { exact: true }), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expectFieldError('Email', 'Enter a valid email address');
  });

  it('uses the right input types and autocomplete hints', async () => {
    stubApi({ 'GET /api/auth/me': loggedOut });
    renderApp('/signup');
    const name = await screen.findByLabelText('Name', { exact: true });
    expect(name).toHaveAttribute('autocomplete', 'name');
    expect(screen.getByLabelText('Email', { exact: true })).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Email', { exact: true })).toHaveAttribute(
      'autocomplete',
      'email',
    );
    expect(screen.getByLabelText('Password', { exact: true })).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password', { exact: true })).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });

  it('shows email_taken on the email field', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/auth/me': loggedOut,
      'POST /api/auth/signup': {
        status: 409,
        body: { error: 'email_taken', message: 'An account with this email already exists' },
      },
    });
    const { router } = renderApp('/signup');

    await user.type(await screen.findByLabelText('Name', { exact: true }), 'Ada');
    await user.type(screen.getByLabelText('Email', { exact: true }), 'ada@example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'long-enough-1');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('An account with this email already exists');
    expectFieldError('Email', 'An account with this email already exists');
    expect(router.state.location.pathname).toBe('/signup');
    expect(screen.queryByTestId('current-user')).not.toBeInTheDocument();
  });

  it('signs up, stores the user and goes home', async () => {
    const user = userEvent.setup();
    let session = loggedOut;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => session,
      ...emptyDashboard,
      'GET /api/health': healthOk,
      'POST /api/auth/signup': () => {
        session = loggedIn;
        return { status: 201, body: { user: testUser } };
      },
    });
    const { router } = renderApp('/signup');

    await user.type(await screen.findByLabelText('Name', { exact: true }), '  Ada Lovelace ');
    await user.type(screen.getByLabelText('Email', { exact: true }), 'Ada@Example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'long-enough-1');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByTestId('current-user')).toHaveTextContent(testUser.name);
    expect(router.state.location.pathname).toBe('/');
    expect(await screen.findByText(`Welcome, ${testUser.name}`)).toBeInTheDocument();
    const sent = SignUpRequestSchema.parse(requestBody(fetchMock, 'POST /api/auth/signup'));
    expect(sent).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'long-enough-1',
    });
  });
});

describe('log-in page', () => {
  it('shows invalid_credentials as a form-level alert', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/auth/me': loggedOut,
      'POST /api/auth/login': {
        status: 401,
        body: { error: 'invalid_credentials', message: 'Email or password is incorrect' },
      },
    });
    const { router } = renderApp('/login');

    await user.type(await screen.findByLabelText('Email', { exact: true }), 'ada@example.com');
    await user.type(screen.getByLabelText('Password', { exact: true }), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
    expect(screen.getByLabelText('Email', { exact: true })).not.toHaveAttribute('aria-invalid');
    expect(router.state.location.pathname).toBe('/login');
  });

  it('asks for a password and disables the button while logging in', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi({ 'GET /api/auth/me': loggedOut, 'POST /api/auth/login': 'pending' });
    renderApp('/login');

    await user.type(await screen.findByLabelText('Email', { exact: true }), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expectFieldError('Password', 'Enter your password');
    expect(screen.getByLabelText('Password', { exact: true })).toHaveAttribute(
      'autocomplete',
      'current-password',
    );

    await user.type(screen.getByLabelText('Password', { exact: true }), 'secret');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log in' })).toBeDisabled());
    expect(LogInRequestSchema.parse(requestBody(fetchMock, 'POST /api/auth/login'))).toEqual({
      email: 'ada@example.com',
      password: 'secret',
    });
  });

  it('redirects to / when already logged in', async () => {
    stubApi({ 'GET /api/auth/me': loggedIn, 'GET /api/health': healthOk, ...emptyDashboard });
    const { router } = renderApp('/login');
    expect(await screen.findByText(`Welcome, ${testUser.name}`)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('top bar', () => {
  it('shows nothing on the right while the session is loading', async () => {
    stubApi({ 'GET /api/auth/me': 'pending', 'GET /api/health': 'pending' });
    renderApp('/');
    const banner = await screen.findByRole('banner');
    expect(within(banner).getAllByRole('link')).toHaveLength(1); // just the DevSpace home link
    expect(within(banner).queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows Log in and Sign up links when logged out', async () => {
    stubApi({ 'GET /api/auth/me': loggedOut, 'GET /api/health': healthOk });
    renderApp('/');
    const banner = screen.getByRole('banner');
    expect(await within(banner).findByRole('link', { name: 'Log in' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(within(banner).getByRole('link', { name: 'Sign up' })).toHaveAttribute(
      'href',
      '/signup',
    );
    expect(screen.queryByTestId('current-user')).not.toBeInTheDocument();
  });

  it('shows the user and logs out to /login, clearing the session', async () => {
    const user = userEvent.setup();
    let session = loggedIn;
    const fetchMock = stubApi({
      'GET /api/auth/me': () => session,
      ...emptyDashboard,
      'GET /api/health': healthOk,
      'POST /api/auth/logout': () => {
        session = loggedOut;
        return { status: 204 };
      },
    });
    const { router } = renderApp('/');
    const banner = screen.getByRole('banner');

    expect(await within(banner).findByTestId('current-user')).toHaveTextContent(testUser.name);
    await user.click(within(banner).getByRole('button', { name: 'Log out' }));

    expect(await within(banner).findByRole('link', { name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.queryByTestId('current-user')).not.toBeInTheDocument();
    expect(requestBody(fetchMock, 'POST /api/auth/logout')).toEqual({});
  });
});
