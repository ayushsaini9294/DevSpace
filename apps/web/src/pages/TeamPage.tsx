import { Link, useNavigate, useParams } from 'react-router';
import { CreateProjectRequestSchema } from '@devspace/shared';
import { NameForm } from '../components/NameForm';
import { FocusHeading, LoadError, Loading, cardStyle, linkStyle } from '../components/ui';
import { isNotFound } from '../lib/formErrors';
import { ROLE_LABELS } from '../lib/labels';
import { useCreateProject, useTeam } from '../lib/projects';

export function TeamNotFound() {
  return (
    <section className="space-y-4">
      <FocusHeading>Team not found</FocusHeading>
      <p className="text-gray-700">This team doesn’t exist, or you aren’t a member of it.</p>
      <Link to="/" className={linkStyle}>
        Go to your teams and projects
      </Link>
    </section>
  );
}

export function TeamPage() {
  const teamId = useParams().teamId ?? '';
  const team = useTeam(teamId);
  const createProject = useCreateProject(teamId);
  const navigate = useNavigate();

  if (team.isPending) return <Loading>Loading team…</Loading>;
  if (team.isError) {
    if (isNotFound(team.error)) return <TeamNotFound />;
    return <LoadError what="this team" error={team.error} onRetry={() => team.refetch()} />;
  }

  const { projects } = team.data;
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-gray-600">Team</p>
        <FocusHeading>{team.data.team.name}</FocusHeading>
      </div>

      <section aria-labelledby="team-projects" className={`${cardStyle} space-y-3`}>
        <h2 id="team-projects" className="text-xl font-semibold">
          Your projects in this team
        </h2>
        {projects.length === 0 ? (
          <p className="text-gray-700">
            You aren’t in any of this team’s projects yet. Create one below and you’ll be its
            leader.
          </p>
        ) : (
          <ul className="divide-y divide-gray-200">
            {projects.map((project) => (
              <li
                key={project.id}
                className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <Link to={`/projects/${project.id}`} className={`${linkStyle} break-words`}>
                  {project.name}
                </Link>
                <span className="text-sm text-gray-600">{ROLE_LABELS[project.myRole]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="create-project" className={`${cardStyle} space-y-3`}>
        <h2 id="create-project" className="text-xl font-semibold">
          Create a project
        </h2>
        <NameForm
          label="Project name"
          submitLabel="Create project"
          schema={CreateProjectRequestSchema}
          pending={createProject.isPending}
          error={createProject.error}
          onEdit={createProject.reset}
          onValid={(name) =>
            createProject.mutate(
              { name },
              { onSuccess: (project) => void navigate(`/projects/${project.id}`) },
            )
          }
        />
      </section>
    </section>
  );
}
