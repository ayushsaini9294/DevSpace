import { useCallback, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import './monacoSetup';
import { languageForPath } from './languages';
import { useMonacoTheme } from './useColorScheme';

export type CodeViewerProps = {
  /** The file's path in the repository; picks the language and names the model. */
  path: string;
  value: string;
};

const MIN_HEIGHT = 320;
/** Room left for the header, breadcrumb and file details above the editor. */
const PAGE_CHROME = 260;

function maxHeight() {
  return Math.max(240, window.innerHeight - PAGE_CHROME);
}

/**
 * A read-only Monaco editor sized to its content, up to the viewport. Loaded lazily through
 * LazyCodeViewer; the Phase 6 diff view reuses the same Monaco setup.
 */
export default function CodeViewer({ path, value }: CodeViewerProps) {
  const theme = useMonacoTheme();
  const [height, setHeight] = useState(MIN_HEIGHT);

  const onMount = useCallback<OnMount>((editor) => {
    const fit = () => {
      setHeight(Math.min(maxHeight(), Math.max(MIN_HEIGHT, editor.getContentHeight())));
    };
    fit();
    editor.onDidContentSizeChange(fit);
  }, []);

  return (
    <Editor
      height={height}
      path={path}
      value={value}
      language={languageForPath(path)}
      theme={theme}
      onMount={onMount}
      loading={<p className="p-3 text-sm text-fg-muted">Loading editor…</p>}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: 'off',
        renderLineHighlight: 'none',
        contextmenu: false,
        fontSize: 15,
        lineHeight: 24,
        padding: { top: 12, bottom: 12 },
        scrollbar: { alwaysConsumeMouseWheel: false },
      }}
    />
  );
}
