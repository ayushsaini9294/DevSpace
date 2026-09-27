import { Link, useNavigate } from 'react-router';
import { CreateTeamRequestSchema } from '@devspace/shared';
import { ApiStatus } from '../components/ApiStatus';
import { NameForm } from '../components/NameForm';
import { LoadError, Loading, cardStyle, linkStyle } from '../components/ui';
import { useCurrentUser } from '../lib/auth';
import { useApiStatus } from '../lib/health';
import { ROLE_LABELS } from '../lib/labels';
import { useCreateTeam, useProjects, useTeams } from '../lib/projects';

function YourProjects() {
  const projects = useProjects();
  return (
    <section aria-labelledby="your-projects" className={`${cardStyle} space-y-3`}>
      <h2 id="your-projects" className="text-xl font-semibold">
        Your projects
      </h2>
      {projects.isPending ? (
        <Loading>Loading your projects…</Loading>
      ) : projects.isError ? (
        <LoadError what="your projects" error={projects.error} onRetry={() => projects.refetch()} />
      ) : projects.data.length === 0 ? (
        <p className="text-gray-700">
          You aren’t in any projects yet. Create a team and start a project in it, or open an invite
          link someone sent you.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200">
          {projects.data.map((project) => (
            <li
              key={project.id}
              className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <Link to={`/projects/${project.id}`} className={`${linkStyle} break-words`}>
                {project.name}
              </Link>
              <span className="text-sm text-gray-600">
                {project.teamName} · {ROLE_LABELS[project.myRole]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function YourTeams() {
  const teams = useTeams();
  const createTeam = useCreateTeam();
  const navigate = useNavigate();
  return (
    <section aria-labelledby="your-teams" className={`${cardStyle} space-y-4`}>
      <h2 id="your-teams" className="text-xl font-semibold">
        Your teams
      </h2>
      {teams.isPending ? (
        <Loading>Loading your teams…</Loading>
      ) : teams.isError ? (
        <LoadError what="your teams" error={teams.error} onRetry={() => teams.refetch()} />
      ) : teams.data.length === 0 ? (
        <p className="text-gray-700">You aren’t in any teams yet. Create one below.</p>
      ) : (
        <ul className="divide-y divide-gray-200">
          {teams.data.map((team) => (
            <li key={team.id} className="py-2">
              <Link to={`/teams/${team.id}`} className={`${linkStyle} break-words`}>
                {team.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-gray-200 pt-4">
        <h3 className="mb-2 font-medium">Create a team</h3>
        <NameForm
          label="Team name"
          submitLabel="Create team"
          schema={CreateTeamRequestSchema}
          pending={createTeam.isPending}
          error={createTeam.error}
          onEdit={createTeam.reset}
          onValid={(name) =>
            createTeam.mutate({ name }, { onSuccess: (team) => void navigate(`/teams/${team.id}`) })
          }
        />
      </div>
    </section>
  );
}

function Account() {
  const currentUser = useCurrentUser();
  if (currentUser.isPending) return null;

  if (currentUser.data) {
    return (
      <div className="space-y-4">
        <p className="text-lg font-medium">Welcome, {currentUser.data.name}</p>
        <YourProjects />
        <YourTeams />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Link
        to="/signup"
        className="rounded-md bg-blue-700 px-4 py-2 text-center font-medium text-white hover:bg-blue-800"
      >
        Create an account
      </Link>
      <Link
        to="/login"
        className="rounded-md border border-gray-300 bg-white px-4 py-2 text-center font-medium text-gray-800 hover:bg-gray-100"
      >
        Log in to your account
      </Link>
    </div>
  );
}

export function HomePage() {
  const status = useApiStatus();
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">DevSpace</h1>
      <p className="text-gray-700">
        A team workspace: everyone works on their own copy, and leaders merge reviewed work into
        main.
      </p>
      <Account />
      <ApiStatus state={status} />
    </section>
  );
}
