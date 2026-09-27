import { Link, useNavigate, useParams } from 'react-router';
import type { InvitationPreviewResponse } from '@devspace/shared';
import { FormAlert } from '../components/AuthPageShell';
import {
  FocusHeading,
  LoadError,
  Loading,
  buttonStyles,
  cardStyle,
  linkStyle,
} from '../components/ui';
import { ApiError } from '../lib/api';
import { useCurrentUser, useLogOut } from '../lib/auth';
import { errorCode, errorMessage } from '../lib/formErrors';
import { useAcceptInvitation, useInvitePreview, useProjects } from '../lib/projects';

/** The heading for an invite that can't be used, or null for other failures. */
function deadInviteTitle(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = errorCode(error);
  if (error.status === 410 || code === 'invitation_expired') return 'This invite link has expired';
  if (code === 'invitation_used') return 'This invite link has already been used';
  if (error.status === 404) return 'This invite link isn’t valid';
  return null;
}

function DeadInvite({ title }: { title: string }) {
  return (
    <section className="space-y-4">
      <FocusHeading>{title}</FocusHeading>
      <p className="text-gray-700">Ask the project’s leader to send you a new invite link.</p>
      <Link to="/" className={linkStyle}>
        Go to your projects
      </Link>
    </section>
  );
}

/** You're already in the project: link to it when we can tell which one it is. */
function AlreadyMember({ preview }: { preview: InvitationPreviewResponse }) {
  const projects = useProjects();
  const matches = (projects.data ?? []).filter(
    (p) => p.name === preview.projectName && p.teamName === preview.teamName,
  );
  const project = matches.length === 1 ? matches[0] : undefined;
  return (
    <div role="alert" className="space-y-1 rounded-md border border-blue-200 bg-blue-50 p-3">
      <p className="text-gray-900">You’re already a member of {preview.projectName}.</p>
      {project ? (
        <Link to={`/projects/${project.id}`} className={linkStyle}>
          Open {project.name}
        </Link>
      ) : (
        <Link to="/" className={linkStyle}>
          Go to your projects
        </Link>
      )}
    </div>
  );
}

function WrongAccount({
  preview,
  myEmail,
  token,
}: {
  preview: InvitationPreviewResponse;
  myEmail: string;
  token: string;
}) {
  const logOut = useLogOut();
  const navigate = useNavigate();
  const next = `/invite/${token}`;
  return (
    <section className="space-y-4">
      <FocusHeading>This invite is for a different account</FocusHeading>
      <div className={`${cardStyle} space-y-3`}>
        <p className="text-gray-800">
          {preview.invitedByName} invited <strong className="break-all">{preview.email}</strong> to
          join {preview.projectName} in {preview.teamName}, but you’re logged in as{' '}
          <strong className="break-all">{myEmail}</strong>.
        </p>
        <p className="text-gray-700">
          Log out, then log in or sign up with {preview.email} to join.
        </p>
        {logOut.isError && <FormAlert>{errorMessage(logOut.error)}</FormAlert>}
        <button
          type="button"
          disabled={logOut.isPending}
          className={buttonStyles.primary}
          onClick={() =>
            logOut.mutate(undefined, {
              onSuccess: () => void navigate(`/login?next=${encodeURIComponent(next)}`),
            })
          }
        >
          Log out
        </button>
      </div>
    </section>
  );
}

export function InvitePage() {
  const token = useParams().token ?? '';
  const preview = useInvitePreview(token);
  const accept = useAcceptInvitation(token);
  const currentUser = useCurrentUser();
  const navigate = useNavigate();

  if (preview.isPending) return <Loading>Loading invitation…</Loading>;
  if (preview.isError) {
    const title = deadInviteTitle(preview.error);
    if (title) return <DeadInvite title={title} />;
    return (
      <LoadError what="this invitation" error={preview.error} onRetry={() => preview.refetch()} />
    );
  }

  const invite = preview.data;
  if (!invite.matchesYou) {
    return <WrongAccount preview={invite} myEmail={currentUser.data?.email ?? ''} token={token} />;
  }

  // The invite can also die between the preview and pressing Join.
  const deadTitle = accept.isError ? deadInviteTitle(accept.error) : null;
  if (deadTitle) return <DeadInvite title={deadTitle} />;
  const alreadyMember = accept.isError && errorCode(accept.error) === 'already_member';

  return (
    <section className="space-y-4">
      <FocusHeading>Join {invite.projectName}</FocusHeading>
      <div className={`${cardStyle} space-y-3`}>
        <p className="text-gray-800">
          {invite.invitedByName} invited you to join {invite.projectName} in {invite.teamName}
        </p>
        {alreadyMember ? (
          <AlreadyMember preview={invite} />
        ) : (
          <>
            <p className="text-sm text-gray-600">
              You’ll join as a member. The leader can give you more permissions later.
            </p>
            {accept.isError && <FormAlert>{errorMessage(accept.error)}</FormAlert>}
            <button
              type="button"
              disabled={accept.isPending}
              aria-busy={accept.isPending || undefined}
              className={buttonStyles.primary}
              onClick={() =>
                accept.mutate(undefined, {
                  onSuccess: (projectId) => void navigate(`/projects/${projectId}`),
                })
              }
            >
              Join project
            </button>
          </>
        )}
      </div>
    </section>
  );
}
