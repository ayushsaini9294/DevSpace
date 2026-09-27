import { expect, type Page } from '@playwright/test';

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
