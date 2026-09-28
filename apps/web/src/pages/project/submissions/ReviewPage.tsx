import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  CreateCommentRequestSchema,
  RejectSubmissionRequestSchema,
  type Comment,
  type CreateCommentRequest,
  type DiffSide,
  type FileSide,
  type ReviewDecision,
  type SubmissionDetail,
  type SubmissionFile,
} from '@devspace/shared';
import { FormAlert } from '../../../components/AuthPageShell';
import type { LinePick } from '../../../components/code/DiffViewer';
import { LazyDiffViewer } from '../../../components/code/LazyDiffViewer';
import {
  FocusHeading,
  LoadError,
  Loading,
  buttonStyles,
  cardStyle,
  linkStyle,
} from '../../../components/ui';
import { isNotFound } from '../../../lib/formErrors';
import {
  can,
  submissionErrorMessage,
  submissionsUrl,
  updateSubmissionUrl,
  useAddComment,
  useCloseSubmission,
  useRejectSubmission,
  useRespondSuggestion,
  useReviewSubmission,
  useSubmission,
  useSubmissionFile,
} from '../../../lib/submissions';
import { formatWhen, fullDate } from '../../../lib/time';
import { useProjectContext } from '../ProjectLayout';
import {
  MergeBlockerNote,
  MergeDialog,
  MergeInfo,
  NeedsUpdatePanel,
  RevertDialog,
} from './MergeParts';
import { ChangeLabel, Dialog, StatusBadge, Tag, TextArea } from './parts';

/** Diffs open by default only for small submissions; bigger ones open file by file. */
const OPEN_DIFFS_UP_TO = 10;

const SIDE_LABELS: Record<DiffSide, string> = { base: 'old version', head: 'new version' };

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={fullDate.format(new Date(iso))}>
      {formatWhen(iso)}
    </time>
  );
}

function lineLabel(comment: Comment): string | null {
  if (comment.line === null || comment.side === null) return null;
  const start = comment.startLine ?? comment.line;
  const lines = start === comment.line ? `Line ${comment.line}` : `Lines ${start}–${comment.line}`;
  return `${lines} (${SIDE_LABELS[comment.side]})`;
}

/** First message of a failed check of a comment request, by field. */
function checkComment(request: CreateCommentRequest) {
  const result = CreateCommentRequestSchema.safeParse(request);
  if (result.success) return { ok: true as const, data: result.data };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? 'body');
    errors[key] ??= issue.message;
  }
  return { ok: false as const, errors };
}

// ---------- Comments ----------

type Ctx = { projectId: string; submission: SubmissionDetail };

function ReplyForm({ ctx, parentId }: { ctx: Ctx; parentId: string }) {
  const add = useAddComment(ctx.projectId, ctx.submission.id);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | undefined>();

  if (!open) {
    return (
      <button
        type="button"
        className={`${buttonStyles.secondary} py-1`}
        onClick={() => setOpen(true)}
      >
        Reply
      </button>
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checked = checkComment({ body, parentId });
    if (!checked.ok) {
      setError(checked.errors.body ?? Object.values(checked.errors)[0]);
      return;
    }
    setError(undefined);
    add.mutate(checked.data, {
      onSuccess: () => {
        setBody('');
        setOpen(false);
      },
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-2">
      <TextArea label="Reply" value={body} onChange={setBody} rows={3} error={error} autoFocus />
      {add.isError && <FormAlert>{submissionErrorMessage(add.error)}</FormAlert>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={add.isPending}
          aria-busy={add.isPending || undefined}
          className={`${buttonStyles.primary} py-1`}
        >
          Post reply
        </button>
        <button
          type="button"
          className={`${buttonStyles.secondary} py-1`}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Suggestion({ ctx, comment }: { ctx: Ctx; comment: Comment }) {
  const respond = useRespondSuggestion(ctx.projectId, ctx.submission.id);
  if (comment.suggestion === null) return null;
  const status = comment.suggestionStatus ?? 'pending';
  const canRespond = status === 'pending' && can(ctx.submission, 'respondSuggestion');

  return (
    <div className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-blue-900">
        Suggested change
        <Tag tone={status === 'pending' ? 'amber' : 'gray'}>
          {status === 'pending' ? 'Pending' : status === 'accepted' ? 'Accepted' : 'Rejected'}
        </Tag>
      </div>
      {comment.suggestion === '' ? (
        <p className="text-sm text-gray-800">Remove these lines.</p>
      ) : (
        <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-sm whitespace-pre text-gray-900">
          {comment.suggestion}
        </pre>
      )}
      {canRespond && (
        <>
          <p className="text-sm text-gray-700">
            Accepting writes this into your copy and updates the submission, so earlier approvals
            stop counting.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={respond.isPending}
              className={`${buttonStyles.primary} py-1`}
              onClick={() => respond.mutate({ commentId: comment.id, decision: 'accept' })}
            >
              Accept suggestion
            </button>
            <button
              type="button"
              disabled={respond.isPending}
              className={`${buttonStyles.secondary} py-1`}
              onClick={() => respond.mutate({ commentId: comment.id, decision: 'reject' })}
            >
              Reject suggestion
            </button>
          </div>
        </>
      )}
      {respond.isError && <FormAlert>{submissionErrorMessage(respond.error)}</FormAlert>}
    </div>
  );
}

function CommentBody({ comment }: { comment: Comment }) {
  return (
    <>
      <p className="text-sm text-gray-600">
        <span className="font-medium text-gray-900">{comment.author.name}</span> ·{' '}
        <When iso={comment.createdAt} /> · on version {comment.version}
      </p>
      <p className="break-words whitespace-pre-wrap text-gray-900">{comment.body}</p>
    </>
  );
}

function Thread({ ctx, comment, replies }: { ctx: Ctx; comment: Comment; replies: Comment[] }) {
  const where = lineLabel(comment);
  return (
    <article
      data-testid="comment-thread"
      aria-label={where ? `Comment on ${where}` : 'Comment'}
      className="space-y-2 rounded-md border border-gray-200 bg-white p-3"
    >
      {(where || comment.outdated) && (
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-800">
          {where}
          {comment.outdated && <Tag tone="amber">Outdated</Tag>}
        </div>
      )}
      <CommentBody comment={comment} />
      <Suggestion ctx={ctx} comment={comment} />
      {replies.length > 0 && (
        <ul className="space-y-2 border-l-2 border-gray-200 pl-3">
          {replies.map((reply) => (
            <li key={reply.id}>
              <CommentBody comment={reply} />
            </li>
          ))}
        </ul>
      )}
      {can(ctx.submission, 'comment') && <ReplyForm ctx={ctx} parentId={comment.id} />}
    </article>
  );
}

function Threads({
  ctx,
  threads,
  replies,
}: {
  ctx: Ctx;
  threads: Comment[];
  replies: Map<string, Comment[]>;
}) {
  return (
    <div className="space-y-3">
      {threads.map((comment) => (
        <Thread
          key={comment.id}
          ctx={ctx}
          comment={comment}
          replies={replies.get(comment.id) ?? []}
        />
      ))}
    </div>
  );
}

function GeneralCommentForm({ ctx }: { ctx: Ctx }) {
  const add = useAddComment(ctx.projectId, ctx.submission.id);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | undefined>();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checked = checkComment({ body });
    if (!checked.ok) {
      setError(checked.errors.body ?? Object.values(checked.errors)[0]);
      return;
    }
    setError(undefined);
    add.mutate(checked.data, { onSuccess: () => setBody('') });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-2">
      <TextArea label="Comment" value={body} onChange={setBody} rows={3} error={error} />
      {add.isError && <FormAlert>{submissionErrorMessage(add.error)}</FormAlert>}
      <button
        type="submit"
        disabled={add.isPending}
        aria-busy={add.isPending || undefined}
        className={buttonStyles.primary}
      >
        Add comment
      </button>
    </form>
  );
}

// ---------- Line comments ----------

function NumberField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
}) {
  return (
    <label className="block space-y-1 text-sm font-medium text-gray-800">
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="block w-28 rounded-md border border-gray-300 bg-white px-3 py-2 text-base shadow-sm focus:border-blue-600 focus:ring-2 focus:ring-blue-200 focus:outline-none"
      />
      {hint && <span className="block font-normal text-gray-600">{hint}</span>}
    </label>
  );
}

function LineCommentForm({
  ctx,
  path,
  pick,
  headLines,
  onDone,
}: {
  ctx: Ctx;
  path: string;
  pick: LinePick | null;
  /** The head side's lines, to start a suggestion from, or null when it isn't text. */
  headLines: string[] | null;
  onDone: () => void;
}) {
  const add = useAddComment(ctx.projectId, ctx.submission.id);
  const canSuggest = can(ctx.submission, 'suggest');
  const [side, setSide] = useState<DiffSide>(pick?.side ?? 'head');
  const [line, setLine] = useState(pick ? String(pick.line) : '');
  const [startLine, setStartLine] = useState(
    pick && pick.startLine !== pick.line ? String(pick.startLine) : '',
  );
  const [body, setBody] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const toNumber = (value: string) => (value.trim() === '' ? undefined : Number(value));

  function startSuggesting(on: boolean) {
    setSuggesting(on);
    if (on && suggestion === '' && headLines) {
      const end = toNumber(line);
      const start = toNumber(startLine) ?? end;
      if (start !== undefined && end !== undefined && start >= 1 && end >= start) {
        setSuggestion(headLines.slice(start - 1, end).join('\n'));
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request: CreateCommentRequest = { body, path, side, line: toNumber(line) as number };
    const start = toNumber(startLine);
    if (start !== undefined) request.startLine = start;
    if (suggesting && side === 'head') request.suggestion = suggestion;
    if (request.line === undefined || Number.isNaN(request.line)) {
      setErrors({ line: 'Enter a line number' });
      return;
    }
    const checked = checkComment(request);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    add.mutate(checked.data, { onSuccess: onDone });
  }

  const fieldError = errors.line ?? errors.startLine ?? errors.path ?? errors.side;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={`Comment on ${path}`}
      className="space-y-3 rounded-md border border-gray-200 bg-gray-50 p-3"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="block space-y-1 text-sm font-medium text-gray-800">
          <span>Side</span>
          <select
            value={side}
            onChange={(event) => setSide(event.currentTarget.value as DiffSide)}
            className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-base shadow-sm focus:border-blue-600 focus:ring-2 focus:ring-blue-200 focus:outline-none"
          >
            <option value="head">Head (new version)</option>
            <option value="base">Base (old version)</option>
          </select>
        </label>
        <NumberField label="Range starts at" value={startLine} onChange={setStartLine} />
        <NumberField label="Line" value={line} onChange={setLine} />
      </div>
      <p className="text-sm text-gray-600">
        Tip: click a line number in the diff to pick it, or select several lines. Leave “Range
        starts at” empty for one line.
      </p>
      {fieldError && <p className="text-sm text-red-700">{fieldError}</p>}
      <TextArea
        label="Comment"
        value={body}
        onChange={setBody}
        rows={3}
        error={errors.body}
        autoFocus
      />
      {canSuggest && side === 'head' && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-gray-800">
            <input
              type="checkbox"
              checked={suggesting}
              onChange={(event) => startSuggesting(event.currentTarget.checked)}
              className="h-4 w-4 border-gray-300"
            />
            Suggest a change to these lines
          </label>
          {suggesting && (
            <TextArea
              label="Suggested replacement"
              value={suggestion}
              onChange={setSuggestion}
              rows={4}
              error={errors.suggestion}
              mono
            />
          )}
        </div>
      )}
      {add.isError && <FormAlert>{submissionErrorMessage(add.error)}</FormAlert>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={add.isPending}
          aria-busy={add.isPending || undefined}
          className={buttonStyles.primary}
        >
          Add comment
        </button>
        <button type="button" className={buttonStyles.secondary} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------- Files ----------

function sideText(side: FileSide): string | null {
  if (side.kind === 'text') return side.content;
  if (side.kind === 'none') return '';
  return null;
}

function FileDiff({
  ctx,
  file,
  commented,
  onPick,
}: {
  ctx: Ctx;
  file: SubmissionFile;
  commented: { side: DiffSide; line: number }[];
  onPick: ((pick: LinePick) => void) | undefined;
}) {
  const { submission } = ctx;
  const diff = useSubmissionFile(ctx.projectId, submission.id, submission.headSha, file.path, true);

  if (diff.isPending) return <Loading>Loading the diff…</Loading>;
  if (diff.isError) {
    return (
      <div className="space-y-2">
        <FormAlert>Could not load this file. {submissionErrorMessage(diff.error)}</FormAlert>
        <button type="button" className={buttonStyles.secondary} onClick={() => diff.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  const { base, head } = diff.data;
  if (base.kind === 'binary' || head.kind === 'binary') {
    return <p className="text-sm text-gray-700">This file is binary, so it can’t be shown here.</p>;
  }
  if (base.kind === 'too_large' || head.kind === 'too_large') {
    return (
      <p className="text-sm text-gray-700">This file is too large to show here (over 1 MB).</p>
    );
  }
  return (
    <LazyDiffViewer
      path={file.path}
      base={sideText(base) ?? ''}
      head={sideText(head) ?? ''}
      commentedLines={commented}
      onPickLines={onPick}
    />
  );
}

function useHeadLines(ctx: Ctx, path: string, enabled: boolean): string[] | null {
  const { submission } = ctx;
  // Same query as the diff, so it's read from the cache.
  const diff = useSubmissionFile(ctx.projectId, submission.id, submission.headSha, path, enabled);
  return diff.data?.head.kind === 'text' ? diff.data.head.content.split('\n') : null;
}

function FileSection({
  ctx,
  file,
  index,
  threads,
  replies,
  startOpen,
}: {
  ctx: Ctx;
  file: SubmissionFile;
  index: number;
  threads: Comment[];
  replies: Map<string, Comment[]>;
  startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [form, setForm] = useState<{ key: number; pick: LinePick | null } | null>(null);
  const canComment = can(ctx.submission, 'comment');
  const headLines = useHeadLines(ctx, file.path, open);

  const commented = useMemo(
    () =>
      threads
        .filter((c) => !c.outdated && c.side !== null && c.line !== null)
        .map((c) => ({ side: c.side as DiffSide, line: c.line as number })),
    [threads],
  );

  const openForm = (pick: LinePick | null) =>
    setForm((current) => ({ key: (current?.key ?? 0) + 1, pick }));

  return (
    <section
      id={`file-${index}`}
      aria-label={file.path}
      className="scroll-mt-4 space-y-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 font-mono text-sm font-semibold break-all">{file.path}</h3>
        <ChangeLabel change={file.change} />
        <button
          type="button"
          aria-expanded={open}
          className={`${buttonStyles.secondary} py-1`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide diff' : 'Show diff'}
        </button>
      </header>
      {open && (
        <FileDiff
          ctx={ctx}
          file={file}
          commented={commented}
          onPick={canComment ? openForm : undefined}
        />
      )}
      {canComment &&
        (form ? (
          <LineCommentForm
            key={form.key}
            ctx={ctx}
            path={file.path}
            pick={form.pick}
            headLines={headLines}
            onDone={() => setForm(null)}
          />
        ) : (
          <button
            type="button"
            className={`${buttonStyles.secondary} py-1`}
            onClick={() => openForm(null)}
          >
            Comment on a line
          </button>
        ))}
      {threads.length > 0 && <Threads ctx={ctx} threads={threads} replies={replies} />}
    </section>
  );
}

// ---------- Actions ----------

type DialogKind = 'approved' | 'changes_requested' | 'reject' | 'close' | 'merge' | 'revert';

function ReviewDialog({
  ctx,
  decision,
  onClose,
}: {
  ctx: Ctx;
  decision: ReviewDecision;
  onClose: () => void;
}) {
  const review = useReviewSubmission(ctx.projectId, ctx.submission.id);
  const [body, setBody] = useState('');
  const approving = decision === 'approved';
  return (
    <Dialog
      title={approving ? 'Approve' : 'Request changes'}
      confirmLabel={approving ? 'Approve submission' : 'Request changes'}
      pending={review.isPending}
      error={review.isError ? submissionErrorMessage(review.error) : null}
      onClose={onClose}
      onSubmit={() =>
        review.mutate({ decision, ...(body.trim() ? { body } : {}) }, { onSuccess: onClose })
      }
    >
      <p className="text-sm text-gray-700">
        {approving
          ? `You approve version ${ctx.submission.version}. If the author updates it, your approval stops counting.`
          : 'Tell the author what to change. They can update the submission when they’re done.'}
      </p>
      <TextArea label="Comment (optional)" value={body} onChange={setBody} />
    </Dialog>
  );
}

function RejectDialog({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const reject = useRejectSubmission(ctx.projectId, ctx.submission.id);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();
  return (
    <Dialog
      title="Reject submission"
      confirmLabel="Reject submission"
      confirmStyle={buttonStyles.danger}
      pending={reject.isPending}
      error={reject.isError ? submissionErrorMessage(reject.error) : null}
      onClose={onClose}
      onSubmit={() => {
        const checked = RejectSubmissionRequestSchema.safeParse({ reason });
        if (!checked.success) {
          setError(checked.error.issues[0]?.message);
          return;
        }
        setError(undefined);
        reject.mutate(checked.data.reason, { onSuccess: onClose });
      }}
    >
      <p className="text-sm text-gray-700">
        The submission ends. The work stays in the author’s copy.
      </p>
      <TextArea label="Reason" value={reason} onChange={setReason} error={error} />
    </Dialog>
  );
}

function CloseDialog({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const close = useCloseSubmission(ctx.projectId, ctx.submission.id);
  return (
    <Dialog
      title="Close submission"
      confirmLabel="Close submission"
      pending={close.isPending}
      error={close.isError ? submissionErrorMessage(close.error) : null}
      onClose={onClose}
      onSubmit={() => close.mutate(undefined, { onSuccess: onClose })}
    >
      <p className="text-sm text-gray-700">
        The submission ends without merging. The work stays in the author’s copy, and its files can
        be submitted again.
      </p>
    </Dialog>
  );
}

function Actions({ ctx }: { ctx: Ctx }) {
  const { submission, projectId } = ctx;
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const close = () => setDialog(null);
  const buttons: ReactNode[] = [];

  if (can(submission, 'merge')) {
    buttons.push(
      <button
        key="merge"
        type="button"
        className={buttonStyles.primary}
        onClick={() => setDialog('merge')}
      >
        Merge
      </button>,
    );
  }
  if (can(submission, 'revert')) {
    buttons.push(
      <button
        key="revert"
        type="button"
        className={buttonStyles.dangerOutline}
        onClick={() => setDialog('revert')}
      >
        Undo merge
      </button>,
    );
  }

  if (can(submission, 'update')) {
    buttons.push(
      <Link
        key="update"
        to={updateSubmissionUrl(projectId, submission.id)}
        className={buttonStyles.secondary}
      >
        Update
      </Link>,
    );
  }
  if (can(submission, 'approve')) {
    buttons.push(
      <button
        key="approve"
        type="button"
        className={buttonStyles.primary}
        onClick={() => setDialog('approved')}
      >
        Approve
      </button>,
    );
  }
  if (can(submission, 'requestChanges')) {
    buttons.push(
      <button
        key="changes"
        type="button"
        className={buttonStyles.secondary}
        onClick={() => setDialog('changes_requested')}
      >
        Request changes
      </button>,
    );
  }
  if (can(submission, 'reject')) {
    buttons.push(
      <button
        key="reject"
        type="button"
        className={buttonStyles.dangerOutline}
        onClick={() => setDialog('reject')}
      >
        Reject
      </button>,
    );
  }
  if (can(submission, 'close')) {
    buttons.push(
      <button
        key="close"
        type="button"
        className={buttonStyles.secondary}
        onClick={() => setDialog('close')}
      >
        Close
      </button>,
    );
  }
  if (buttons.length === 0) return null;

  return (
    <>
      <div role="group" aria-label="Actions" className="flex flex-wrap gap-2">
        {buttons}
      </div>
      {(dialog === 'approved' || dialog === 'changes_requested') && (
        <ReviewDialog ctx={ctx} decision={dialog} onClose={close} />
      )}
      {dialog === 'reject' && <RejectDialog ctx={ctx} onClose={close} />}
      {dialog === 'close' && <CloseDialog ctx={ctx} onClose={close} />}
      {dialog === 'merge' && (
        <MergeDialog projectId={projectId} submission={submission} onClose={close} />
      )}
      {dialog === 'revert' && (
        <RevertDialog projectId={projectId} submission={submission} onClose={close} />
      )}
    </>
  );
}

function Reviews({ submission }: { submission: SubmissionDetail }) {
  if (submission.reviews.length === 0) {
    return <p className="text-sm text-gray-700">No reviews yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {submission.reviews.map((review) => (
        <li key={review.id} className="space-y-1 rounded-md border border-gray-200 bg-white p-3">
          <p className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
            <span className="font-medium text-gray-900">{review.reviewer.name}</span>
            {review.decision === 'approved' ? 'approved' : 'requested changes'} on version{' '}
            {review.version} · <When iso={review.createdAt} />
            {review.stale && <Tag>Stale: given before the latest update</Tag>}
          </p>
          {review.body && (
            <p className="break-words whitespace-pre-wrap text-gray-900">{review.body}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------- Page ----------

function Review({
  projectId,
  submission,
  isLead,
}: {
  projectId: string;
  submission: SubmissionDetail;
  /** A leader or co-leader, who could merge once nothing blocks it. */
  isLead: boolean;
}) {
  const ctx: Ctx = { projectId, submission };

  const { general, byPath, orphaned, replies } = useMemo(() => {
    const replies = new Map<string, Comment[]>();
    const general: Comment[] = [];
    const byPath = new Map<string, Comment[]>();
    const orphaned: Comment[] = [];
    const paths = new Set(submission.files.map((f) => f.path));
    for (const comment of submission.comments) {
      if (comment.parentId !== null) {
        replies.set(comment.parentId, [...(replies.get(comment.parentId) ?? []), comment]);
      } else if (comment.path === null) {
        general.push(comment);
      } else if (paths.has(comment.path)) {
        byPath.set(comment.path, [...(byPath.get(comment.path) ?? []), comment]);
      } else {
        orphaned.push(comment);
      }
    }
    return { general, byPath, orphaned, replies };
  }, [submission]);

  const startOpen = submission.files.length <= OPEN_DIFFS_UP_TO;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <p className="text-sm">
          <Link to={submissionsUrl(projectId)} className={linkStyle}>
            ← All submissions
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <FocusHeading level={2} className="min-w-0 text-xl font-semibold break-words">
            {submission.title}
          </FocusHeading>
          <StatusBadge status={submission.status} testId="submission-status" />
        </div>
        <p className="text-sm text-gray-600">
          By <span className="font-medium text-gray-900">{submission.author.name}</span> · version{' '}
          {submission.version} · opened <When iso={submission.createdAt} /> · updated{' '}
          <When iso={submission.updatedAt} />
        </p>
        {submission.description && (
          <p className="break-words whitespace-pre-wrap text-gray-900">{submission.description}</p>
        )}
        {submission.status === 'rejected' && submission.rejectReason && (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
            Rejected: <span className="whitespace-pre-wrap">{submission.rejectReason}</span>
          </p>
        )}
        <MergeInfo submission={submission} />
        <MergeBlockerNote submission={submission} isLead={isLead} />
        <Actions ctx={ctx} />
        <NeedsUpdatePanel projectId={projectId} submission={submission} />
      </header>

      <section aria-labelledby="reviews-heading" className="space-y-2">
        <h3 id="reviews-heading" className="text-lg font-semibold">
          Reviews
        </h3>
        <Reviews submission={submission} />
      </section>

      <section aria-labelledby="files-heading" className="space-y-3">
        <h3 id="files-heading" className="text-lg font-semibold">
          Files ({submission.files.length})
        </h3>
        <nav aria-label="Files in this submission" className={cardStyle}>
          <ul className="space-y-1">
            {submission.files.map((file, index) => {
              const count = byPath.get(file.path)?.length ?? 0;
              return (
                <li key={file.path} className="flex flex-wrap items-center gap-2">
                  <a href={`#file-${index}`} className={`${linkStyle} font-mono text-sm break-all`}>
                    {file.path}
                  </a>
                  <ChangeLabel change={file.change} />
                  {count > 0 && (
                    <span className="text-xs text-gray-600">
                      {count === 1 ? '1 comment' : `${count} comments`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        {submission.files.map((file, index) => (
          <FileSection
            // A new version starts the file's section afresh.
            key={`${submission.headSha}:${file.path}`}
            ctx={ctx}
            file={file}
            index={index}
            threads={byPath.get(file.path) ?? []}
            replies={replies}
            startOpen={startOpen}
          />
        ))}
      </section>

      {orphaned.length > 0 && (
        <section aria-labelledby="orphaned-heading" className="space-y-2">
          <h3 id="orphaned-heading" className="text-lg font-semibold">
            Comments on files no longer in this submission
          </h3>
          <Threads ctx={ctx} threads={orphaned} replies={replies} />
        </section>
      )}

      <section aria-labelledby="conversation-heading" className="space-y-3">
        <h3 id="conversation-heading" className="text-lg font-semibold">
          Conversation
        </h3>
        {general.length === 0 ? (
          <p className="text-sm text-gray-700">No general comments yet.</p>
        ) : (
          <Threads ctx={ctx} threads={general} replies={replies} />
        )}
        {can(submission, 'comment') && <GeneralCommentForm ctx={ctx} />}
      </section>
    </div>
  );
}

/** `/projects/:projectId/submissions/:submissionId`: the review page. */
export function ReviewPage() {
  const { project } = useProjectContext();
  const submissionId = useParams().submissionId ?? '';
  const submission = useSubmission(project.id, submissionId);

  if (submission.isPending) return <Loading>Loading the submission…</Loading>;
  if (submission.isError) {
    if (isNotFound(submission.error)) {
      return (
        <section className="space-y-3">
          <FocusHeading level={2}>Submission not found</FocusHeading>
          <p className="text-gray-700">There is no submission at this address.</p>
          <Link to={submissionsUrl(project.id)} className={linkStyle}>
            All submissions
          </Link>
        </section>
      );
    }
    return (
      <LoadError
        what="the submission"
        error={submission.error}
        onRetry={() => submission.refetch()}
      />
    );
  }
  return (
    <Review
      projectId={project.id}
      submission={submission.data}
      isLead={project.allowedActions.includes('submission.merge')}
    />
  );
}
