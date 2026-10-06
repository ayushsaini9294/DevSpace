import { useId, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  DEVSPACE_FOLDER,
  MAX_AI_MODELS_PER_REVIEW,
  type AiConnectionView,
  type AiFindingGroup,
  type AiReviewStatus,
  type AiReviewView,
  type AiSeverity,
  type CreateAiReviewRequest,
  type ProjectDetail,
  type SubmissionDetail,
} from '@devspace/shared';
import { FormAlert } from '../../../components/AuthPageShell';
import { LoadError, Loading, buttonStyles, linkStyle } from '../../../components/ui';
import {
  AI_SETTINGS_URL,
  aiErrorMessage,
  reviewFailureMessage,
  safeIdePath,
  useAcceptAiNotice,
  useAiConnection,
  useAiModels,
  useAiReviews,
  useCreateAiReview,
  useIdeReview,
} from '../../../lib/ai';
import { errorCode } from '../../../lib/formErrors';
import { Dialog, Tag } from './parts';

/*
 * Everything a model wrote (titles, details, raw answers, even paths) is untrusted: it is only
 * ever rendered as React text children, never as HTML or markdown.
 */

/** The most models shown in the Advanced picker at once (the rest are found by typing). */
const PICKER_LIMIT = 40;

const STATUS_LABELS: Record<AiReviewStatus, string> = {
  queued: 'Waiting',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

const STATUS_STYLES: Record<AiReviewStatus, string> = {
  queued: 'border-line-strong bg-muted text-fg-soft',
  running: 'border-accent-line bg-accent-soft text-accent-fg',
  done: 'border-success-line bg-success-soft text-success-fg',
  failed: 'border-danger-line bg-danger-soft text-danger-fg',
};

const SEVERITY_LABELS: Record<AiSeverity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const SEVERITY_STYLES: Record<AiSeverity, string> = {
  high: 'border-danger-line bg-danger-soft text-danger-fg',
  medium: 'border-warning-line bg-warning-soft text-warning-strong',
  low: 'border-line-strong bg-muted text-fg-soft',
};

function Pill({ className, children }: { className: string; children: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 text-xs font-semibold ${className}`}
    >
      {children}
    </span>
  );
}

function Severity({ severity }: { severity: AiSeverity }) {
  return (
    <Pill className={SEVERITY_STYLES[severity]}>{`${SEVERITY_LABELS[severity]} severity`}</Pill>
  );
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function linesLabel(group: AiFindingGroup): string {
  if (group.startLine === null) return 'No line given';
  if (group.endLine === null || group.endLine === group.startLine) return `Line ${group.startLine}`;
  return `Lines ${group.startLine}–${group.endLine}`;
}

// ---------- Status per model ----------

function ModelStatus({ review }: { review: AiReviewView }) {
  const fellBack = review.source === 'auto' && review.model !== review.requestedModel;
  return (
    <li
      data-testid="ai-model-status"
      data-status={review.status}
      className="space-y-1 rounded-lg border border-line bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-mono text-sm font-semibold break-all">{review.model}</span>
        <Pill className={STATUS_STYLES[review.status]}>{STATUS_LABELS[review.status]}</Pill>
        {review.isFree === true && <Tag>Free</Tag>}
        {review.isFree === false && <Tag tone="amber">Paid</Tag>}
        {review.source === 'ide' && <Tag>From the IDE</Tag>}
      </div>
      <p className="text-sm text-fg-muted">
        Asked by {review.requestedBy.name}
        {fellBack && (
          <>
            {' '}
            · answered instead of{' '}
            <span className="font-mono break-all">{review.requestedModel}</span>, which didn’t
            answer
          </>
        )}
      </p>
      {review.status === 'failed' && (
        <div className="space-y-1 text-sm text-danger-fg">
          <p>{reviewFailureMessage(review)}</p>
          {review.error && <p className="break-words whitespace-pre-wrap">{review.error}</p>}
        </div>
      )}
      {review.status === 'done' &&
        (review.parseError ? (
          <p className="text-sm text-warning-strong">
            The answer wasn’t in the expected format, so no findings could be read from it.
          </p>
        ) : (
          <p className="text-sm text-fg-soft">
            {plural(review.findings.length, 'finding', 'findings')}
          </p>
        ))}
      {review.raw !== null && review.parseError && (
        <details className="text-sm">
          <summary className="cursor-pointer text-fg-soft">Show the model’s answer</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-subtle p-2 font-mono text-xs whitespace-pre-wrap text-fg">
            {review.raw}
          </pre>
        </details>
      )}
    </li>
  );
}

// ---------- Findings ----------

function FindingGroup({ group }: { group: AiFindingGroup }) {
  const agreed = group.agreedBy.length >= 2;
  return (
    <li
      data-testid="ai-finding-group"
      data-agreed={agreed ? 'true' : 'false'}
      className={`space-y-2 rounded-md border p-3 ${
        agreed ? 'border-l-4 border-accent bg-accent-soft' : 'border-line bg-surface'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Severity severity={group.severity} />
        <span className="font-medium text-fg">{linesLabel(group)}</span>
        {agreed && (
          <span className="font-semibold text-accent-strong">
            Agreed by {group.agreedBy.length} models:{' '}
            <span className="font-mono font-normal break-all">{group.agreedBy.join(', ')}</span>
          </span>
        )}
      </div>
      <ul className="space-y-2">
        {group.findings.map((finding, index) => (
          <li
            key={`${finding.reviewId}:${index}`}
            className="space-y-1 border-t border-line pt-2 first:border-t-0 first:pt-0"
          >
            <p className="flex flex-wrap items-center gap-2">
              <strong className="break-words text-fg">{finding.title || '(no title)'}</strong>
              {finding.severity !== group.severity && <Severity severity={finding.severity} />}
              {finding.line !== null && group.startLine !== group.endLine && (
                <span className="text-sm text-fg-muted">line {finding.line}</span>
              )}
            </p>
            {finding.detail && (
              <p className="text-sm break-words whitespace-pre-wrap text-fg">{finding.detail}</p>
            )}
            <p className="text-xs text-fg-muted">
              From <span className="font-mono break-all">{finding.model}</span>
            </p>
          </li>
        ))}
      </ul>
    </li>
  );
}

function Findings({ groups }: { groups: AiFindingGroup[] }) {
  const byPath = useMemo(() => {
    const map = new Map<string, AiFindingGroup[]>();
    for (const group of groups) map.set(group.path, [...(map.get(group.path) ?? []), group]);
    return [...map.entries()];
  }, [groups]);
  const agreed = groups.filter((g) => g.agreedBy.length >= 2).length;

  return (
    <div data-testid="ai-findings" className="space-y-3">
      <p className="text-sm text-fg-soft">
        {plural(groups.length, 'place', 'places')} flagged
        {agreed > 0 && `, ${agreed} of them by 2 or more models (highlighted)`}. AI findings can be
        wrong: check each one yourself.
      </p>
      {byPath.map(([path, list]) => (
        <section key={path} aria-label={`AI findings in ${path}`} className="space-y-2">
          <h4 className="font-mono text-sm font-semibold break-all">{path}</h4>
          <ul className="space-y-2">
            {list.map((group) => (
              <FindingGroup
                key={`${group.startLine}:${group.findings[0]?.reviewId}`}
                group={group}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---------- Advanced picker ----------

function AdvancedPicker({
  busy,
  onRun,
}: {
  busy: boolean;
  onRun: (request: CreateAiReviewRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const models = useAiModels(open);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmPaid, setConfirmPaid] = useState(false);
  const findId = useId();

  const list = models.data?.models ?? [];
  const pickedModels = list.filter((m) => picked.includes(m.id));
  const anyPaid = pickedModels.some((m) => !m.isFree);
  const q = query.trim().toLowerCase();
  const shown = [
    ...pickedModels,
    ...list
      .filter((m) => !picked.includes(m.id))
      .filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      .slice(0, PICKER_LIMIT),
  ];
  const full = picked.length >= MAX_AI_MODELS_PER_REVIEW;

  function toggle(id: string, on: boolean) {
    setPicked((current) => (on ? [...current, id] : current.filter((m) => m !== id)));
  }

  return (
    <details
      className="rounded-md border border-line bg-subtle p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium text-fg">
        Advanced: choose models
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm text-fg-soft">
          Pick up to {MAX_AI_MODELS_PER_REVIEW} models instead of the free defaults. Paid models use
          your OpenRouter credits.
        </p>
        {models.isPending ? (
          <Loading>Loading OpenRouter’s models…</Loading>
        ) : models.isError ? (
          <div className="space-y-2">
            <FormAlert>Couldn’t load the models. {aiErrorMessage(models.error)}</FormAlert>
            <button
              type="button"
              className={buttonStyles.secondary}
              onClick={() => models.refetch()}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <label htmlFor={findId} className="block text-sm font-medium text-fg">
                Find a model
              </label>
              <input
                id={findId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                className="block w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-base shadow-card focus:border-accent focus:ring-4 focus:ring-accent-ring/40 focus:outline-none"
              />
            </div>
            <fieldset className="max-h-72 space-y-1 overflow-y-auto">
              <legend className="sr-only">Models</legend>
              {shown.length === 0 && <p className="text-sm text-fg-soft">No model matches.</p>}
              {shown.map((model) => {
                const checked = picked.includes(model.id);
                return (
                  <label key={model.id} className="flex items-start gap-2 text-sm text-fg">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && full}
                      onChange={(event) => toggle(model.id, event.currentTarget.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 border-line-strong"
                    />
                    <span className="min-w-0 break-all">
                      {model.name} <span className="font-mono text-fg-muted">({model.id})</span>{' '}
                      {model.isFree ? 'Free' : 'Paid'}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {anyPaid && (
              <div className="space-y-2 rounded-md border border-warning-line bg-warning-soft p-3">
                <p className="text-sm text-warning-strong">
                  You picked a paid model. This review uses your OpenRouter credits, and OpenRouter
                  charges you for it.
                </p>
                <label className="flex items-start gap-2 text-sm font-medium text-warning-strong">
                  <input
                    type="checkbox"
                    checked={confirmPaid}
                    onChange={(event) => setConfirmPaid(event.currentTarget.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 border-line-strong"
                  />
                  I understand this uses my OpenRouter credits
                </label>
              </div>
            )}
            <button
              type="button"
              disabled={busy || picked.length === 0 || (anyPaid && !confirmPaid)}
              className={buttonStyles.primary}
              onClick={() => onRun({ models: picked, ...(anyPaid ? { confirmPaid: true } : {}) })}
            >
              Cross-review with chosen models
            </button>
          </>
        )}
      </div>
    </details>
  );
}

// ---------- Actions ----------

type Pending = { kind: 'cross'; request: CreateAiReviewRequest } | { kind: 'ide' };

function NoticeDialog({
  pending,
  error,
  onAccept,
  onClose,
}: {
  pending: boolean;
  error: string | null;
  onAccept: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title="Before your first AI review"
      confirmLabel="I understand, continue"
      pending={pending}
      error={error}
      onClose={onClose}
      onSubmit={onAccept}
    >
      <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
        <li>
          AI review sends this submission’s changes (the code and its file names) to outside AI
          providers through your OpenRouter account.
        </li>
        <li>
          Free models may keep or learn from what they receive. Don’t use AI review on code you
          aren’t allowed to share.
        </li>
        <li>AI findings can be wrong. A person still reviews and approves the work.</li>
      </ul>
      <p className="text-sm text-fg-soft">You’ll only see this once.</p>
    </Dialog>
  );
}

function FreeLeft({ connection }: { connection: AiConnectionView }) {
  const free = connection.freeRequestsToday;
  if (!free) return null;
  return (
    <span>
      {' '}
      You have {free.remaining} of {free.limit} free requests left today.
    </span>
  );
}

function AiActions({
  projectId,
  submission,
  running,
}: {
  projectId: string;
  submission: SubmissionDetail;
  running: boolean;
}) {
  const connection = useAiConnection();
  const create = useCreateAiReview(projectId, submission.id);
  const ideReview = useIdeReview(projectId, submission.id);
  const acceptNotice = useAcceptAiNotice();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<Pending | null>(null);
  const [last, setLast] = useState<Pending | null>(null);

  function perform(action: Pending) {
    setLast(action);
    if (action.kind === 'cross') {
      ideReview.reset();
      create.mutate(action.request);
    } else {
      create.reset();
      ideReview.mutate(undefined, {
        onSuccess: (result) => navigate(safeIdePath(result.idePath, projectId)),
      });
    }
  }

  function start(action: Pending) {
    if (connection.data && connection.data.noticeAcceptedAt === null) setNotice(action);
    else perform(action);
  }

  function accept() {
    if (!notice) return;
    acceptNotice.mutate(undefined, {
      onSuccess: () => {
        setNotice(null);
        perform(notice);
      },
    });
  }

  const connected = connection.data?.connected === true;
  const busy = running || create.isPending;
  const failed = create.isError ? create.error : ideReview.isError ? ideReview.error : null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h4 className="font-semibold text-fg">Cross-review with AI</h4>
        {connection.isPending ? (
          <Loading>Checking your OpenRouter connection…</Loading>
        ) : connection.isError ? (
          <FormAlert>
            Couldn’t check your OpenRouter connection. {aiErrorMessage(connection.error)}
          </FormAlert>
        ) : !connected ? (
          <p className="text-sm text-fg-soft">
            To use AI review, first{' '}
            <Link to={AI_SETTINGS_URL} className={linkStyle}>
              connect your OpenRouter account
            </Link>
            .
          </p>
        ) : (
          <>
            <p className="text-sm text-fg-soft">
              Up to three free AI models review this version’s changes on their own, and places
              where they agree are highlighted.
              <FreeLeft connection={connection.data} />
            </p>
            <button
              type="button"
              disabled={busy}
              aria-busy={busy || undefined}
              className={buttonStyles.primary}
              onClick={() => start({ kind: 'cross', request: {} })}
            >
              Cross-review with AI
            </button>
            {running && (
              <p role="status" className="text-sm text-fg-soft">
                Your cross-review is running. Results appear below as each model finishes.
              </p>
            )}
            <AdvancedPicker busy={busy} onRun={(request) => start({ kind: 'cross', request })} />
          </>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="font-semibold text-fg">Review with my IDE AI</h4>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-fg">
          <li>
            DevSpace puts the changes and a review instruction into your own copy, in{' '}
            <code className="font-mono break-all">
              {DEVSPACE_FOLDER}/reviews/{submission.id}
            </code>{' '}
            (never submitted), and opens your IDE.
          </li>
          <li>
            Ask your IDE’s AI assistant to follow <code className="font-mono">REVIEW.md</code> and
            write its findings into <code className="font-mono">findings.md</code>.
          </li>
          <li>
            Run <strong>DevSpace: Send review findings</strong> from the Command Palette
            (Ctrl+Shift+P). The findings show up here.
          </li>
        </ol>
        <button
          type="button"
          disabled={ideReview.isPending || ideReview.isSuccess}
          aria-busy={ideReview.isPending || ideReview.isSuccess || undefined}
          className={buttonStyles.secondary}
          onClick={() => start({ kind: 'ide' })}
        >
          Review with my IDE AI
        </button>
      </div>

      {failed !== null && <FormAlert>{aiErrorMessage(failed)}</FormAlert>}
      {failed !== null && errorCode(failed) === 'notice_required' && last && (
        <button type="button" className={buttonStyles.secondary} onClick={() => setNotice(last)}>
          Read the notice
        </button>
      )}
      {notice && (
        <NoticeDialog
          pending={acceptNotice.isPending}
          error={acceptNotice.isError ? aiErrorMessage(acceptNotice.error) : null}
          onAccept={accept}
          onClose={() => {
            acceptNotice.reset();
            setNotice(null);
          }}
        />
      )}
    </div>
  );
}

// ---------- Section ----------

function Reviews({
  projectId,
  submission,
  canRequest,
}: {
  projectId: string;
  submission: SubmissionDetail;
  canRequest: boolean;
}) {
  const reviews = useAiReviews(projectId, submission.id, true);

  if (reviews.isPending) return <Loading>Loading AI reviews…</Loading>;
  if (reviews.isError) {
    if (errorCode(reviews.error) === 'ai_disabled') {
      return <p className="text-sm text-fg-soft">{aiErrorMessage(reviews.error)}</p>;
    }
    return (
      <LoadError what="the AI reviews" error={reviews.error} onRetry={() => reviews.refetch()} />
    );
  }

  const { version, groups, running } = reviews.data;
  const current = reviews.data.reviews.filter((r) => r.version === version);
  const older = reviews.data.reviews.filter((r) => r.version !== version);
  const anyDone = current.some((r) => r.status === 'done');

  return (
    <div className="space-y-4">
      {canRequest && <AiActions projectId={projectId} submission={submission} running={running} />}

      <div className="space-y-2">
        <h4 className="font-semibold text-fg">Models on version {version}</h4>
        {current.length === 0 ? (
          <p className="text-sm text-fg-soft">No AI reviews of this version yet.</p>
        ) : (
          <ul aria-label="AI review status per model" className="space-y-2">
            {current.map((review) => (
              <ModelStatus key={review.id} review={review} />
            ))}
          </ul>
        )}
        {older.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-fg-soft">
              {plural(older.length, 'review', 'reviews')} of earlier versions
            </summary>
            <ul className="mt-2 space-y-2">
              {older.map((review) => (
                <ModelStatus key={review.id} review={review} />
              ))}
            </ul>
          </details>
        )}
      </div>

      {groups.length > 0 ? (
        <div className="space-y-2">
          <h4 className="font-semibold text-fg">Findings</h4>
          <Findings groups={groups} />
        </div>
      ) : (
        anyDone && (
          <p className="text-sm text-fg-soft">The models found no problems in this version.</p>
        )
      )}
    </div>
  );
}

/** The review page's "AI review" section (Phase 10). */
export function AiReviewSection({
  project,
  submission,
}: {
  project: ProjectDetail;
  submission: SubmissionDetail;
}) {
  const enabled = project.settings.aiReviewEnabled;
  const allowed = project.allowedActions.includes('ai.crossReview');
  const reviewable = submission.status !== 'closed' && submission.status !== 'rejected';

  return (
    <section aria-labelledby="ai-review-heading" className="space-y-3">
      <h3 id="ai-review-heading" className="text-lg font-semibold">
        AI review
      </h3>
      {!enabled ? (
        <p className="text-sm text-fg-soft">
          AI review is off for this project.{' '}
          {project.allowedActions.includes('project.updateSettings') ? (
            <>
              You can turn it on in{' '}
              <Link to={`/projects/${project.id}/settings`} className={linkStyle}>
                Settings
              </Link>
              .
            </>
          ) : (
            'A leader can turn it on in the project’s Settings.'
          )}
        </p>
      ) : (
        <>
          {!allowed && (
            <p className="text-sm text-fg-soft">
              You don’t have permission to ask for AI reviews in this project, but you can read
              them.
            </p>
          )}
          {allowed && !reviewable && (
            <p className="text-sm text-fg-soft">
              This submission is {submission.status === 'closed' ? 'closed' : 'rejected'}, so it
              can’t be reviewed by AI any more.
            </p>
          )}
          <Reviews
            projectId={project.id}
            submission={submission}
            canRequest={allowed && reviewable}
          />
        </>
      )}
    </section>
  );
}
