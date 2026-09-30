import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TemplateId } from '@devspace/shared';
import { writeBlob, writeTree, type NewTreeEntry } from '../git/repo.ts';

/**
 * The starter templates' files (Phase 11): `apps/api/templates/<id>/`, found from this file's
 * location (src/repository or dist/repository), not the cwd.
 */
export const TEMPLATES_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));

export function templateDir(id: TemplateId): string {
  return join(TEMPLATES_DIR, id);
}

/**
 * Writes one folder of a template into the bare repository `gitDir` as a tree, recursively,
 * and returns its id (null for a folder with no files, which git can't hold). Regular files
 * keep their executable bit (100755 vs 100644). Templates are our own files, so anything that
 * isn't a regular file or folder (a symlink, say) is a mistake and fails loudly.
 */
export async function writeFolderTree(gitDir: string, folder: string): Promise<string | null> {
  const entries: NewTreeEntry[] = [];
  const names = (await readdir(folder)).sort();
  for (const name of names) {
    const path = join(folder, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      const sha = await writeFolderTree(gitDir, path);
      if (sha) entries.push({ mode: '040000', type: 'tree', sha, name });
    } else if (info.isFile()) {
      const sha = await writeBlob(gitDir, await readFile(path));
      const mode = (info.mode & 0o111) !== 0 ? '100755' : '100644';
      entries.push({ mode, type: 'blob', sha, name });
    } else {
      throw new Error(`Template file ${path} is not a regular file or folder`);
    }
  }
  return entries.length > 0 ? writeTree(gitDir, entries) : null;
}
