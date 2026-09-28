import {
  isActiveSubmissionStatus,
  type MergeBlocker,
  type ProjectSettings,
  type ReviewDecision,
  type SubmissionStatus,
} from '@devspace/shared';

/** Status math shared by submissions (Phase 6) and merging (Phase 7). */

export interface ReviewRow {
  reviewerId: string;
  decision: ReviewDecision;
  version: number;
  createdAt: Date;
}

export const reviewSelect = {
  reviewerId: true,
  decision: true,
  version: true,
  createdAt: true,
} as const;

/** Each reviewer's latest review on the current version (earlier versions' are stale). */
function latestCurrentReviews(reviews: readonly ReviewRow[], version: number): ReviewRow[] {
  const latest = new Map<string, ReviewRow>();
  for (const review of reviews) {
    if (review.version !== version) continue;
    const seen = latest.get(review.reviewerId);
    if (!seen || seen.createdAt <= review.createdAt) latest.set(review.reviewerId, review);
  }
  return [...latest.values()];
}

/** Any changes requested → changes_requested; otherwise any approval → approved; else open. */
export function statusFromReviews(
  reviews: readonly ReviewRow[],
  version: number,
): SubmissionStatus {
  const latest = latestCurrentReviews(reviews, version);
  if (latest.some((r) => r.decision === 'changes_requested')) return 'changes_requested';
  if (latest.some((r) => r.decision === 'approved')) return 'approved';
  return 'open';
}

export function approvalCount(reviews: readonly ReviewRow[], version: number): number {
  return latestCurrentReviews(reviews, version).filter((r) => r.decision === 'approved').length;
}

/** Why a submission can't be merged now (the same for every viewer), or null. */
export function mergeBlocker(
  status: SubmissionStatus,
  settings: ProjectSettings,
): MergeBlocker | null {
  if (!isActiveSubmissionStatus(status)) return 'not_active';
  if (status === 'needs_update') return 'needs_update';
  if (settings.requireApproval && status !== 'approved') return 'approval_required';
  return null;
}
