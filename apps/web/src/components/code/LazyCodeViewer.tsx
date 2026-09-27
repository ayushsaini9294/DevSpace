import { Suspense, lazy } from 'react';
import type { CodeViewerProps } from './CodeViewer';

// Monaco is large: it's split into its own chunk and loaded the first time code is shown.
const CodeViewer = lazy(() => import('./CodeViewer'));

/** A read-only code view, with a loading note while the editor downloads. */
export function LazyCodeViewer(props: CodeViewerProps) {
  return (
    <div data-testid="file-viewer" className="overflow-hidden rounded-md border border-gray-200">
      <Suspense
        fallback={
          <p role="status" className="p-3 text-sm text-gray-600">
            Loading editor…
          </p>
        }
      >
        <CodeViewer {...props} />
      </Suspense>
    </div>
  );
}
