import { useQuery } from '@tanstack/react-query';
import { TemplateListSchema, type TemplateId, type TemplateView } from '@devspace/shared';
import { apiFetch } from './api';

export const templateKeys = { all: ['templates'] as const };

/** GET /api/templates: the starter templates, in the order the setup page shows them. */
export function useTemplates(enabled = true) {
  return useQuery({
    queryKey: templateKeys.all,
    queryFn: async () => TemplateListSchema.parse(await apiFetch('/api/templates')),
    // Fixed for the life of the server.
    staleTime: Infinity,
    enabled,
  });
}

/** One template from a loaded list, or null. */
export function findTemplate(
  templates: readonly TemplateView[] | undefined,
  id: TemplateId | null,
): TemplateView | null {
  if (!templates || id === null) return null;
  return templates.find((template) => template.id === id) ?? null;
}
