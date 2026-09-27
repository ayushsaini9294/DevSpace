import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AcceptInvitationResponseSchema,
  ActivityListResponseSchema,
  CreateInvitationResponseSchema,
  InvitationListResponseSchema,
  InvitationPreviewResponseSchema,
  MemberListResponseSchema,
  MemberResponseSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  TeamDetailResponseSchema,
  TeamListResponseSchema,
  TeamResponseSchema,
  type CreateInvitationRequest,
  type CreateProjectRequest,
  type CreateTeamRequest,
  type ProjectDetail,
  type UpdateMemberRequest,
  type UpdateProjectSettingsRequest,
} from '@devspace/shared';
import { useNavigate } from 'react-router';
import { apiDelete, apiFetch, apiPatch, apiPost } from './api';

const enc = encodeURIComponent;

export const queryKeys = {
  teams: ['teams'] as const,
  team: (teamId: string) => ['teams', teamId] as const,
  projects: ['projects'] as const,
  project: (projectId: string) => ['projects', projectId] as const,
  members: (projectId: string) => ['projects', projectId, 'members'] as const,
  invitations: (projectId: string) => ['projects', projectId, 'invitations'] as const,
  activity: (projectId: string) => ['projects', projectId, 'activity'] as const,
  invitePreview: (token: string) => ['invite', token] as const,
};

// ---------- Teams ----------

export function useTeams() {
  return useQuery({
    queryKey: queryKeys.teams,
    queryFn: async () => TeamListResponseSchema.parse(await apiFetch('/api/teams')).teams,
  });
}

export function useTeam(teamId: string) {
  return useQuery({
    queryKey: queryKeys.team(teamId),
    queryFn: async () =>
      TeamDetailResponseSchema.parse(await apiFetch(`/api/teams/${enc(teamId)}`)),
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateTeamRequest) =>
      TeamResponseSchema.parse(await apiPost('/api/teams', data)).team,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.teams, exact: true }),
  });
}

// ---------- Projects ----------

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: async () => ProjectListResponseSchema.parse(await apiFetch('/api/projects')).projects,
  });
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: async () =>
      ProjectResponseSchema.parse(await apiFetch(`/api/projects/${enc(projectId)}`)).project,
  });
}

/** Lists that show project names or membership: the dashboard and every team page. */
function invalidateProjectLists(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.projects, exact: true }),
    queryClient.invalidateQueries({ queryKey: queryKeys.teams }),
  ]);
}

export function useCreateProject(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateProjectRequest) =>
      ProjectResponseSchema.parse(await apiPost(`/api/teams/${enc(teamId)}/projects`, data))
        .project,
    onSuccess: (project) => {
      queryClient.setQueryData(queryKeys.project(project.id), project);
      return invalidateProjectLists(queryClient);
    },
  });
}

/** Store a fresh project from a mutation response, then refetch everything under it. */
function projectChanged(queryClient: QueryClient, project: ProjectDetail) {
  queryClient.setQueryData(queryKeys.project(project.id), project);
  return queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) });
}

export function useRenameProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      ProjectResponseSchema.parse(await apiPatch(`/api/projects/${enc(projectId)}`, { name }))
        .project,
    onSuccess: (project) =>
      Promise.all([projectChanged(queryClient, project), invalidateProjectLists(queryClient)]),
  });
}

export function useUpdateSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (changes: UpdateProjectSettingsRequest) =>
      ProjectResponseSchema.parse(
        await apiPatch(`/api/projects/${enc(projectId)}/settings`, changes),
      ).project,
    onSuccess: (project) => projectChanged(queryClient, project),
  });
}

/**
 * After you delete or leave a project: go home, forget the project (so nothing refetches it
 * into a 404) and refresh the lists.
 */
function useProjectGone(projectId: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return () => {
    void navigate('/', { replace: true });
    queryClient.removeQueries({ queryKey: queryKeys.project(projectId) });
    return invalidateProjectLists(queryClient);
  };
}

export function useDeleteProject(projectId: string) {
  const projectGone = useProjectGone(projectId);
  return useMutation({
    mutationFn: async (confirmName: string) => {
      await apiDelete(`/api/projects/${enc(projectId)}`, { confirmName });
    },
    onSuccess: projectGone,
  });
}

// ---------- Members ----------

export function useMembers(projectId: string) {
  return useQuery({
    queryKey: queryKeys.members(projectId),
    queryFn: async () =>
      MemberListResponseSchema.parse(await apiFetch(`/api/projects/${enc(projectId)}/members`))
        .members,
  });
}

export function useUpdateMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, changes }: { userId: string; changes: UpdateMemberRequest }) =>
      MemberResponseSchema.parse(
        await apiPatch(`/api/projects/${enc(projectId)}/members/${enc(userId)}`, changes),
      ).member,
    // Roles and permissions also show up in the project (member count, activity).
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) }),
  });
}

/** Remove someone else from the project. */
export function useRemoveMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await apiDelete(`/api/projects/${enc(projectId)}/members/${enc(userId)}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) }),
  });
}

/** Leave the project yourself (DELETE with your own id). */
export function useLeaveProject(projectId: string) {
  const projectGone = useProjectGone(projectId);
  return useMutation({
    mutationFn: async (myUserId: string) => {
      await apiDelete(`/api/projects/${enc(projectId)}/members/${enc(myUserId)}`);
    },
    onSuccess: projectGone,
  });
}

export function useTransferOwnership(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) =>
      ProjectResponseSchema.parse(
        await apiPost(`/api/projects/${enc(projectId)}/transfer`, { userId }),
      ).project,
    onSuccess: (project) =>
      Promise.all([projectChanged(queryClient, project), invalidateProjectLists(queryClient)]),
  });
}

// ---------- Invitations ----------

export function useInvitations(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.invitations(projectId),
    queryFn: async () =>
      InvitationListResponseSchema.parse(
        await apiFetch(`/api/projects/${enc(projectId)}/invitations`),
      ).invitations,
    enabled,
  });
}

export function useCreateInvitation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateInvitationRequest) =>
      CreateInvitationResponseSchema.parse(
        await apiPost(`/api/projects/${enc(projectId)}/invitations`, data),
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.invitations(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(projectId) }),
      ]),
  });
}

export function useCancelInvitation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (invitationId: string) => {
      await apiDelete(`/api/projects/${enc(projectId)}/invitations/${enc(invitationId)}`);
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.invitations(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(projectId) }),
      ]),
  });
}

export function useInvitePreview(token: string) {
  return useQuery({
    queryKey: queryKeys.invitePreview(token),
    queryFn: async () =>
      InvitationPreviewResponseSchema.parse(await apiFetch(`/api/invitations/${enc(token)}`)),
    // An invite changes state once used; never show an old answer from the cache.
    gcTime: 0,
  });
}

export function useAcceptInvitation(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      AcceptInvitationResponseSchema.parse(await apiPost(`/api/invitations/${enc(token)}/accept`))
        .projectId,
    onSuccess: () => invalidateProjectLists(queryClient),
  });
}

// ---------- Activity ----------

export function useActivity(projectId: string) {
  return useQuery({
    queryKey: queryKeys.activity(projectId),
    queryFn: async () =>
      ActivityListResponseSchema.parse(await apiFetch(`/api/projects/${enc(projectId)}/activity`))
        .entries,
  });
}
