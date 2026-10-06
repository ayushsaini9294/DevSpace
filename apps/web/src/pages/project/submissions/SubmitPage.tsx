import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  CreateSubmissionRequestSchema,
  type ChangedFile,
  type CreateSubmissionRequest,
  type SubmissionDetail,
  type UpdateSubmissionRequest,
} from '@devspace/shared';
import { FormAlert } from '../../../components/AuthPageShell';
import { HelpTip } from '../../../components/HelpTip';
import { TextField } from '../../../components/TextField';
import {
  FocusHeading,
  LoadError,
  Loading,
  buttonStyles,
  cardStyle,
  linkStyle,
} from '../../../components/ui';
import { idePageUrl } from '../../../lib/copies';
import { errorCode, isNotFound } from '../../../lib/formErrors';
import {
  submissionErrorMessage,
  submissionUrl,
  submissionsUrl,
  useCopyChanges,
  useCreateSubmission,
  useSubmission,
  useUpdateSubmission,
} from '../../../lib/submissions';
import { useProjectContext } from '../ProjectLayout';
import { ChangeLabel, TextArea } from './parts';
import { TaskSelect } from './TaskSelect';

type Field = 'title' | 'description' | 'paths';

/** The first message for each field from a failed check of the request. */
function checkRequest(values: { title: string; description: string; paths: string[] }) {
  const result = CreateSubmissionRequestSchema.safeParse(values);
  if (result.success) return { ok: true as const, data: result.data };
  const errors: Partial<Record<Field, string>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if ((field === 'title' || field === 'description' || field === 'paths') && !errors[field]) {
      errors[field] = issue.message;
    }
  }
  return { ok: false as const, errors };
}

function FileRow({
  projectId,
  file,
  locked,
  checked,
  onToggle,
}: {
  projectId: string;
  file: ChangedFile;
  locked: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={locked}
        onChange={onToggle}
        aria-describedby={locked ? noteId : undefined}
        className="h-4 w-4 shrink-0 border-line-strong"
      />
      <label
        htmlFor={id}
        className={`min-w-0 flex-1 font-mono text-sm break-all ${locked ? 'text-fg-muted' : 'text-fg'}`}
      >
        {file.path}
      </label>
      <ChangeLabel change={file.change} />
      {locked && file.openSubmissionId && (
        <p id={noteId} className="w-full pl-7 text-sm text-fg-muted">
          Locked: already in{' '}
          <Link to={submissionUrl(projectId, file.openSubmissionId)} className={linkStyle}>
            another open submission
          </Link>
          .
        </p>
      )}
    </li>
  );
}

function PickerForm({
  projectId,
  files,
  existing,
  initialTaskId,
}: {
  projectId: string;
  files: ChangedFile[];
  /** The submission being updated, or null for a new one. */
  existing: SubmissionDetail | null;
  /** A task picked beforehand (e.g. from the board), for a new submission. */
  initialTaskId: string;
}) {
  const navigate = useNavigate();
  const create = useCreateSubmission(projectId);
  const update = useUpdateSubmission(projectId, existing?.id ?? '');
  const mutation = existing ? update : create;

  // A file is locked when it's in one of my other active submissions.
  const isLocked = (file: ChangedFile) =>
    file.openSubmissionId !== null && file.openSubmissionId !== existing?.id;
  const [picked, setPicked] = useState<Set<string>>(() => {
    if (existing) {
      const current = new Set(existing.files.map((f) => f.path));
      return new Set(files.filter((f) => !isLocked(f) && current.has(f.path)).map((f) => f.path));
    }
    return new Set(files.filter((f) => !isLocked(f)).map((f) => f.path));
  });
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const originalTaskId = existing ? (existing.task?.id ?? '') : '';
  const [taskId, setTaskId] = useState(existing ? originalTaskId : initialTaskId);

  const changedPaths = new Set(files.map((f) => f.path));
  const noLongerChanged = existing
    ? existing.files.map((f) => f.path).filter((p) => !changedPaths.has(p))
    : [];
  const pickable = files.filter((f) => !isLocked(f));

  function toggle(path: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Keep the list's order.
    const paths = files.map((f) => f.path).filter((p) => picked.has(p));
    const checked = checkRequest({ title, description, paths });
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const onSuccess = (submission: SubmissionDetail) =>
      navigate(submissionUrl(projectId, submission.id));
    if (existing) {
      const changes: UpdateSubmissionRequest = { ...checked.data };
      // Send the link only when it changed: null unlinks, a missing field keeps it.
      if (taskId !== originalTaskId) changes.taskId = taskId || null;
      update.mutate(changes, { onSuccess });
    } else {
      const request: CreateSubmissionRequest = { ...checked.data };
      if (taskId) request.taskId = taskId;
      create.mutate(request, { onSuccess });
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="font-medium text-fg">Files to submit</legend>
        <p className="text-sm text-fg-muted">
          The files you changed in your copy (your own space to work in), compared with main (the
          team’s shared version). Only the ticked ones are sent for review; the rest stay in your
          copy.
        </p>
        {pickable.length > 1 && (
          <div className="flex gap-2">
            <button
              type="button"
              className={`${buttonStyles.secondary} py-1`}
              onClick={() => setPicked(new Set(pickable.map((f) => f.path)))}
            >
              Tick all
            </button>
            <button
              type="button"
              className={`${buttonStyles.secondary} py-1`}
              onClick={() => setPicked(new Set())}
            >
              Untick all
            </button>
          </div>
        )}
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {files.map((file) => (
            <FileRow
              key={file.path}
              projectId={projectId}
              file={file}
              locked={isLocked(file)}
              checked={picked.has(file.path)}
              onToggle={() => toggle(file.path)}
            />
          ))}
        </ul>
        <p role="status" className="text-sm text-fg-soft">
          {picked.size === 1 ? '1 file picked' : `${picked.size} files picked`}
        </p>
        {errors.paths && <p className="text-sm text-danger-fg">{errors.paths}</p>}
        {noLongerChanged.length > 0 && (
          <p className="text-sm text-fg-soft">
            No longer changed in your copy, so they will leave this submission:{' '}
            <span className="font-mono break-all">{noLongerChanged.join(', ')}</span>
          </p>
        )}
      </fieldset>
      <TextField
        label="Title"
        name="title"
        value={title}
        onChange={(event) => setTitle(event.currentTarget.value)}
        error={errors.title}
      />
      <TextArea
        label="Description"
        value={description}
        onChange={setDescription}
        error={errors.description}
      />
      <TaskSelect
        projectId={projectId}
        value={taskId}
        onChange={setTaskId}
        current={existing?.task ?? null}
      />
      {existing && (
        <p className="text-sm text-fg-soft">
          Updating makes version {existing.version + 1}. Earlier approvals and change requests stop
          counting, so reviewers need to look again.
        </p>
      )}
      {mutation.isError && <FormAlert>{submissionErrorMessage(mutation.error)}</FormAlert>}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={mutation.isPending}
          aria-busy={mutation.isPending || undefined}
          className={buttonStyles.primary}
        >
          {existing ? 'Update submission' : 'Submit'}
        </button>
        <Link
          to={existing ? submissionUrl(projectId, existing.id) : submissionsUrl(projectId)}
          className={buttonStyles.secondary}
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

function ChangesLoader({
  projectId,
  existing,
  initialTaskId = '',
}: {
  projectId: string;
  existing: SubmissionDetail | null;
  initialTaskId?: string;
}) {
  const changes = useCopyChanges(projectId);

  if (changes.isPending) return <Loading>Looking for changed files in your copy…</Loading>;
  if (changes.isError) {
    if (errorCode(changes.error) === 'no_copy') {
      return (
        <div className={`${cardStyle} space-y-2`}>
          <p className="text-fg-soft">
            You don’t have a copy of this project yet. Open the IDE to make one, change some files,
            then come back here.
          </p>
          <Link to={idePageUrl(projectId)} className={linkStyle}>
            Open IDE
          </Link>
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <FormAlert>{submissionErrorMessage(changes.error)}</FormAlert>
        <button type="button" className={buttonStyles.secondary} onClick={() => changes.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (changes.data.files.length === 0) {
    return (
      <div className={`${cardStyle} space-y-2`}>
        <p className="text-fg-soft">
          Nothing to submit yet: every file in your copy is the same as in main. Open the IDE,
          change a file and save it, then come back here.
        </p>
        <p className="text-sm text-fg-muted">
          Changed something already? DevSpace only sees saved files. A tab with a dot (●) instead of
          ✕ isn’t saved yet: click it and press Ctrl+S.
        </p>
        <Link to={idePageUrl(projectId)} className={linkStyle}>
          Open IDE
        </Link>
      </div>
    );
  }
  const lockedIn = [
    ...new Set(changes.data.files.map((f) => f.openSubmissionId).filter((id) => id !== null)),
  ];
  if (!existing && changes.data.files.every((f) => f.openSubmissionId !== null)) {
    return (
      <div className={`${cardStyle} space-y-2`}>
        <p className="text-fg-soft">
          Nothing new to submit: every changed file in your copy is already in one of your open
          submissions, and a file can be in only one at a time. To send newer edits of those files,
          open the submission and click Update. To start a new submission, change other files in the
          IDE.
        </p>
        <ul className="space-y-1">
          {lockedIn.map((id, index) => (
            <li key={id}>
              <Link to={submissionUrl(projectId, id)} className={linkStyle}>
                {lockedIn.length === 1 ? 'Your open submission' : `Open submission ${index + 1}`}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <PickerForm
      projectId={projectId}
      files={changes.data.files}
      existing={existing}
      initialTaskId={initialTaskId}
    />
  );
}

/** `/projects/:projectId/submissions/new`: pick changed files from my copy and submit them. */
export function NewSubmissionPage() {
  const { project } = useProjectContext();
  // `?task=<id>` preselects a task (the board links here).
  const [params] = useSearchParams();
  return (
    <section aria-labelledby="new-submission-heading" className="space-y-4">
      <div className="flex items-center gap-2">
        <FocusHeading level={2}>
          <span id="new-submission-heading">Submit work</span>
        </FocusHeading>
        <HelpTip term="submit" />
      </div>
      <p className="text-fg-soft">
        Send your changes for review. After a teammate approves them, a leader merges them (adds
        them to main).
      </p>
      <ChangesLoader
        projectId={project.id}
        existing={null}
        initialTaskId={params.get('task') ?? ''}
      />
    </section>
  );
}

/** `/projects/:projectId/submissions/:submissionId/update`: the same picker, pre-ticked. */
export function UpdateSubmissionPage() {
  const { project } = useProjectContext();
  const submissionId = useParams().submissionId ?? '';
  const submission = useSubmission(project.id, submissionId);

  let body;
  if (submission.isPending) {
    body = <Loading>Loading the submission…</Loading>;
  } else if (submission.isError) {
    body = isNotFound(submission.error) ? (
      <FormAlert>There is no submission at this address.</FormAlert>
    ) : (
      <LoadError
        what="the submission"
        error={submission.error}
        onRetry={() => submission.refetch()}
      />
    );
  } else if (!submission.data.viewerActions.includes('update')) {
    body = (
      <div className="space-y-2">
        <p className="text-fg-soft">
          Only the author can update this submission, and only while it’s open.
        </p>
        <Link to={submissionUrl(project.id, submissionId)} className={linkStyle}>
          Back to the submission
        </Link>
      </div>
    );
  } else {
    body = <ChangesLoader projectId={project.id} existing={submission.data} />;
  }

  return (
    <section aria-labelledby="update-submission-heading" className="space-y-4">
      <FocusHeading level={2}>
        <span id="update-submission-heading">Update submission</span>
      </FocusHeading>
      {body}
    </section>
  );
}
