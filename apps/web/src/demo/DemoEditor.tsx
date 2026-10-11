import { useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
// Bundled Monaco (no CDN): this import must stay, it runs the setup.
import '../components/code/monacoSetup';
import type { monaco } from '../components/code/monacoSetup';
import { languageForPath } from '../components/code/languages';
import { useMonacoTheme } from '../components/code/useColorScheme';

export type DemoEditorProps = {
  /** The file's path in the copy; picks the language. */
  path: string;
  /** The file's text when it's opened, or when `revision` changes. */
  value: string;
  /**
   * Goes up when the text changes from outside the editor (Undo my edits), so the editor takes
   * `value` again. Typing never needs it: the editor keeps its own text while you type.
   */
  revision: number;
  /** The text of a file changed by typing (the path of the file that was typed in). */
  onChange: (path: string, value: string) => void;
};

/**
 * The demo IDE's editor: an editable Monaco with the app's Monaco setup (bundled, no CDN) and
 * theme. Loaded lazily, so Monaco downloads only when the editor is shown.
 */
export default function DemoEditor({ path, value, revision, onChange }: DemoEditorProps) {
  const theme = useMonacoTheme();
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  /** Show `text` if the editor has something else (keeping Ctrl+Z working). */
  function take(text: string) {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || model.getValue() === text) return;
    editor.pushUndoStop();
    editor.executeEdits('demo', [{ range: model.getFullModelRange(), text }]);
    editor.pushUndoStop();
  }

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    take(latest.current);
  };

  // A file opened again (its model may still hold old text) or changed from outside.
  useEffect(() => {
    take(latest.current);
  }, [path, revision]);

  return (
    <Editor
      height="100%"
      // Its own model names, so they never mix with the read-only viewers' models of main.
      path={`demo-copy/${path}`}
      // Uncontrolled: a controlled value can drop keys typed while React catches up.
      defaultValue={value}
      language={languageForPath(path)}
      theme={theme}
      onMount={onMount}
      onChange={(next) => {
        // The file the text belongs to, from the editor itself: never mixed up while switching.
        const uri = editorRef.current?.getModel()?.uri.path ?? '';
        const file = uri.replace(/^\/?demo-copy\//, '');
        if (file !== '' && file !== uri) onChange(file, next ?? '');
      }}
      loading={<p className="p-3 text-sm text-fg-muted">Loading editor…</p>}
      options={{
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: 'on',
        tabSize: 2,
        fontSize: 14,
        lineHeight: 22,
        padding: { top: 12, bottom: 12 },
        ariaLabel: `Edit ${path}`,
      }}
    />
  );
}
