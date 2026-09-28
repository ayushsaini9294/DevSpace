import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  CommentResponseSchema,
  CopyChangesResponseSchema,
  SubmissionFileResponseSchema,
  SubmissionListResponseSchema,
  SubmissionResponseSchema,
  type CreateCommentRequest,
  type CreateReviewRequest,
  type CreateSubmissionRequest,
  type SubmissionDetail,
  type SubmissionStatus,
  type SubmissionViewerAction,
  type SuggestionDecisionRequest,
  type UpdateSubmissionRequest,
} from '@devspace/shared';
import { ApiError, apiFetch, apiPost } from './api';
import { errorMessage } from './formErrors';
import { queryKeys } from './projects';

const enc = encodeURIComponent;

export type SubmissionFilter = 'active' | 'all';

// Under the project's key, so refreshing a project refreshes its submissions too.
export const submissionKeys = {
  all: (projectId: string) => [...queryKeys.project(projectId), 'submissions'] as const,
  list: (projectId: string, filter: SubmissionFilter) =>
    [...submissionKeys.all(projectId), 'list', filter] as const,
  detail: (projectId: string, id: string) =>
    [...submissionKeys.all(projectId), 'detail', id] as const,
  file: (projectId: string, id: string, headSha: string, path: string) =>
    [...submissionKeys.detail(projectId, id), 'file', headSha, path] as const,
  changes: (projectId: string) => [...queryKeys.project(projectId), 'copy', 'changes'] as const,
  /** The task board (lib/tasks.ts): linked tasks move when submissions change. */
  tasks: (projectId: string) => [...queryKeys.project(projectId), 'tasks'] as const,
};

// ---------- URLs ----------

export function submissionsUrl(projectId: string): string {
  return `/projects/${projectId}/submissions`;
}

export function newSubmissionUrl(projectId: string): string {
  return `/projects/${projectId}/submissions/new`;
}

export function submissionUrl(projectId: string, id: string): string {
  return `/projects/${projectId}/submissions/${id}`;
}

export function updateSubmissionUrl(projectId: string, id: string): string {
  return `/projects/${projectId}/submissions/${id}/update`;
}

function api(projectId: string, rest: string): string {
  return `/api/projects/${enc(projectId)}${rest}`;
}

// ---------- Queries ----------

export function useSubmissions(projectId: string, filter: SubmissionFilter) {
  return useQuery({
    queryKey: submissionKeys.list(projectId, filter),
    queryFn: async () =>
      SubmissionListResponseSchema.parse(
        await apiFetch(api(projectId, `/submissions?status=${filter}`)),
      ).submissions,
  });
}

export function useSubmission(projectId: string, id: string) {
  return useQuery({
    queryKey: submissionKeys.detail(projectId, id),
    queryFn: async () =>
      SubmissionResponseSchema.parse(await apiFetch(api(projectId, `/submissions/${enc(id)}`)))
        .submission,
  });
}

/** One file's two sides, for the version whose head is `headSha` (a new version refetches). */
export function useSubmissionFile(
  projectId: string,
  id: string,
  headSha: string,
  path: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: submissionKeys.file(projectId, id, headSha, path),
    queryFn: async () =>
      SubmissionFileResponseSchema.parse(
        await apiFetch(api(projectId, `/submissions/${enc(id)}/file?path=${enc(path)}`)),
      ),
    enabled,
  });
}

/** The changed files in my copy. Always fresh: the member may have just edited them. */
export function useCopyChanges(projectId: string) {
  return useQuery({
    queryKey: submissionKeys.changes(projectId),
    queryFn: async () =>
      CopyChangesResponseSchema.parse(await apiFetch(api(projectId, '/copy/changes'))),
    gcTime: 0,
    staleTime: 0,
  });
}

// ---------- Mutations ----------

/** Store the fresh submission, then refresh the lists and the activity log. */
function submissionChanged(
  queryClient: QueryClient,
  projectId: string,
  submission: SubmissionDetail,
) {
  queryClient.setQueryData(submissionKeys.detail(projectId, submission.id), submission);
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: [...submissionKeys.all(projectId), 'list'],
    }),
    queryClient.invalidateQueries({ queryKey: submissionKeys.changes(projectId) }),
    queryClient.invalidateQueries({ queryKey: submissionKeys.tasks(projectId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.activity(projectId) }),
  ]);
}

function useSubmissionMutation<T>(projectId: string, request: (data: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: T) => SubmissionResponseSchema.parse(await request(data)).submission,
    onSuccess: (submission) => submissionChanged(queryClient, projectId, submission),
  });
}

export function useCreateSubmission(projectId: string) {
  return useSubmissionMutation(projectId, (data: CreateSubmissionRequest) =>
    apiPost(api(projectId, '/submissions'), data),
  );
}

export function useUpdateSubmission(projectId: string, id: string) {
  return useSubmissionMutation(projectId, (data: UpdateSubmissionRequest) =>
    apiPost(api(projectId, `/submissions/${enc(id)}/update`), data),
  );
}

export function useReviewSubmission(projectId: string, id: string) {
  return useSubmissionMutation(projectId, (data: CreateReviewRequest) =>
    apiPost(api(projectId, `/submissions/${enc(id)}/reviews`), data),
  );
}

export function useRejectSubmission(projectId: string, id: string) {
  return useSubmissionMutation(projectId, (reason: string) =>
    apiPost(api(projectId, `/submissions/${enc(id)}/reject`), { reason }),
  );
}

export function useCloseSubmission(projectId: string, id: string) {
  return useSubmissionMutation(projectId, () =>
    apiPost(api(projectId, `/submissions/${enc(id)}/close`)),
  );
}

/**
 * Merge or undo (Phase 7). Main moves, so besides this submission, refresh every submission
 * (others may now need an update), the repository, and my copy (it may now be behind). A 409
 * (e.g. `merge_conflict`, which sets Needs update) also re-reads this submission.
 */
function useMainMutation(projectId: string, id: string, action: 'merge' | 'revert') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      SubmissionResponseSchema.parse(
        await apiPost(api(projectId, `/submissions/${enc(id)}/${action}`)),
      ).submission,
    onSuccess: (submission) => {
      queryClient.setQueryData(submissionKeys.detail(projectId, submission.id), submission);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: submissionKeys.all(projectId) }),
        queryClient.invalidateQueries({
          queryKey: [...queryKeys.project(projectId), 'repository'],
        }),
        queryClient.invalidateQueries({ queryKey: [...queryKeys.project(projectId), 'copy'] }),
        queryClient.invalidateQueries({ queryKey: submissionKeys.tasks(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(projectId) }),
      ]);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        return queryClient.invalidateQueries({ queryKey: submissionKeys.detail(projectId, id) });
      }
    },
  });
}

export function useMergeSubmission(projectId: string, id: string) {
  return useMainMutation(projectId, id, 'merge');
}

export function useRevertSubmission(projectId: string, id: string) {
  return useMainMutation(projectId, id, 'revert');
}

export function useRespondSuggestion(projectId: string, id: string) {
  return useSubmissionMutation(
    projectId,
    ({ commentId, decision }: { commentId: string } & SuggestionDecisionRequest) =>
      apiPost(api(projectId, `/submissions/${enc(id)}/comments/${enc(commentId)}/suggestion`), {
        decision,
      }),
  );
}

/** Post a comment, then re-read the submission (comment counts and "outdated" come from there). */
export function useAddComment(projectId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateCommentRequest) =>
      CommentResponseSchema.parse(
        await apiPost(api(projectId, `/submissions/${enc(id)}/comments`), data),
      ).comment,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: submissionKeys.detail(projectId, id),
          exact: true,
        }),
        queryClient.invalidateQueries({ queryKey: [...submissionKeys.all(projectId), 'list'] }),
      ]),
  });
}

// ---------- Display ----------

export const STATUS_LABELS: Record<SubmissionStatus, string> = {
  open: 'Open',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  needs_update: 'Needs update',
  merged: 'Merged',
  rejected: 'Rejected',
  closed: 'Closed',
  reverted: 'Reverted',
};

export const STATUS_STYLES: Record<SubmissionStatus, string> = {
  open: 'bg-blue-50 text-blue-800 border-blue-200',
  changes_requested: 'bg-amber-50 text-amber-900 border-amber-300',
  approved: 'bg-green-50 text-green-800 border-green-300',
  needs_update: 'bg-amber-50 text-amber-900 border-amber-300',
  merged: 'bg-purple-50 text-purple-800 border-purple-200',
  rejected: 'bg-red-50 text-red-800 border-red-200',
  closed: 'bg-gray-100 text-gray-700 border-gray-300',
  reverted: 'bg-gray-100 text-gray-700 border-gray-300',
};

export const CHANGE_LABELS = { added: 'Added', modified: 'Modified', deleted: 'Deleted' } as const;

export function can(submission: SubmissionDetail, action: SubmissionViewerAction): boolean {
  return submission.viewerActions.includes(action);
}

/** Extra facts from a 409 `file_in_open_submission` or `no_changes`. */
export function errorDetails(error: unknown): { paths: string[]; submissionId: string | null } {
  const details = error instanceof ApiError ? error.errorResponse?.details : undefined;
  const paths = Array.isArray(details?.paths)
    ? details.paths.filter((p): p is string => typeof p === 'string')
    : [];
  const submissionId = typeof details?.submissionId === 'string' ? details.submissionId : null;
  return { paths, submissionId };
}

/** Clear words for the API's submission error codes; the server's message otherwise. */
export function submissionErrorMessage(error: unknown): string {
  const code = error instanceof ApiError ? error.errorResponse?.error : undefined;
  switch (code) {
    case 'no_copy':
      return 'You don’t have a copy of this project yet. Open the IDE once to make one, then change some files.';
    case 'no_changes': {
      const { paths } = errorDetails(error);
      return paths.length
        ? `These files no longer differ from main in your copy: ${paths.join(', ')}. Reload the list and pick again.`
        : 'Some of the picked files no longer differ from main in your copy. Reload the list and pick again.';
    }
    case 'file_in_open_submission': {
      const { paths } = errorDetails(error);
      return paths.length
        ? `These files are already in another of your open submissions: ${paths.join(', ')}.`
        : 'Some of these files are already in another of your open submissions.';
    }
    case 'submission_too_large':
      return 'This is too large to submit: at most 1,000 files, 10 MB per file and 100 MB in total (and copies with at most 20,000 files).';
    case 'submission_not_active':
      return 'This submission’s status has changed, so that can’t be done now. Reload the page to see its status.';
    case 'own_submission':
      return 'You can’t review your own submission.';
    case 'suggestion_stale':
      return 'Those lines in your copy have changed since this suggestion was made, so it can’t be applied. Change the file in the IDE instead, or reject the suggestion.';
    case 'suggestion_not_pending':
      return 'This suggestion was already accepted or rejected. Reload the page to see it.';
    case 'copy_changed':
      return 'A file in your copy changed while it was being read. Please try again.';
    case 'main_changed':
      return 'Main changed while this was running, so nothing was done. Please try again.';
    case 'approval_required':
      return 'This project needs an approval before merging: at least one current approval and no open change request.';
    case 'merge_conflict': {
      const { paths } = errorDetails(error);
      return paths.length
        ? `This submission now conflicts with main in: ${paths.join(', ')}. Its author needs to update it before it can be merged.`
        : 'This submission now conflicts with main. Its author needs to update it before it can be merged.';
    }
    case 'already_in_main':
      return 'Main already has these changes, so merging would change nothing.';
    case 'revert_conflict': {
      const { paths } = errorDetails(error);
      return paths.length
        ? `This merge can’t be undone: later merges changed the same lines in ${paths.join(', ')}. Main was not changed.`
        : 'This merge can’t be undone: later merges changed the same lines. Main was not changed.';
    }
    case 'task_done':
      return 'That task is already Done, so new work can’t be linked to it. Pick another task, or No task.';
    case 'forbidden':
      return 'You don’t have permission to do that.';
    case 'validation_error': {
      // e.g. "That line is not in the file": more useful than the general message.
      const fields = error instanceof ApiError ? error.errorResponse?.fields : undefined;
      const first = fields ? Object.values(fields).flat()[0] : undefined;
      return first ?? errorMessage(error);
    }
    default:
      if (error instanceof ApiError && error.status === 404) {
        return 'This submission or file no longer exists, or you are no longer in the project.';
      }
      return errorMessage(error);
  }
}
