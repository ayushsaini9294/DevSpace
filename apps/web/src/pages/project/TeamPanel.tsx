import { useEffect, useId, useState } from 'react';
import type { PresenceState, PresenceView } from '@devspace/shared';
import { errorMessage } from '../../lib/formErrors';
import { PRESENCE_LABELS, presenceFileText, sortPresence, usePresence } from '../../lib/presence';
import { formatWhen, fullDate } from '../../lib/time';

const DOT_STYLES: Record<PresenceState, string> = {
  active: 'bg-green-600',
  online: 'bg-blue-500',
  offline: 'border border-gray-400 bg-white',
};

/** Re-render every minute, so "last seen 3 minutes ago" stays true. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function MemberRow({ member, me, now }: { member: PresenceView; me: boolean; now: number }) {
  const fileText = presenceFileText(member);
  // A lead in someone's copy who shares no file: still say whose copy.
  const where =
    fileText === null && member.state === 'active' && member.copyOwner
      ? `in ${member.copyOwner.name}’s copy`
      : null;

  return (
    <li
      data-testid="presence-member"
      data-state={member.state}
      className="flex min-w-0 items-start gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
    >
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT_STYLES[member.state]}`}
      />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium break-words text-gray-900">
            {member.user.name}
            {me && <span className="font-normal text-gray-600"> (you)</span>}
          </span>
          <span data-testid="presence-state" className="text-xs text-gray-700">
            {PRESENCE_LABELS[member.state]}
          </span>
        </p>
        {fileText !== null && (
          <p
            data-testid="presence-file"
            className="truncate font-mono text-xs text-gray-800"
            title={fileText}
          >
            {fileText}
          </p>
        )}
        {where !== null && <p className="truncate text-xs text-gray-700">{where}</p>}
        {member.state === 'offline' && (
          <p data-testid="presence-last-seen" className="text-xs text-gray-600">
            {member.lastSeenAt ? (
              <>
                last seen{' '}
                <time
                  dateTime={member.lastSeenAt}
                  title={fullDate.format(new Date(member.lastSeenAt))}
                >
                  {formatWhen(member.lastSeenAt, now)}
                </time>
              </>
            ) : (
              'not seen yet'
            )}
          </p>
        )}
      </div>
    </li>
  );
}

/** Who is in the project right now, and what they have open (updated live). */
export function TeamPanel({ projectId, myId }: { projectId: string; myId: string }) {
  const presence = usePresence(projectId);
  const headingId = useId();
  const now = useMinuteClock();

  let body;
  if (presence.isPending) {
    body = (
      <p role="status" className="text-sm text-gray-600">
        Loading who’s here…
      </p>
    );
  } else if (presence.isError) {
    body = (
      <p className="text-sm text-gray-700">
        Couldn’t load who’s here. {errorMessage(presence.error)}{' '}
        <button
          type="button"
          className="font-medium text-blue-700 underline hover:text-blue-900"
          onClick={() => presence.refetch()}
        >
          Try again
        </button>
      </p>
    );
  } else {
    body = (
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {sortPresence(presence.data, myId).map((member) => (
          <MemberRow key={member.user.id} member={member} me={member.user.id === myId} now={now} />
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h2 id={headingId} className="text-sm font-semibold text-gray-700">
        Team
      </h2>
      {body}
    </section>
  );
}
