import { useState } from 'react';
import { Link } from 'react-router';
import type { SubmissionDetail } from '@devspace/shared';
import { FormAlert } from '../../../components/AuthPageShell';
import { linkStyle } from '../../../components/ui';
import { taskUrl } from '../../../lib/tasks';
import { ConfirmDonePrompt, TaskStatusBadge } from './parts';

/**
 * On the review page: the linked task and, for leads after the merge, "Mark this task done?".
 */
export function LinkedTaskPanel({
  projectId,
  submission,
}: {
  projectId: string;
  submission: SubmissionDetail;
}) {
  const [error, setError] = useState<string | null>(null);
  const task = submission.task;
  if (!task) return null;
  const asking = submission.viewerActions.includes('confirmTaskDone');
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-sm text-fg-soft">
        <span>
          Task:{' '}
          <Link to={taskUrl(projectId, task.id)} className={`${linkStyle} break-words`}>
            {task.title}
          </Link>
        </span>
        <TaskStatusBadge status={task.status} />
      </p>
      {asking && (
        <ConfirmDonePrompt projectId={projectId} taskId={task.id} onError={setError}>
          <p>This work is merged. Is “{task.title}” finished?</p>
        </ConfirmDonePrompt>
      )}
      {error && <FormAlert>{error}</FormAlert>}
    </div>
  );
}
