import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isActiveSubmissionStatus } from '@devspace/shared';
import { Outlet, useMatch, useNavigate } from 'react-router';
import { notificationKeys } from '../lib/notifications';
import { queryKeys } from '../lib/projects';
import { useSubmission } from '../lib/submissions';
import { mayaApprovesInDemo, resetDemoState, subscribeDemoChanges } from './standIn';

/** An optional link from the build's settings: only full https:// addresses are used. */
export function externalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export const DEMO_REPO_URL = externalUrl(import.meta.env.VITE_DEMO_REPO_URL);
export const DEMO_VIDEO_URL = externalUrl(import.meta.env.VITE_DEMO_VIDEO_URL);

const bannerLink =
  'font-semibold underline decoration-warning-line underline-offset-2 hover:decoration-current focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:outline-none rounded-sm';

/** Shown on every page of the demo build: what this is, the links, and Reset demo. */
export function DemoBanner() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  function reset() {
    resetDemoState();
    void navigate('/');
    void queryClient.resetQueries();
  }

  return (
    <div
      role="region"
      aria-label="About this demo"
      data-testid="demo-banner"
      className="border-b border-warning-line bg-warning-soft text-sm text-warning-strong"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2">
        <p className="min-w-0 flex-1">
          <strong className="font-semibold">Demo with sample data.</strong> Nothing you do is saved.
          {(DEMO_REPO_URL || DEMO_VIDEO_URL) && ' '}
          {DEMO_REPO_URL && (
            <a
              href={DEMO_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={bannerLink}
            >
              See the code on GitHub
            </a>
          )}
          {DEMO_REPO_URL && DEMO_VIDEO_URL && ' · '}
          {DEMO_VIDEO_URL && (
            <a
              href={DEMO_VIDEO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={bannerLink}
            >
              Watch the video
            </a>
          )}
        </p>
        <button
          type="button"
          onClick={reset}
          className="shrink-0 rounded-lg border border-warning-line bg-surface px-2.5 py-1 text-xs font-semibold text-fg hover:bg-muted focus-visible:ring-4 focus-visible:ring-accent-ring/50 focus-visible:outline-none"
        >
          Reset demo
        </button>
      </div>
    </div>
  );
}

/**
 * Keep the pages up to date with demo changes that no request of theirs made: Maya's automatic
 * approval and the demo editor's saves. (The real app hears about these over its live connection.)
 */
function useDemoChangesRefresh() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      subscribeDemoChanges((projectIds) => {
        for (const projectId of projectIds) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
        }
        void queryClient.invalidateQueries({ queryKey: notificationKeys.list });
      }),
    [queryClient],
  );
}

/** On the visitor's own submission: Maya approves it by herself, so they can try Merge. */
function AutoApprovalNote({
  projectId,
  submissionId,
}: {
  projectId: string;
  submissionId: string;
}) {
  const submission = useSubmission(projectId, submissionId);
  const status = submission.data?.status;
  if (status === undefined || !isActiveSubmissionStatus(status)) return null;
  if (!mayaApprovesInDemo(projectId, submissionId)) return null;
  return (
    <div
      role="note"
      data-testid="demo-approval-note"
      className="border-b border-accent-line bg-accent-soft text-sm text-accent-strong"
    >
      <p className="mx-auto max-w-5xl px-4 py-2">
        {status === 'approved'
          ? 'In the demo, Maya approved it automatically so you can try Merge.'
          : 'In the demo, Maya approves automatically so you can try Merge.'}
      </p>
    </div>
  );
}

const REVIEW_PAGE = '/projects/:projectId/submissions/:submissionId';

/**
 * The root of every page in the demo: the banner, then the page. Unlike the normal root it opens
 * no live connection (there is no server to connect to), so live updates are simply off.
 */
export function DemoRoot() {
  useDemoChangesRefresh();
  const review = useMatch(REVIEW_PAGE);
  const projectId = review?.params.projectId;
  const submissionId = review?.params.submissionId;
  return (
    <>
      <DemoBanner />
      {projectId && submissionId && submissionId !== 'new' && (
        <AutoApprovalNote projectId={projectId} submissionId={submissionId} />
      )}
      <Outlet />
    </>
  );
}
