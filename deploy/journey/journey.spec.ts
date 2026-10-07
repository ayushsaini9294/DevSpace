import { expect, test, type Page } from '@playwright/test';
import {
  addMember,
  createLeaderWithProject,
  acceptDialogs,
  projectNav,
  setUpEmptyRepository,
} from '../../e2e/helpers';

// Phase 14 Done-when (b): the whole journey on the production stack behind Caddy (in LOCAL mode
// in WSL, or a real server with DEVSPACE_URL): sign up, set up a project, a member opens the IDE
// on its own address and makes a file in its terminal, submits it, the leader reviews the diff,
// approves and merges, and the file is on main. Every page must load without breaking the
// app's Content-Security-Policy (Monaco, the diff viewer and the IDE iframe included).

/** Collects the CSP violations and script errors the app's own pages report (not VS Code's). */
function watchProblems(page: Page, into: string[]) {
  page.on('console', (message) => {
    const from = message.location().url;
    const appHost = new URL(page.url()).host;
    if (from && URL.canParse(from) && new URL(from).host !== appHost) return;
    if (
      /Content Security Policy|Refused to (load|execute|connect|frame|apply|create)/i.test(
        message.text(),
      )
    ) {
      into.push(`${page.url()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => into.push(`${page.url()}: ${error.message}`));
}

test('sign up, set up a project, open the IDE, submit, review and merge', async ({
  page,
  browser,
}) => {
  const problems: string[] = [];
  watchProblems(page, problems);
  acceptDialogs(page);

  // The leader signs up, makes a team and a project, and sets up its repository.
  const lp = await createLeaderWithProject(page);
  await setUpEmptyRepository(page);

  // A member joins and opens the IDE.
  const member = await addMember(page, browser, lp);
  watchProblems(member.page, problems);
  await projectNav(member.page, 'Overview').click();
  await member.page.getByRole('link', { name: 'Open IDE', exact: true }).click();
  const frame = member.page.getByTitle(`VS Code for ${lp.projectName}`, { exact: true });
  await expect(frame).toBeVisible({ timeout: 180_000 });
  const launchUrl = new URL((await frame.getAttribute('src'))!);
  const copyId = launchUrl.hostname.split('.')[0]!;
  expect(copyId).toMatch(/^[0-9a-f-]{36}$/);
  const ide = member.page.frameLocator(`iframe[title="VS Code for ${lp.projectName}"]`);
  const explorer = ide.locator('.explorer-folders-view');
  await expect(explorer.getByText('README.md', { exact: true })).toBeVisible({ timeout: 90_000 });
  const trust = ide.getByRole('button', { name: /Yes, I trust/i });
  if (await trust.isVisible().catch(() => false)) await trust.click();

  // A file made in the IDE's terminal.
  const fileName = `hello-${Date.now()}.txt`;
  const text = 'Hello from the production stack';
  await ide.locator('.monaco-workbench').click({ position: { x: 400, y: 300 } });
  await member.page.keyboard.press('Control+Backquote');
  const terminal = ide.locator('.xterm').first();
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    if (!(await explorer.getByText(fileName, { exact: true }).isVisible())) {
      await terminal.click();
      await member.page.keyboard.type(`echo "${text}" > /home/workspace/${fileName}\n`, {
        delay: 10,
      });
    }
    await expect(explorer.getByText(fileName, { exact: true })).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });

  // The member submits it.
  await member.page.getByRole('link', { name: 'Submit work', exact: true }).click();
  await expect(member.page).toHaveURL(
    (url) => url.pathname === `${lp.projectPath}/submissions/new`,
  );
  await expect(member.page.getByRole('checkbox', { name: fileName, exact: true })).toBeChecked();
  await member.page.getByLabel('Title', { exact: true }).fill('My first change in production');
  await member.page.getByRole('button', { name: 'Submit', exact: true }).click();
  const reviewPath = new RegExp(`^${lp.projectPath}/submissions/([^/]+)$`);
  await expect(member.page).toHaveURL(
    (url) => reviewPath.test(url.pathname) && !url.pathname.endsWith('/new'),
  );
  const reviewUrl = new URL(member.page.url()).pathname;

  // The leader reviews the diff (Monaco's diff viewer), approves and merges.
  await page.goto(reviewUrl);
  const status = page.getByTestId('submission-status');
  await expect(status).toHaveText('Open');
  const fileRegion = page.getByRole('region', { name: fileName, exact: true });
  await expect(fileRegion.locator('.editor.modified .lines-content > .view-lines')).toContainText(
    text,
  );
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Approve submission', exact: true })
    .click();
  await expect(status).toHaveText('Approved');
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Merge into main', exact: true })
    .click();
  await expect(status).toHaveText('Merged');

  // The file is on main (Monaco's code viewer shows it).
  await page.goto(lp.projectPath);
  await projectNav(page, 'Files').click();
  await page.getByRole('main').getByRole('link', { name: fileName, exact: true }).click();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(text);

  expect(problems, 'CSP violations or script errors').toEqual([]);
});
