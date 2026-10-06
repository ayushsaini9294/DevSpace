import { Suspense, lazy } from 'react';
import type { DiffViewerProps } from './DiffViewer';

// Monaco is large: the diff view shares the code viewer's lazily loaded chunk.
const DiffViewer = lazy(() => import('./DiffViewer'));

/** A read-only diff of one file, with a loading note while the editor downloads. */
export function LazyDiffViewer(props: DiffViewerProps) {
  return (
    <div data-testid="diff-viewer" className="overflow-hidden rounded-md border border-line">
      <Suspense
        fallback={
          <p role="status" className="p-3 text-sm text-fg-muted">
            Loading the changes…
          </p>
        }
      >
        <DiffViewer {...props} />
      </Suspense>
    </div>
  );
}
