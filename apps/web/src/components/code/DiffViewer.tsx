import { useCallback, useEffect, useRef, useState } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { monaco } from './monacoSetup';
import { languageForPath } from './languages';
import type { DiffSide } from '@devspace/shared';
import { useMonacoTheme } from './useColorScheme';

/** Lines picked in the diff: one line (`startLine === line`) or a range on one side. */
export type LinePick = { side: DiffSide; startLine: number; line: number };

export type DiffViewerProps = {
  /** The file's path; picks the language and names the models. */
  path: string;
  /** The file before the change ('' when it didn't exist). */
  base: string;
  /** The file after the change ('' when it was deleted). */
  head: string;
  /** Lines that have comments, marked in the gutter. */
  commentedLines?: { side: DiffSide; line: number }[];
  /** A line number was clicked, or several lines were selected on one side. */
  onPickLines?: (pick: LinePick) => void;
};

const MIN_HEIGHT = 240;
const PAGE_CHROME = 220;

function maxHeight() {
  return Math.max(240, window.innerHeight - PAGE_CHROME);
}

type CodeEditor = monaco.editor.ICodeEditor;

/**
 * A read-only Monaco diff editor for one file of a submission. Clicking a line number picks
 * that line; selecting several lines picks the range (used for suggestions on the head side).
 * Loaded lazily through LazyDiffViewer, sharing the Monaco setup with the code viewer.
 */
export default function DiffViewer({
  path,
  base,
  head,
  commentedLines = [],
  onPickLines,
}: DiffViewerProps) {
  const theme = useMonacoTheme();
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [editors, setEditors] = useState<{ base: CodeEditor; head: CodeEditor } | null>(null);
  // The latest callback, so the listeners set up once on mount never go stale.
  const pickRef = useRef(onPickLines);
  useEffect(() => {
    pickRef.current = onPickLines;
  }, [onPickLines]);

  const onMount = useCallback<DiffOnMount>((diff) => {
    const baseEditor = diff.getOriginalEditor();
    const headEditor = diff.getModifiedEditor();
    const fit = () => {
      const content = Math.max(baseEditor.getContentHeight(), headEditor.getContentHeight());
      setHeight(Math.min(maxHeight(), Math.max(MIN_HEIGHT, content)));
    };
    fit();
    baseEditor.onDidContentSizeChange(fit);
    headEditor.onDidContentSizeChange(fit);

    const listen = (editor: CodeEditor, side: DiffSide) => {
      editor.onMouseDown((event) => {
        const { type, position } = event.target;
        const T = monaco.editor.MouseTargetType;
        if (
          position &&
          (type === T.GUTTER_LINE_NUMBERS ||
            type === T.GUTTER_GLYPH_MARGIN ||
            type === T.GUTTER_LINE_DECORATIONS)
        ) {
          pickRef.current?.({ side, startLine: position.lineNumber, line: position.lineNumber });
        }
      });
      editor.onMouseUp(() => {
        const selection = editor.getSelection();
        if (!selection || selection.isEmpty()) return;
        let end = selection.endLineNumber;
        // A selection that ends at the start of a line doesn't include that line.
        if (selection.endColumn === 1 && end > selection.startLineNumber) end -= 1;
        pickRef.current?.({ side, startLine: selection.startLineNumber, line: end });
      });
    };
    listen(baseEditor, 'base');
    listen(headEditor, 'head');
    setEditors({ base: baseEditor, head: headEditor });
  }, []);

  // Mark commented lines in the gutter.
  useEffect(() => {
    if (!editors) return;
    const collections = (['base', 'head'] as const).map((side) =>
      editors[side].createDecorationsCollection(
        commentedLines
          .filter((c) => c.side === side)
          .map((c) => ({
            range: new monaco.Range(c.line, 1, c.line, 1),
            options: {
              isWholeLine: true,
              linesDecorationsClassName: 'devspace-commented-line',
              linesDecorationsTooltip: 'Has comments',
            },
          })),
      ),
    );
    return () => collections.forEach((collection) => collection.clear());
  }, [editors, commentedLines]);

  const language = languageForPath(path);
  return (
    <DiffEditor
      height={height}
      original={base}
      modified={head}
      language={language}
      originalModelPath={`base/${path}`}
      modifiedModelPath={`head/${path}`}
      theme={theme}
      onMount={onMount}
      loading={<p className="p-3 text-sm text-gray-600">Loading diff…</p>}
      options={{
        readOnly: true,
        originalEditable: false,
        domReadOnly: true,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderLineHighlight: 'none',
        contextmenu: false,
        glyphMargin: false,
        fontSize: 14,
        lineHeight: 22,
        scrollbar: { alwaysConsumeMouseWheel: false },
      }}
    />
  );
}
