import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  acceptDialogs,
  createInviteLink,
  createLeaderWithProject,
  joinAsNewUser,
  newUserPage,
  projectNav,
  setUpLeaderAndMember,
  signUpAndExpectHome,
  uniqueUser,
  type User,
} from './helpers';

// Several users sign up and click through the app in each test, so allow more than the default.
test.describe.configure({ timeout: 90_000 });

/** The member's entry in the Members list. */
function memberRow(page: Page, user: User): Locator {
  return page.getByRole('listitem').filter({ hasText: user.email });
}

test('a leader invites a member, who joins and sees the project', async ({ page, browser }) => {
  acceptDialogs(page);

  // Leader (context A)
  const lp = await createLeaderWithProject(page);
  const member = uniqueUser();
  const inviteLink = await createInviteLink(page, member.email);

  // Member (context B): a separate browser context, logged out
  const memberPage = await newUserPage(browser);
  try {
    await joinAsNewUser(memberPage, inviteLink, member, lp);

    // The project is now on the member's home page.
    await memberPage.goto('/');
    await expect(
      memberPage.getByRole('heading', { level: 2, name: 'Your projects' }),
    ).toBeVisible();
    await expect(memberPage.getByRole('link', { name: lp.projectName, exact: true })).toBeVisible();

    // Back to the leader: the member is listed with role Member.
    await page.reload();
    const row = memberRow(page, member);
    await expect(row).toBeVisible();
    await expect(row).toContainText(member.name);
    await expect(row.getByText('Member', { exact: true })).toBeVisible();
    await expect(row).not.toContainText('Co-leader');

    // The activity log mentions the join.
    await projectNav(page, 'Activity').click();
    await expect(page).toHaveURL(/\/activity$/);
    const main = page.getByRole('main');
    await expect(main).toContainText(member.name);
    await expect(main).toContainText(/join/i);
  } finally {
    await memberPage.context().close();
  }
});

test('someone logged in with a different email cannot join and cannot see the project', async ({
  page,
  browser,
}) => {
  acceptDialogs(page);
  const lp = await createLeaderWithProject(page);
  const invited = uniqueUser();
  const inviteLink = await createInviteLink(page, invited.email);

  // Context C: a different user.
  const otherPage = await newUserPage(browser);
  try {
    const other = uniqueUser();
    await signUpAndExpectHome(otherPage, other);

    await otherPage.goto(inviteLink);
    await expect(otherPage.getByRole('main')).toContainText(invited.email);
    await expect(otherPage.getByRole('button', { name: 'Join project' })).toHaveCount(0);

    await otherPage.goto(lp.projectPath);
    await expect(otherPage.getByText('Project not found')).toBeVisible();
    await expect(otherPage.getByRole('heading', { level: 1, name: lp.projectName })).toHaveCount(0);

    // The invite link was not used up by the wrong account: the leader still sees it pending.
    await page.reload();
    await expect(page.getByRole('main')).toContainText(invited.email);
  } finally {
    await otherPage.context().close();
  }
});

test('a member has no leader controls; a permission switched on by the leader is saved', async ({
  page,
  browser,
}) => {
  const { lp, member, memberPage } = await setUpLeaderAndMember(page, browser);
  try {
    // Member: no Settings link, no invite form.
    await expect(projectNav(memberPage, 'Overview')).toBeVisible();
    await expect(projectNav(memberPage, 'Settings')).toHaveCount(0);
    await projectNav(memberPage, 'Members').click();
    await expect(memberPage).toHaveURL(/\/members$/);
    await expect(memberRow(memberPage, lp.leader)).toBeVisible();
    await expect(memberPage.getByRole('button', { name: 'Create invite link' })).toHaveCount(0);
    await expect(memberPage.getByLabel('Invite link', { exact: true })).toHaveCount(0);

    // Leader switches on "Comment" for the member.
    await page.reload();
    const row = memberRow(page, member);
    const comment = row.getByRole('checkbox', { name: 'Comment', exact: true });
    await expect(comment).not.toBeChecked();
    const saved = page.waitForResponse(
      (res) => res.request().method() === 'PATCH' && res.url().includes('/members/') && res.ok(),
    );
    // The checkbox reflects the saved value, so it flips once the API has answered.
    await comment.click();
    await saved;
    await expect(comment).toBeChecked();

    await page.reload();
    await expect(
      memberRow(page, member).getByRole('checkbox', { name: 'Comment', exact: true }),
    ).toBeChecked();
    await expect(
      memberRow(page, member).getByRole('checkbox', { name: 'Approve submissions', exact: true }),
    ).not.toBeChecked();
  } finally {
    await memberPage.context().close();
  }
});

test('a member promoted to co-leader gets the co-leader role and Settings', async ({
  page,
  browser,
}) => {
  const { lp, member, memberPage } = await setUpLeaderAndMember(page, browser);
  try {
    await expect(projectNav(memberPage, 'Settings')).toHaveCount(0);

    await page.reload();
    const row = memberRow(page, member);
    await expect(row).toBeVisible();
    const saved = page.waitForResponse(
      (res) => res.request().method() === 'PATCH' && res.url().includes('/members/') && res.ok(),
    );
    await row.getByRole('button', { name: 'Make co-leader', exact: true }).click();
    await saved;

    await page.reload();
    await expect(memberRow(page, member)).toContainText('Co-leader');

    await memberPage.goto(lp.projectPath);
    await expect(memberPage.getByRole('heading', { level: 1, name: lp.projectName })).toBeVisible();
    await expect(memberPage.getByText('Your role: Co-leader', { exact: true })).toBeVisible();
    await expect(projectNav(memberPage, 'Settings')).toBeVisible();
  } finally {
    await memberPage.context().close();
  }
});
