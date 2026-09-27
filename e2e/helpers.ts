import { expect, type Browser, type Page } from '@playwright/test';

export const PASSWORD = 'correct-horse-battery-1';

/** A short id that is unique across tests, workers and runs. */
export function uniqueId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function uniqueUser() {
  const id = uniqueId();
  return { name: `Test User ${id}`, email: `e2e-${id}@example.com`, password: PASSWORD };
}

export type User = ReturnType<typeof uniqueUser>;

/** The top bar (the page's <header>, role "banner"). */
export function topBar(page: Page) {
  return page.getByRole('banner');
}

/** Fills and submits the signup form on the page that is already open. */
export async function fillSignUpForm(page: Page, user: User) {
  await page.getByLabel('Name', { exact: true }).fill(user.name);
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

export async function signUp(page: Page, user: User) {
  await page.goto('/signup');
  await fillSignUpForm(page, user);
}

export async function logIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

export async function expectLoggedIn(page: Page, user: User) {
  await expect(page.getByTestId('current-user')).toHaveText(user.name);
  await expect(topBar(page).getByRole('button', { name: 'Log out' })).toBeVisible();
}

export async function expectLoggedOut(page: Page) {
  await expect(topBar(page).getByRole('link', { name: 'Log in' })).toBeVisible();
  await expect(topBar(page).getByRole('link', { name: 'Sign up' })).toBeVisible();
  await expect(page.getByTestId('current-user')).toHaveCount(0);
}

/** Accept every window.confirm on this page (remove, leave, role changes, cancel invite). */
export function acceptDialogs(page: Page) {
  page.on('dialog', (dialog) => void dialog.accept());
}

/** A fresh browser context (its own cookies) for a second or third user. */
export async function newUserPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  acceptDialogs(page);
  return page;
}

export async function signUpAndExpectHome(page: Page, user: User) {
  await signUp(page, user);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('current-user')).toHaveText(user.name);
}

export type LeaderProject = {
  leader: User;
  teamName: string;
  projectName: string;
  /** Path of the project, e.g. /projects/abc. */
  projectPath: string;
};

/** Signs the leader up and creates a team and a project, ending on the project page. */
export async function createLeaderWithProject(page: Page): Promise<LeaderProject> {
  const leader = uniqueUser();
  const id = uniqueId();
  const teamName = `Team ${id}`;
  const projectName = `Project ${id}`;

  await signUpAndExpectHome(page, leader);
  await expect(page.getByRole('heading', { level: 2, name: 'Your teams' })).toBeVisible();

  await page.getByLabel('Team name', { exact: true }).fill(teamName);
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page).toHaveURL(/\/teams\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1, name: teamName })).toBeVisible();

  await page.getByLabel('Project name', { exact: true }).fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
  await expect(page.getByText('Your role: Leader', { exact: true })).toBeVisible();

  const projectPath = new URL(page.url()).pathname;
  return { leader, teamName, projectName, projectPath };
}

export function projectNav(
  page: Page,
  name: 'Overview' | 'Files' | 'Members' | 'Activity' | 'Settings',
) {
  return page.getByRole('link', { name, exact: true });
}

/** On the project page: opens Members, invites the email and returns the full invite link. */
export async function createInviteLink(page: Page, email: string) {
  await projectNav(page, 'Members').click();
  await expect(page).toHaveURL(/\/members$/);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Create invite link' }).click();

  const linkInput = page.getByLabel('Invite link', { exact: true });
  await expect(linkInput).toHaveValue(/^https?:\/\/[^/]+\/invite\/[^/?#]+$/);
  return linkInput.inputValue();
}

/**
 * The invited user opens the link while logged out, signs up via the login page's
 * "Sign up" link (which keeps ?next=), comes back to the invite and joins.
 */
export async function joinAsNewUser(
  page: Page,
  inviteLink: string,
  member: User,
  lp: LeaderProject,
) {
  const invitePath = new URL(inviteLink).pathname;

  await page.goto(inviteLink);
  await expect(page).toHaveURL(
    (url) => url.pathname === '/login' && url.searchParams.get('next') === invitePath,
  );

  await page.getByRole('main').getByRole('link', { name: 'Sign up' }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/signup' && url.searchParams.get('next') === invitePath,
  );
  await fillSignUpForm(page, member);

  await expect(page).toHaveURL((url) => url.pathname === invitePath);
  await expect(page.getByTestId('current-user')).toHaveText(member.name);
  await expect(
    page.getByText(`${lp.leader.name} invited you to join ${lp.projectName} in ${lp.teamName}`),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Join project' }).click();
  await expect(page).toHaveURL((url) => url.pathname === lp.projectPath);
  await expect(page.getByRole('heading', { level: 1, name: lp.projectName })).toBeVisible();
  await expect(page.getByText('Your role: Member', { exact: true })).toBeVisible();
}

/** Leader + joined member, each in their own browser context. */
export async function setUpLeaderAndMember(page: Page, browser: Browser) {
  acceptDialogs(page);
  const lp = await createLeaderWithProject(page);
  const member = uniqueUser();
  const inviteLink = await createInviteLink(page, member.email);

  const memberPage = await newUserPage(browser);
  await joinAsNewUser(memberPage, inviteLink, member, lp);
  return { lp, member, memberPage };
}
