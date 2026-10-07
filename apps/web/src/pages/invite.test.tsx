import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InvitationPreviewResponse } from '@devspace/shared';
import {
  loggedIn,
  loggedOut,
  rateLimited,
  renderApp,
  stubApi,
  testProject,
  testUser,
  type StubReply,
} from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

const preview = (matchesYou: boolean): InvitationPreviewResponse => ({
  projectName: 'Website',
  teamName: 'Core team',
  invitedByName: 'Lee Leader',
  email: matchesYou ? testUser.email : 'someone@example.com',
  expiresAt: '2026-10-04T10:00:00.000Z',
  matchesYou,
});

const PREVIEW = 'GET /api/invitations/tok123';
const ACCEPT = 'POST /api/invitations/tok123/accept';

describe('invite page', () => {
  it('shows who invited you and joins the project', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/auth/me': loggedIn,
      [PREVIEW]: { status: 200, body: preview(true) },
      [ACCEPT]: { status: 200, body: { projectId: 'project-1' } },
      'GET /api/projects/project-1': { status: 200, body: { project: testProject('member') } },
      'GET /api/projects': { status: 200, body: { projects: [] } },
    });
    const { router } = renderApp('/invite/tok123');

    expect(
      await screen.findByText('Lee Leader invited you to join Website in Core team'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Join project' }));

    expect(await screen.findByText('Your role: Member')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/projects/project-1');
  });

  it('shows the API’s message when there were too many tries (429)', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/auth/me': loggedIn,
      [PREVIEW]: { status: 200, body: preview(true) },
      [ACCEPT]: rateLimited,
    });
    renderApp('/invite/tok123');
    await user.click(await screen.findByRole('button', { name: 'Join project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many tries. Please wait a minute and try again.',
    );
  });

  it('explains a mismatched account and offers only Log out, which returns here after login', async () => {
    const user = userEvent.setup();
    let session: StubReply = loggedIn;
    stubApi({
      'GET /api/auth/me': () => session,
      [PREVIEW]: { status: 200, body: preview(false) },
      'POST /api/auth/logout': () => {
        session = loggedOut;
        return { status: 204 };
      },
    });
    const { router } = renderApp('/invite/tok123');

    expect(await screen.findByText('someone@example.com')).toBeInTheDocument();
    expect(screen.getAllByText(testUser.email).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Join project' })).not.toBeInTheDocument();

    const main = screen.getByRole('main');
    await user.click(
      [...main.querySelectorAll('button')].find((b) => b.textContent === 'Log out')!,
    );

    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/invite/tok123');
  });

  it.each([
    [410, 'invitation_expired', 'This invite link has expired'],
    [409, 'invitation_used', 'This invite link has already been used'],
    [404, 'not_found', 'This invite link isn’t valid'],
  ] as const)('shows the %i %s state', async (status, error, heading) => {
    stubApi({
      'GET /api/auth/me': loggedIn,
      [PREVIEW]: { status, body: { error, message: 'nope' } },
    });
    renderApp('/invite/tok123');
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join project' })).not.toBeInTheDocument();
  });

  it('links to the project when you are already a member', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/auth/me': loggedIn,
      [PREVIEW]: { status: 200, body: preview(true) },
      [ACCEPT]: {
        status: 409,
        body: { error: 'already_member', message: 'You are already a member' },
      },
      'GET /api/projects': { status: 200, body: { projects: [testProject('member')] } },
    });
    renderApp('/invite/tok123');

    await user.click(await screen.findByRole('button', { name: 'Join project' }));
    expect(await screen.findByRole('link', { name: 'Open Website' })).toHaveAttribute(
      'href',
      '/projects/project-1',
    );
  });

  it('sends a logged-out visitor to log in with next, and sign-up keeps next', async () => {
    stubApi({ 'GET /api/auth/me': loggedOut });
    const { router } = renderApp('/invite/tok123');

    await screen.findByRole('heading', { name: 'Log in' });
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/invite/tok123');
    const footer = screen.getByText(/New to DevSpace\?/);
    expect(within(footer).getByRole('link', { name: 'Sign up' })).toHaveAttribute(
      'href',
      '/signup?next=%2Finvite%2Ftok123',
    );
  });

  it('returns to the invite after signing up from it', async () => {
    const user = userEvent.setup();
    let session: StubReply = loggedOut;
    stubApi({
      'GET /api/auth/me': () => session,
      'POST /api/auth/signup': () => {
        session = loggedIn;
        return { status: 201, body: { user: testUser } };
      },
      [PREVIEW]: { status: 200, body: preview(true) },
    });
    const { router } = renderApp('/signup?next=%2Finvite%2Ftok123');

    await user.type(await screen.findByLabelText('Name', { exact: true }), testUser.name);
    await user.type(screen.getByLabelText('Email', { exact: true }), testUser.email);
    await user.type(screen.getByLabelText('Password', { exact: true }), 'long-enough-1');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('button', { name: 'Join project' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/invite/tok123');
  });
});
