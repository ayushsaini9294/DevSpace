import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AiConnectionViewSchema,
  AiConnectStartResponseSchema,
  AiModelListResponseSchema,
  AiNoticeAcceptResponseSchema,
  AiReviewListResponseSchema,
  DEVSPACE_FOLDER,
  IdeReviewResponseSchema,
  MAX_AI_DIFF_BYTES,
  MAX_IDE_REVIEW_DIFF_BYTES,
  type AiConnectFinishRequest,
  type AiConnectionView,
  type AiReviewView,
  type CreateAiReviewRequest,
  type IdeReviewResponse,
} from '@devspace/shared';
import { ApiError, apiDelete, apiFetch, apiPost } from './api';
import { errorMessage } from './formErrors';
import { usePollInterval } from './liveStore';
import { queryKeys } from './projects';
import { safeNext } from './safeNext';

const enc = encodeURIComponent;

/** While a review is queued or running, re-read the reviews this often (60 s while live). */
export const AI_REVIEW_POLL_MS = 5000;

export const AI_SETTINGS_URL = '/settings/ai';

export const aiKeys = {
  connection: ['ai', 'connection'] as const,
  models: ['ai', 'models'] as const,
  // Under the project's key, so refreshing a project refreshes its AI reviews too.
  reviews: (projectId: string, submissionId: string) =>
    [...queryKeys.project(projectId), 'ai-reviews', submissionId] as const,
};

function reviewsApi(projectId: string, submissionId: string, rest = ''): string {
  return `/api/projects/${enc(projectId)}/submissions/${enc(submissionId)}${rest}`;
}

// ---------- Connection ----------

/** GET /api/ai/connection: whether my OpenRouter account is connected, and my free requests. */
export function useAiConnection(enabled = true) {
  return useQuery({
    queryKey: aiKeys.connection,
    queryFn: async () => AiConnectionViewSchema.parse(await apiFetch('/api/ai/connection')),
    enabled,
  });
}

/** Full-page navigation away from the app (an object, so tests can replace it). */
export const browser = {
  leaveFor(url: string) {
    window.location.assign(url);
  },
};

/** POST /api/ai/openrouter/start, then leave for OpenRouter's login page (a full navigation). */
export function useStartAiConnect() {
  return useMutation({
    mutationFn: async () =>
      AiConnectStartResponseSchema.parse(await apiPost('/api/ai/openrouter/start')).url,
    onSuccess: (url) => {
      // The schema accepts only an absolute URL; only http(s) is ever followed.
      if (/^https?:\/\//i.test(url)) browser.leaveFor(url);
    },
  });
}

/** POST /api/ai/openrouter/finish with the code OpenRouter sent back. */
export function useFinishAiConnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: AiConnectFinishRequest) =>
      AiConnectionViewSchema.parse(await apiPost('/api/ai/openrouter/finish', request)),
    onSuccess: (connection) => queryClient.setQueryData(aiKeys.connection, connection),
  });
}

/** DELETE /api/ai/connection: forget my key. */
export function useDisconnectAi() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiDelete('/api/ai/connection');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: aiKeys.connection }),
  });
}

/** POST /api/ai/notice/accept: I have read the one-time AI notice. */
export function useAcceptAiNotice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      AiNoticeAcceptResponseSchema.parse(await apiPost('/api/ai/notice/accept')).noticeAcceptedAt,
    onSuccess: (noticeAcceptedAt) =>
      queryClient.setQueryData<AiConnectionView>(aiKeys.connection, (connection) =>
        connection ? { ...connection, noticeAcceptedAt } : connection,
      ),
  });
}

/** GET /api/ai/models: every OpenRouter model, for the Advanced picker. */
export function useAiModels(enabled: boolean) {
  return useQuery({
    queryKey: aiKeys.models,
    queryFn: async () => AiModelListResponseSchema.parse(await apiFetch('/api/ai/models')),
    enabled,
    staleTime: 10 * 60_000,
  });
}

// ---------- Reviews ----------

function isBusy(review: AiReviewView): boolean {
  return review.status === 'queued' || review.status === 'running';
}

/**
 * GET …/ai-reviews: the submission's AI reviews and grouped findings. Re-read every few seconds
 * while any review is queued or running (events refresh it too).
 */
export function useAiReviews(projectId: string, submissionId: string, enabled: boolean) {
  const interval = usePollInterval(AI_REVIEW_POLL_MS);
  return useQuery({
    queryKey: aiKeys.reviews(projectId, submissionId),
    queryFn: async () =>
      AiReviewListResponseSchema.parse(
        await apiFetch(reviewsApi(projectId, submissionId, '/ai-reviews')),
      ),
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (query.state.status === 'error' || !data) return false;
      return data.running || data.reviews.some(isBusy) ? interval : false;
    },
  });
}

/** POST …/ai-reviews: start a cross-review (the default free models, or the picked ones). */
export function useCreateAiReview(projectId: string, submissionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: CreateAiReviewRequest) =>
      AiReviewListResponseSchema.parse(
        await apiPost(reviewsApi(projectId, submissionId, '/ai-reviews'), request),
      ),
    onSuccess: (list) => {
      queryClient.setQueryData(aiKeys.reviews(projectId, submissionId), list);
      return queryClient.invalidateQueries({ queryKey: aiKeys.connection });
    },
    onError: (error) => {
      // e.g. another review is already running: show the current state.
      if (error instanceof ApiError && error.status === 409) {
        return queryClient.invalidateQueries({
          queryKey: aiKeys.reviews(projectId, submissionId),
        });
      }
    },
  });
}

/** POST …/ide-review: write the review folder into my copy. */
export function useIdeReview(projectId: string, submissionId: string) {
  return useMutation({
    mutationFn: async (): Promise<IdeReviewResponse> =>
      IdeReviewResponseSchema.parse(
        await apiPost(reviewsApi(projectId, submissionId, '/ide-review')),
      ),
  });
}

/** The IDE page to open after an IDE review: only an in-app `/projects/…/ide` path. */
export function safeIdePath(idePath: string, projectId: string): string {
  const fallback = `/projects/${projectId}/ide`;
  const safe = safeNext(idePath);
  return safe.startsWith('/projects/') && safe.endsWith('/ide') ? safe : fallback;
}

// ---------- Display ----------

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`;
}

/** Clear words for the API's AI error codes; the server's message otherwise. */
export function aiErrorMessage(error: unknown): string {
  const body = error instanceof ApiError ? error.errorResponse : null;
  switch (body?.error) {
    case 'ai_disabled':
      return 'AI review is turned off for this project. A leader can turn it on in the project’s Settings.';
    case 'not_connected':
      return 'Connect your OpenRouter account first, on the AI review settings page.';
    case 'notice_required':
      return 'Please read and accept the AI review notice first.';
    case 'paid_confirmation_required':
      return 'Some of the models you picked aren’t free and would use your OpenRouter credits. Tick “I understand this uses my OpenRouter credits” to go ahead.';
    case 'unknown_model': {
      const models = body.details?.models;
      const list = Array.isArray(models) ? models.filter((m) => typeof m === 'string') : [];
      return list.length
        ? `OpenRouter doesn’t offer these models: ${list.join(', ')}. Pick again.`
        : 'OpenRouter doesn’t offer one of the picked models. Pick again.';
    }
    case 'ai_review_running':
      return 'You already have an AI cross-review running on this submission. Wait for it to finish.';
    case 'submission_not_reviewable':
      return 'This submission is closed or rejected, so it can’t be reviewed by AI.';
    case 'too_large':
      return `This submission’s changes are too large to review this way (over ${kb(MAX_IDE_REVIEW_DIFF_BYTES)} of changes).`;
    case 'copy_changed':
      return `DevSpace couldn’t write the review folder: ${DEVSPACE_FOLDER} in your copy isn’t a normal folder. Remove or rename it in the IDE, then try again.`;
    case 'no_copy':
      return 'Your copy can’t be made yet because the project’s repository isn’t ready.';
    case 'invalid_state':
      return 'This connection link has expired or was already used. Start again with Connect OpenRouter.';
    case 'openrouter_error':
      return `OpenRouter didn’t accept the request: ${body.message}`;
    case 'forbidden':
      return 'You don’t have permission to use AI review in this project.';
    default:
      if (error instanceof ApiError && error.status === 404) {
        return 'This submission no longer exists, or you are no longer in the project.';
      }
      return errorMessage(error);
  }
}

/** Why a model's review failed, in clear words (the server's own words are shown as well). */
export function reviewFailureMessage(review: AiReviewView): string {
  switch (review.errorCode) {
    case 'too_large':
      return `The changes are too large to send to AI models (over ${kb(MAX_AI_DIFF_BYTES)}).`;
    case 'daily_limit':
      return 'OpenRouter’s free daily limit is used up (it resets at midnight UTC).';
    case 'rate_limited':
      return 'Every model was busy or rate limited. Try again in a minute.';
    case 'key_invalid':
      return 'OpenRouter refused your key. Connect your account again on the AI review settings page.';
    case 'no_credits':
      return 'This paid model needs OpenRouter credits, and your account has none left.';
    case 'not_connected':
      return 'Your OpenRouter account was disconnected before the review ran.';
    case 'models_failed':
      return 'Every model and fallback failed to answer.';
    case 'internal':
      return 'Something went wrong in DevSpace.';
    default:
      return 'The review failed.';
  }
}
