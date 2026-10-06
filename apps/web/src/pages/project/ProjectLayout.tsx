import { Link, NavLink, Outlet, useLocation, useOutletContext, useParams } from 'react-router';
import type { ProjectDetail, User } from '@devspace/shared';
import { FocusHeading, LoadError, Loading, linkStyle } from '../../components/ui';
import { useCurrentUser } from '../../lib/auth';
import { isNotFound } from '../../lib/formErrors';
import { useProjectRoom } from '../../lib/liveStore';
import { useProject } from '../../lib/projects';
import { TeamPanel } from './TeamPanel';

export type ProjectContext = { project: ProjectDetail; me: User };

/** The project and the logged-in user, for pages inside the project layout. */
export function useProjectContext() {
  return useOutletContext<ProjectContext>();
}

/** Leaders open Settings; so do members allowed to publish to GitHub (only that section). */
export function canOpenSettings(project: ProjectDetail): boolean {
  return (
    project.allowedActions.includes('project.updateSettings') ||
    project.allowedActions.includes('project.delete') ||
    project.allowedActions.includes('github.publish')
  );
}

function ProjectNotFound() {
  return (
    <section className="space-y-4">
      <FocusHeading>Project not found</FocusHeading>
      <p className="text-fg-soft">There is no project you can open at this address.</p>
      <Link to="/" className={linkStyle}>
        Go to your projects
      </Link>
    </section>
  );
}

const tabClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap focus-visible:ring-4 focus-visible:ring-accent-ring/50 focus-visible:outline-none ${
    isActive
      ? 'bg-accent-soft text-accent-fg ring-1 ring-accent-line ring-inset'
      : 'text-fg-soft hover:bg-muted hover:text-fg'
  }`;

export function ProjectLayout() {
  const projectId = useParams().projectId ?? '';
  const project = useProject(projectId);
  const currentUser = useCurrentUser();
  const { pathname } = useLocation();
  // Live updates for this project while any of its pages is open.
  useProjectRoom(projectId);

  if (project.isPending) return <Loading>Loading project…</Loading>;
  if (project.isError) {
    if (isNotFound(project.error)) return <ProjectNotFound />;
    return (
      <LoadError what="this project" error={project.error} onRetry={() => project.refetch()} />
    );
  }
  // RequireAuth above guarantees a user; this only narrows the type.
  if (!currentUser.data) return null;

  const base = `/projects/${project.data.id}`;
  const context: ProjectContext = { project: project.data, me: currentUser.data };

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm text-fg-muted">
            Team{' '}
            <Link to={`/teams/${project.data.teamId}`} className={linkStyle}>
              {project.data.teamName}
            </Link>
          </p>
          <h1 className="text-2xl font-bold tracking-tight break-words">{project.data.name}</h1>
        </div>
        <nav
          aria-label="Project"
          className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 shadow-card"
        >
          <NavLink to={base} end className={tabClass}>
            Overview
          </NavLink>
          <NavLink
            to={`${base}/files`}
            className={({ isActive }) =>
              // A file's page belongs to Files too.
              tabClass({ isActive: isActive || pathname.startsWith(`${base}/blob/`) })
            }
          >
            Files
          </NavLink>
          <NavLink to={`${base}/submissions`} className={tabClass}>
            Submissions
          </NavLink>
          <NavLink to={`${base}/tasks`} className={tabClass}>
            Tasks
          </NavLink>
          <NavLink to={`${base}/members`} className={tabClass}>
            Members
          </NavLink>
          <NavLink to={`${base}/activity`} className={tabClass}>
            Activity
          </NavLink>
          {canOpenSettings(project.data) && (
            <NavLink to={`${base}/settings`} className={tabClass}>
              Settings
            </NavLink>
          )}
        </nav>
      </header>
      <TeamPanel projectId={project.data.id} myId={currentUser.data.id} />
      <Outlet context={context} />
    </div>
  );
}
