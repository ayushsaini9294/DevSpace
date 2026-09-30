import { Suspense, lazy } from 'react';
import type { DiffViewerProps } from './DiffViewer';

// Monaco is large: the diff view shares the code viewer's lazily loaded chunk.
const DiffViewer = lazy(() => import('./DiffViewer'));

/** A read-only diff of one file, with a loading note while the editor downloads. */
export function LazyDiffViewer(props: DiffViewerProps) {
  return (
    <div data-testid="diff-viewer" className="overflow-hidden rounded-md border border-gray-200">
      <Suspense
        fallback={
          <p role="status" className="p-3 text-sm text-gray-600">
            Loading the changes…
          </p>
        }
      >
        <DiffViewer {...props} />
      </Suspense>
    </div>
  );
}
