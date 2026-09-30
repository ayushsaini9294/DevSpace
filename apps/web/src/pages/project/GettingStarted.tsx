import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { GettingStartedStep, GettingStartedStepId } from '@devspace/shared';
import { FormAlert } from '../../components/AuthPageShell';
import { HelpTip } from '../../components/HelpTip';
import { LoadError, buttonStyles, cardStyle, linkStyle } from '../../components/ui';
import { idePageUrl } from '../../lib/copies';
import { errorMessage } from '../../lib/formErrors';
import { useGettingStarted, useSetGettingStartedHidden } from '../../lib/gettingStarted';
import { filesUrl } from '../../lib/repository';
import { newSubmissionUrl, submissionsUrl } from '../../lib/submissions';

type StepText = {
  title: string;
  /** One line on how to do it. */
  how: string;
  /** Where to do it. */
  action: { label: string; to: (projectId: string) => string };
};

const STEPS: Record<GettingStartedStepId, StepText> = {
  setup: {
    title: 'Set up the project',
    how: 'Pick a starter template (or start empty). It becomes main, the team’s shared version.',
    action: { label: 'Set up the project', to: (id) => filesUrl(id, '') },
  },
  invite: {
    title: 'Invite a teammate',
    how: 'On the Members page, enter their email to make an invite link, then send it to them.',
    action: { label: 'Invite someone', to: (id) => `/projects/${id}/members` },
  },
  openIde: {
    title: 'Open your copy in the IDE',
    how: 'Your copy is your own space to work in. The IDE (VS Code in your browser) opens it.',
    // Labels differ from the overview's own "Open IDE" button, so each link has its own name.
    action: { label: 'Open your copy', to: idePageUrl },
  },
  change: {
    title: 'Change a file',
    how: 'In the IDE, open a file (for example README.md), change something and save it (Ctrl+S).',
    action: { label: 'Change a file in the IDE', to: idePageUrl },
  },
  preview: {
    title: 'Preview your app',
    how: 'Start the app in the IDE’s terminal (the README says how), then click Preview at the top.',
    action: { label: 'Start and preview in the IDE', to: idePageUrl },
  },
  submit: {
    title: 'Submit work',
    how: 'Submit work sends the changes you pick for review. Your copy stays as it is.',
    action: { label: 'Pick changes to submit', to: newSubmissionUrl },
  },
  reviewed: {
    title: 'Get a review',
    how: 'A teammate comments on or approves your work, and a leader merges it (adds it to main).',
    action: { label: 'See submissions', to: submissionsUrl },
  },
};

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-green-700">
      <circle cx="10" cy="10" r="9" fill="currentColor" />
      <path
        d="m6 10.5 2.5 2.5L14 7.5"
        fill="none"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function OpenCircle({ current }: { current: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={`h-5 w-5 shrink-0 ${current ? 'text-blue-700' : 'text-gray-400'}`}
    >
      <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Step({
  projectId,
  step,
  number,
  current,
}: {
  projectId: string;
  step: GettingStartedStep;
  number: number;
  current: boolean;
}) {
  const text = STEPS[step.id];
  return (
    <li
      data-testid="getting-started-step"
      data-step={step.id}
      data-done={step.done ? 'true' : 'false'}
      aria-current={current ? 'step' : undefined}
      className={`flex gap-3 rounded-md p-2 ${current ? 'bg-blue-50' : ''}`}
    >
      {step.done ? <CheckIcon /> : <OpenCircle current={current} />}
      <div className="min-w-0 flex-1 space-y-1">
        <p className={`font-medium ${step.done ? 'text-gray-600' : 'text-gray-900'}`}>
          {number}. {text.title}
          <span className="sr-only">{step.done ? ' (done)' : ' (not done yet)'}</span>
        </p>
        {!step.done && (
          <>
            <p className="text-sm text-gray-700">{text.how}</p>
            <Link
              to={text.action.to(projectId)}
              className={current ? `${buttonStyles.primary} py-1` : `${linkStyle} text-sm`}
            >
              {text.action.label}
            </Link>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * The getting-started checklist on the project overview (Phase 11): my steps, ticked by the
 * server from what I really did. It can be hidden and shown again; when every step is done it
 * says "You're all set!" once and hides itself.
 */
export function GettingStarted({ projectId }: { projectId: string }) {
  const checklist = useGettingStarted(projectId);
  const setHidden = useSetGettingStartedHidden(projectId);
  const headingId = useId();
  // "You're all set!" stays on screen after the card hides itself, until the page changes.
  const [celebrating, setCelebrating] = useState(false);
  const hidingDone = useRef(false);

  const view = checklist.data;
  const allDone = view !== undefined && view.steps.length > 0 && view.steps.every((s) => s.done);
  const { mutate } = setHidden;

  useEffect(() => {
    if (!view || view.hidden || !allDone || hidingDone.current) return;
    hidingDone.current = true;
    setCelebrating(true);
    mutate(true);
  }, [view, allDone, mutate]);

  if (checklist.isPending) return null;
  if (checklist.isError) {
    return (
      <LoadError
        what="your getting-started steps"
        error={checklist.error}
        onRetry={() => checklist.refetch()}
      />
    );
  }

  if (celebrating) {
    return (
      <section
        aria-labelledby={headingId}
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-green-300 bg-green-50 p-4"
      >
        <div>
          <h3 id={headingId} className="font-semibold text-green-900">
            Getting started
          </h3>
          <p role="status" className="text-green-900">
            You’re all set! You’ve done every step. Keep going: change, preview, submit.
          </p>
        </div>
        <button
          type="button"
          className={`${buttonStyles.secondary} py-1`}
          onClick={() => setCelebrating(false)}
        >
          Close
        </button>
      </section>
    );
  }

  if (checklist.data.hidden) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${buttonStyles.secondary} py-1`}
          disabled={setHidden.isPending}
          onClick={() => setHidden.mutate(false)}
        >
          Show getting started
        </button>
        {setHidden.isError && <FormAlert>{errorMessage(setHidden.error)}</FormAlert>}
      </div>
    );
  }

  const { steps } = checklist.data;
  const doneCount = steps.filter((s) => s.done).length;
  const currentId = steps.find((s) => !s.done)?.id ?? null;

  return (
    <section aria-labelledby={headingId} className={`${cardStyle} space-y-3`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 id={headingId} className="text-lg font-semibold">
              Getting started
            </h3>
            <HelpTip label="Getting started">
              These steps take you from your first change to your first reviewed work. Each one
              ticks itself when you really do it.
            </HelpTip>
          </div>
          <p className="text-sm text-gray-600">
            {doneCount} of {steps.length} done
          </p>
        </div>
        <button
          type="button"
          className={`${buttonStyles.secondary} py-1`}
          disabled={setHidden.isPending}
          onClick={() => setHidden.mutate(true)}
        >
          Hide getting started
        </button>
      </div>
      <ol className="space-y-1">
        {steps.map((step, index) => (
          <Step
            key={step.id}
            projectId={projectId}
            step={step}
            number={index + 1}
            current={step.id === currentId}
          />
        ))}
      </ol>
      {setHidden.isError && <FormAlert>{errorMessage(setHidden.error)}</FormAlert>}
    </section>
  );
}
