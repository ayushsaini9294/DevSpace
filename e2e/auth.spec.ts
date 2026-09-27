import { expect, test } from '@playwright/test';
import { expectLoggedIn, expectLoggedOut, logIn, signUp, topBar, uniqueUser } from './helpers';

const SESSION_COOKIE = 'devspace_session';

test('sign up, stay logged in after refresh, log out, log back in', async ({ page }) => {
  const user = uniqueUser();

  await signUp(page, user);
  await expect(page).toHaveURL(/\/$/);
  await expectLoggedIn(page, user);

  // Phase 2 "Done when": the session survives a full page reload.
  await page.reload();
  await expectLoggedIn(page, user);
  await expect(page.getByRole('heading', { level: 1, name: 'DevSpace' })).toBeVisible();

  await topBar(page).getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expectLoggedOut(page);

  // Logged out must also survive a reload (the cookie is really gone server-side).
  await page.reload();
  await expectLoggedOut(page);

  await logIn(page, user.email, user.password);
  await expect(page).toHaveURL(/\/$/);
  await expectLoggedIn(page, user);

  await page.reload();
  await expectLoggedIn(page, user);
});

test('wrong password shows an error and stays logged out', async ({ page }) => {
  const user = uniqueUser();

  await signUp(page, user);
  await expectLoggedIn(page, user);
  await topBar(page).getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await logIn(page, user.email, 'not-the-right-password');
  await expect(page.getByRole('alert')).toContainText('Email or password is incorrect');
  await expect(page).toHaveURL(/\/login$/);
  await expectLoggedOut(page);

  await page.reload();
  await expectLoggedOut(page);
});

test('signing up twice with the same email shows an error and does not log in', async ({
  page,
}) => {
  const user = uniqueUser();

  await signUp(page, user);
  await expectLoggedIn(page, user);
  await topBar(page).getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await signUp(page, { ...user, name: `${user.name} again` });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).not.toBeEmpty();
  await expect(page).toHaveURL(/\/signup$/);
  await expectLoggedOut(page);

  await page.reload();
  await expectLoggedOut(page);
});

test('session cookie is HttpOnly and hidden from page scripts', async ({ page, context }) => {
  const user = uniqueUser();

  await signUp(page, user);
  await expectLoggedIn(page, user);

  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === SESSION_COOKIE);
  expect(session, `expected a "${SESSION_COOKIE}" cookie`).toBeDefined();
  expect(session!.httpOnly).toBe(true);
  expect(session!.value).not.toBe('');

  const documentCookie = await page.evaluate(() => document.cookie);
  expect(documentCookie).not.toContain(SESSION_COOKIE);
});
