import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  CreateInvitationRequestSchema,
  INVITATION_TTL_DAYS,
  canChangeRole,
  canLeave,
  canRemoveMember,
  canSetPermissions,
  type PermissionKey,
  type ProjectDetail,
  type ProjectMember,
  type User,
} from '@devspace/shared';
import { FormAlert } from '../../components/AuthPageShell';
import { TextField } from '../../components/TextField';
import {
  FocusHeading,
  LoadError,
  Loading,
  SuccessNote,
  buttonStyles,
  cardStyle,
} from '../../components/ui';
import { canOpenMemberCopies, memberIdePageUrl } from '../../lib/copies';
import { describeServerError, errorMessage } from '../../lib/formErrors';
import { PERMISSION_KEYS, PERMISSION_LABELS, ROLE_LABELS } from '../../lib/labels';
import {
  useCancelInvitation,
  useCreateInvitation,
  useInvitations,
  useLeaveProject,
  useMembers,
  useRemoveMember,
  useTransferOwnership,
  useUpdateMember,
} from '../../lib/projects';
import { useProjectContext } from './ProjectLayout';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

// ---------- Invite ----------

type CopyState = 'idle' | 'copied' | 'failed';

function InviteLink({ link, email }: { link: string; email: string }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<CopyState>('idle');

  // Put focus on the new link, selected, so it can be copied straight away.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function handleCopy() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard not available');
      await navigator.clipboard.writeText(link);
      setCopy('copied');
    } catch {
      setCopy('failed');
      inputRef.current?.select();
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-accent-line bg-accent-soft p-3">
      <label htmlFor={inputId} className="block text-sm font-medium text-fg">
        Invite link
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={inputRef}
          id={inputId}
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
          className="block w-full min-w-0 rounded-lg border border-line-strong bg-surface px-3 py-2 font-mono text-sm"
        />
        <button type="button" className={buttonStyles.secondary} onClick={handleCopy}>
          Copy link
        </button>
      </div>
      {copy === 'copied' && <SuccessNote>Copied</SuccessNote>}
      {copy === 'failed' && (
        <FormAlert>Couldn’t copy automatically. The link is selected; copy it yourself.</FormAlert>
      )}
      <p className="text-sm text-fg-soft">
        Send this link to {email}. It works only for that email address and expires in{' '}
        {INVITATION_TTL_DAYS} days.
      </p>
    </div>
  );
}

function InviteForm({ projectId }: { projectId: string }) {
  const createInvitation = useCreateInvitation(projectId);
  const [clientError, setClientError] = useState<string | undefined>();
  const [created, setCreated] = useState<{ link: string; email: string; key: string } | null>(null);
  const server = describeServerError(createInvitation.error, ['email'] as const);
  const fieldError = clientError ?? server.fieldErrors.email;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const raw = String(new FormData(form).get('email') ?? '');
    const result = CreateInvitationRequestSchema.safeParse({ email: raw });
    if (!result.success) {
      createInvitation.reset();
      setClientError(raw.trim() ? 'Enter a valid email address' : 'Enter an email address');
      const input = form.elements.namedItem('email');
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    setClientError(undefined);
    setCreated(null);
    createInvitation.mutate(result.data, {
      onSuccess: ({ invitation, path }) => {
        form.reset();
        setCreated({
          link: `${window.location.origin}${path}`,
          email: invitation.email,
          key: invitation.id,
        });
      },
    });
  }

  return (
    <section aria-labelledby="invite-heading" className={`${cardStyle} space-y-3`}>
      <h3 id="invite-heading" className="text-lg font-semibold">
        Invite someone
      </h3>
      <p className="text-sm text-fg-soft">
        Create a link for one email address, then send it to them yourself.
      </p>
      <form noValidate onSubmit={handleSubmit} className="space-y-3">
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="off"
          required
          error={fieldError}
          errorIsAlert={!clientError && Boolean(server.fieldErrors.email)}
        />
        {server.formError && !server.fieldErrors.email && <FormAlert>{server.formError}</FormAlert>}
        <button
          type="submit"
          disabled={createInvitation.isPending}
          aria-busy={createInvitation.isPending || undefined}
          className={buttonStyles.primary}
        >
          Create invite link
        </button>
      </form>
      {created && <InviteLink key={created.key} link={created.link} email={created.email} />}
    </section>
  );
}

function PendingInvitations({ projectId }: { projectId: string }) {
  const invitations = useInvitations(projectId, true);
  const cancel = useCancelInvitation(projectId);

  return (
    <section aria-labelledby="pending-heading" className={`${cardStyle} space-y-3`}>
      <h3 id="pending-heading" className="text-lg font-semibold">
        Pending invitations
      </h3>
      {cancel.isError && <FormAlert>{errorMessage(cancel.error)}</FormAlert>}
      {invitations.isPending ? (
        <Loading>Loading invitations…</Loading>
      ) : invitations.isError ? (
        <LoadError
          what="the invitations"
          error={invitations.error}
          onRetry={() => invitations.refetch()}
        />
      ) : invitations.data.length === 0 ? (
        <p className="text-fg-soft">No pending invitations.</p>
      ) : (
        <ul className="divide-y divide-line">
          {invitations.data.map((invitation) => (
            <li
              key={invitation.id}
              className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p id={`invitation-${invitation.id}`} className="font-medium break-all">
                  {invitation.email}
                </p>
                <p className="text-sm text-fg-muted">
                  Invited by {invitation.invitedByName} · expires{' '}
                  {dateFormat.format(new Date(invitation.expiresAt))}
                </p>
              </div>
              <button
                type="button"
                aria-describedby={`invitation-${invitation.id}`}
                disabled={cancel.isPending}
                className={buttonStyles.dangerOutline}
                onClick={() => {
                  if (
                    window.confirm(
                      `Cancel the invitation for ${invitation.email}? The link will stop working.`,
                    )
                  ) {
                    cancel.mutate(invitation.id);
                  }
                }}
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- Members ----------

function PermissionToggles({
  member,
  disabled,
  onChange,
}: {
  member: ProjectMember;
  disabled: boolean;
  onChange: (key: PermissionKey, value: boolean) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium text-fg">Permissions for {member.name}</legend>
      <div className="grid gap-1 sm:grid-cols-2">
        {PERMISSION_KEYS.map((key) => (
          <label key={key} className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={member.permissions[key]}
              disabled={disabled}
              onChange={(event) => onChange(key, event.currentTarget.checked)}
              className="h-4 w-4 rounded border-line-strong"
            />
            {PERMISSION_LABELS[key]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function MemberRow({
  member,
  project,
  me,
}: {
  member: ProjectMember;
  project: ProjectDetail;
  me: User;
}) {
  const update = useUpdateMember(project.id);
  const remove = useRemoveMember(project.id);
  const transfer = useTransferOwnership(project.id);
  const leave = useLeaveProject(project.id);

  const actor = project.myRole;
  const isMe = member.userId === me.id;
  const showRoleChange = !isMe && canChangeRole(actor, member.role);
  const showPermissions = !isMe && canSetPermissions(actor, member.role);
  const showRemove = !isMe && canRemoveMember(actor, member.role);
  const showTransfer = !isMe && project.allowedActions.includes('project.transferOwnership');
  const showLeave = isMe && canLeave(actor);
  // Leads may open any member's copy in the IDE (logged, and the member is told).
  const showOpenCopy = !isMe && canOpenMemberCopies(project);

  const busy = update.isPending || remove.isPending || transfer.isPending || leave.isPending;
  const failed = [update, remove, transfer, leave].find((m) => m.isError);
  const switchedOn = PERMISSION_KEYS.filter((key) => member.permissions[key]);

  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium break-words">
            {member.name}
            {isMe && <span className="text-fg-muted"> (you)</span>}
          </p>
          <p className="text-sm break-all text-fg-muted">{member.email}</p>
        </div>
        <span className="text-sm font-medium text-fg">{ROLE_LABELS[member.role]}</span>
      </div>

      {member.role === 'member' && !showPermissions && (
        <p className="text-sm text-fg-muted">
          Extra permissions:{' '}
          {switchedOn.length === 0
            ? 'none'
            : switchedOn.map((key) => PERMISSION_LABELS[key]).join(', ')}
        </p>
      )}

      {showPermissions && (
        <PermissionToggles
          member={member}
          disabled={busy}
          onChange={(key, value) =>
            update.mutate({ userId: member.userId, changes: { permissions: { [key]: value } } })
          }
        />
      )}

      {(showOpenCopy || showRoleChange || showRemove || showTransfer || showLeave) && (
        <div className="flex flex-wrap gap-2">
          {showOpenCopy && (
            <Link
              to={memberIdePageUrl(project.id, member.userId)}
              aria-label={`Open copy of ${member.name}`}
              className={buttonStyles.secondary}
            >
              Open copy
            </Link>
          )}
          {showRoleChange && (
            <button
              type="button"
              disabled={busy}
              className={buttonStyles.secondary}
              onClick={() =>
                update.mutate({
                  userId: member.userId,
                  changes: { role: member.role === 'member' ? 'co_leader' : 'member' },
                })
              }
            >
              {member.role === 'member' ? 'Make co-leader' : 'Make member'}
            </button>
          )}
          {showTransfer && (
            <button
              type="button"
              disabled={busy}
              className={buttonStyles.secondary}
              onClick={() => {
                if (
                  window.confirm(
                    `Make ${member.name} the leader of ${project.name}? You will become a co-leader and lose leader-only powers, such as deleting the project. Only the new leader can undo this.`,
                  )
                ) {
                  transfer.mutate(member.userId);
                }
              }}
            >
              Make leader
            </button>
          )}
          {showRemove && (
            <button
              type="button"
              disabled={busy}
              className={buttonStyles.dangerOutline}
              onClick={() => {
                if (window.confirm(`Remove ${member.name} from ${project.name}?`)) {
                  remove.mutate(member.userId);
                }
              }}
            >
              Remove
            </button>
          )}
          {showLeave && (
            <button
              type="button"
              disabled={busy}
              className={buttonStyles.dangerOutline}
              onClick={() => {
                if (
                  window.confirm(
                    `Leave ${project.name}? You will lose access until someone invites you again.`,
                  )
                ) {
                  leave.mutate(me.id);
                }
              }}
            >
              Leave project
            </button>
          )}
        </div>
      )}

      {failed && <FormAlert>{errorMessage(failed.error)}</FormAlert>}
    </li>
  );
}

export function MembersPage() {
  const { project, me } = useProjectContext();
  const members = useMembers(project.id);
  const canInvite = project.allowedActions.includes('members.invite');

  return (
    <section aria-labelledby="members-heading" className="space-y-4">
      <FocusHeading level={2}>
        <span id="members-heading">Members</span>
      </FocusHeading>

      {canInvite && <InviteForm projectId={project.id} />}

      <section aria-labelledby="member-list-heading" className={cardStyle}>
        <h3 id="member-list-heading" className="text-lg font-semibold">
          People in this project
        </h3>
        {members.isPending ? (
          <Loading>Loading members…</Loading>
        ) : members.isError ? (
          <LoadError what="the members" error={members.error} onRetry={() => members.refetch()} />
        ) : (
          <ul className="divide-y divide-line">
            {members.data.map((member) => (
              <MemberRow key={member.userId} member={member} project={project} me={me} />
            ))}
          </ul>
        )}
      </section>

      {canInvite && <PendingInvitations projectId={project.id} />}
    </section>
  );
}
