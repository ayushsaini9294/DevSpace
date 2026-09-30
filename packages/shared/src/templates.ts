import { z } from 'zod';

/**
 * Starter templates (Phase 11). The files live in `apps/api/templates/<id>/`; setting up a
 * repository from one makes the first commit on main with exactly those files.
 */
export const TEMPLATE_IDS = ['empty', 'html', 'express', 'react', 'fullstack', 'python'] as const;

export const TemplateIdSchema = z.enum(TEMPLATE_IDS);

/**
 * One template as the setup page shows it. `runHint` says in plain words how to run it in the
 * IDE terminal; `previewPort` is the port its app listens on (the Preview button's default),
 * or null when there is nothing to preview in a browser.
 */
export const TemplateViewSchema = z.object({
  id: TemplateIdSchema,
  name: z.string(),
  description: z.string(),
  runHint: z.string(),
  previewPort: z.number().int().nullable(),
});

/** GET /api/templates — any signed-in user. A plain array, in this order. */
export const TemplateListSchema = z.array(TemplateViewSchema);

export type TemplateId = z.infer<typeof TemplateIdSchema>;
export type TemplateView = z.infer<typeof TemplateViewSchema>;
export type TemplateList = z.infer<typeof TemplateListSchema>;

export const TEMPLATES: readonly TemplateView[] = [
  {
    id: 'empty',
    name: 'Empty',
    description: 'Only a README file. Start from nothing and add your own files.',
    runHint: 'Nothing to run yet.',
    previewPort: null,
  },
  {
    id: 'html',
    name: 'HTML/CSS/JS website',
    description: 'A simple web page with a style sheet and a script. No packages needed.',
    runHint: 'Run npm start, then click Preview (port 8080).',
    previewPort: 8080,
  },
  {
    id: 'express',
    name: 'Node.js (Express)',
    description: 'A small web server with a page and an /api/hello route.',
    runHint: 'Run npm install, then npm start, then click Preview (port 8080).',
    previewPort: 8080,
  },
  {
    id: 'react',
    name: 'React + Vite',
    description: 'A React app (JavaScript) that reloads as you type.',
    runHint: 'Run npm install, then npm run dev, then click Preview (port 5173).',
    previewPort: 5173,
  },
  {
    id: 'fullstack',
    name: 'Full-stack (React + Express)',
    description: 'A React front end that talks to an Express server.',
    runHint: 'Run npm install, then npm run dev (starts both), then click Preview (port 5173).',
    previewPort: 5173,
  },
  {
    id: 'python',
    name: 'Python',
    description: 'A friendly Python program that talks with you in the terminal.',
    runHint: 'Run python3 main.py in the terminal.',
    previewPort: null,
  },
];

export function templateById(id: TemplateId): TemplateView {
  const found = TEMPLATES.find((t) => t.id === id);
  if (!found) throw new Error(`Unknown template ${id}`);
  return found;
}
