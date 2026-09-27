/** Monaco language ids by file extension (lower case, without the dot). */
const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  py: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
};

/** The Monaco language for a file path, from its name; `plaintext` when unknown. */
export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) {
    return 'dockerfile';
  }
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'plaintext';
  return BY_EXTENSION[name.slice(dot + 1)] ?? 'plaintext';
}
