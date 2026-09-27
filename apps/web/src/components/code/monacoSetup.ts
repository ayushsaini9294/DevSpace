/**
 * Monaco, bundled with the app (no CDN). Imported only by the lazily loaded editor
 * components, so pages without code never download it.
 */
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

// We only show one file at a time, without its imports or schemas: checking it would flag
// problems that aren't real (missing modules, comments in tsconfig.json). Colours only.
const noChecks = { noSemanticValidation: true, noSyntaxValidation: true };
monaco.typescript.typescriptDefaults.setDiagnosticsOptions(noChecks);
monaco.typescript.javascriptDefaults.setDiagnosticsOptions(noChecks);
monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: false });

loader.config({ monaco });

export { monaco };
