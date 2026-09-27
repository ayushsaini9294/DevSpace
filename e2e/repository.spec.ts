import { expect, test, type Page } from '@playwright/test';
import {
  acceptDialogs,
  createLeaderWithProject,
  projectNav,
  setUpLeaderAndMember,
} from './helpers';

// Sign-ups, project setup and (for imports) a real clone over the internet take a while.
test.describe.configure({ timeout: 90_000 });

/** Imports clone from GitHub for real, so give them longer than the default. */
const IMPORT_TIMEOUT = 90_000;

function main(page: Page) {
  return page.getByRole('main');
}

/** A folder or file in the listing: a link named exactly by the entry name. */
function entry(page: Page, name: string) {
  return main(page).getByRole('link', { name, exact: true });
}

/** The read-only Monaco editor on a file page. */
function viewerLines(page: Page) {
  return page.getByTestId('file-viewer').locator('.view-lines');
}

/** The breadcrumb above the listing / file. */
function breadcrumb(page: Page) {
  return main(page).getByRole('navigation', { name: /breadcrumb/i });
}

/** Opens the project's Files page from the project nav. */
async function openFiles(page: Page, projectPath: string) {
  await projectNav(page, 'Files').click();
  await expect(page).toHaveURL((url) => url.pathname.startsWith(`${projectPath}/files`));
}

function setupHeading(page: Page) {
  return page.getByRole('heading', { name: 'Set up the repository', exact: true });
}

async function setUpEmpty(page: Page) {
  await expect(setupHeading(page)).toBeVisible();
  await page.getByRole('radio', { name: 'Start empty', exact: true }).check();
  await page.getByRole('button', { name: 'Set up repository', exact: true }).click();
  await expect(entry(page, 'README.md')).toBeVisible();
}

async function startImport(page: Page, url: string) {
  await expect(setupHeading(page)).toBeVisible();
  await page.getByRole('radio', { name: 'Import from a Git link', exact: true }).check();
  await page.getByLabel('Git link', { exact: true }).fill(url);
  await page.getByRole('button', { name: 'Set up repository', exact: true }).click();
}

test('a leader sets up an empty repository and sees README.md in the browser', async ({ page }) => {
  acceptDialogs(page);
  const { projectName, projectPath } = await createLeaderWithProject(page);

  await openFiles(page, projectPath);
  await setUpEmpty(page);

  // The README's content is shown under the list as plain text.
  await expect(main(page).getByText(`# ${projectName}`, { exact: true })).toBeVisible();
  await expect(setupHeading(page)).toHaveCount(0);

  await entry(page, 'README.md').click();
  await expect(page).toHaveURL((url) => url.pathname === `${projectPath}/blob/README.md`);
  await expect(
    page.getByRole('heading', { level: 2, name: 'README.md', exact: true }),
  ).toBeVisible();
  await expect(viewerLines(page)).toContainText(`# ${projectName}`);

  // The file lives on the server: a reload shows the same content.
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 2, name: 'README.md', exact: true }),
  ).toBeVisible();
  await expect(viewerLines(page)).toContainText(`# ${projectName}`);
});

test('a leader imports a public GitHub repository and opens its README', async ({ page }) => {
  test.setTimeout(150_000);
  acceptDialogs(page);
  const { projectPath } = await createLeaderWithProject(page);
  const url = 'https://github.com/octocat/Hello-World';

  await openFiles(page, projectPath);
  await startImport(page, url);

  // octocat/Hello-World has a single file, README (no extension), containing "Hello World!".
  await expect(entry(page, 'README')).toBeVisible({ timeout: IMPORT_TIMEOUT });
  await expect(page.getByRole('alert')).toHaveCount(0);

  await entry(page, 'README').click();
  await expect(page).toHaveURL((u) => u.pathname === `${projectPath}/blob/README`);
  await expect(page.getByRole('heading', { level: 2, name: 'README', exact: true })).toBeVisible();
  await expect(viewerLines(page)).toContainText('Hello World');
});

test('an import link on another host is rejected before anything is sent', async ({ page }) => {
  acceptDialogs(page);
  const { projectPath } = await createLeaderWithProject(page);
  await openFiles(page, projectPath);

  const setupRequests: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/api\/projects\/[^/]+\/repository/.test(req.url())) {
      setupRequests.push(req.url());
    }
  });

  await startImport(page, 'https://example.com/a/b');
  await expect(
    main(page).getByText('Only GitHub, GitLab and Bitbucket links are supported', { exact: true }),
  ).toBeVisible();

  // Still on the setup form, and no setup request went to the API.
  await expect(setupHeading(page)).toBeVisible();
  await expect(page.getByLabel('Git link', { exact: true })).toHaveValue('https://example.com/a/b');
  expect(setupRequests).toEqual([]);
});

test('a member can browse the files but cannot set up the repository', async ({
  page,
  browser,
}) => {
  const { lp, memberPage } = await setUpLeaderAndMember(page, browser);
  try {
    // Not set up yet: the member gets a message, not the form.
    await openFiles(memberPage, lp.projectPath);
    await expect(
      main(memberPage).getByText(
        "The repository hasn't been set up yet. A leader or co-leader can set it up.",
      ),
    ).toBeVisible();
    await expect(setupHeading(memberPage)).toHaveCount(0);
    await expect(memberPage.getByRole('button', { name: 'Set up repository' })).toHaveCount(0);
    await expect(memberPage.getByRole('radio')).toHaveCount(0);

    // The leader sets it up.
    await page.goto(lp.projectPath);
    await openFiles(page, lp.projectPath);
    await setUpEmpty(page);

    // The member now sees and opens the file.
    await memberPage.reload();
    await expect(entry(memberPage, 'README.md')).toBeVisible();
    await expect(setupHeading(memberPage)).toHaveCount(0);
    await entry(memberPage, 'README.md').click();
    await expect(memberPage).toHaveURL(
      (url) => url.pathname === `${lp.projectPath}/blob/README.md`,
    );
    await expect(viewerLines(memberPage)).toContainText(`# ${lp.projectName}`);
  } finally {
    await memberPage.context().close();
  }
});

test('folders open, binary files are not shown, and the breadcrumb leads back', async ({
  page,
}) => {
  test.setTimeout(150_000);
  acceptDialogs(page);
  const { projectName, projectPath } = await createLeaderWithProject(page);

  // A tiny public repo with folders: images/, javascripts/, stylesheets/ and a few files.
  await openFiles(page, projectPath);
  await startImport(page, 'https://github.com/octocat/octocat.github.io');
  await expect(entry(page, 'javascripts')).toBeVisible({ timeout: IMPORT_TIMEOUT });
  await expect(entry(page, 'index.html')).toBeVisible();

  // Into a folder, then a text file in it.
  await entry(page, 'javascripts').click();
  await expect(page).toHaveURL((url) => url.pathname === `${projectPath}/files/javascripts`);
  await expect(entry(page, 'index.html')).toHaveCount(0);
  await entry(page, 'main.js').click();
  await expect(page).toHaveURL((url) => url.pathname === `${projectPath}/blob/javascripts/main.js`);
  await expect(page.getByRole('heading', { level: 2, name: 'main.js', exact: true })).toBeVisible();
  await expect(viewerLines(page)).toContainText("console.log('This would be the main JS file.');");

  // The breadcrumb leads back to the folder, then to the root.
  await breadcrumb(page).getByRole('link', { name: 'javascripts', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `${projectPath}/files/javascripts`);
  await expect(entry(page, 'main.js')).toBeVisible();
  await breadcrumb(page).getByRole('link', { name: projectName, exact: true }).click();
  await expect(page).toHaveURL((url) => /^\/projects\/[^/]+\/files\/?$/.test(url.pathname));
  await expect(entry(page, 'javascripts')).toBeVisible();
  await expect(entry(page, 'index.html')).toBeVisible();

  // A binary file is listed but its content isn't shown.
  await entry(page, 'images').click();
  await entry(page, 'blacktocat.png').click();
  await expect(page).toHaveURL(
    (url) => url.pathname === `${projectPath}/blob/images/blacktocat.png`,
  );
  await expect(
    main(page).getByText("This file is binary and can't be shown here.", { exact: true }),
  ).toBeVisible();
});
