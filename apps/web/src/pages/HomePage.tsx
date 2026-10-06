import { Link, useNavigate } from 'react-router';
import { CreateTeamRequestSchema } from '@devspace/shared';
import { ApiStatus } from '../components/ApiStatus';
import { NameForm } from '../components/NameForm';
import { LoadError, Loading, buttonStyles, cardStyle, linkStyle } from '../components/ui';
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
        <p className="text-fg-soft">
          You aren’t in any projects yet. Create a team and start a project in it, or open an invite
          link someone sent you.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {projects.data.map((project) => (
            <li
              key={project.id}
              className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <Link to={`/projects/${project.id}`} className={`${linkStyle} break-words`}>
                {project.name}
              </Link>
              <span className="text-sm text-fg-muted">
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
        <p className="text-fg-soft">
          You aren’t in any teams yet. Create one below: a team holds your projects, and you can
          invite people to each project.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {teams.data.map((team) => (
            <li key={team.id} className="py-2">
              <Link to={`/teams/${team.id}`} className={`${linkStyle} break-words`}>
                {team.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-line pt-4">
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
        <p className="text-lg font-semibold">Welcome, {currentUser.data.name}</p>
        <YourProjects />
        <YourTeams />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link to="/signup" className={`${buttonStyles.primary} px-5 py-2.5 text-base`}>
          Create an account
        </Link>
        <Link to="/login" className={`${buttonStyles.secondary} px-5 py-2.5 text-base`}>
          Log in to your account
        </Link>
      </div>
      <ul className="grid gap-4 sm:grid-cols-3">
        {FEATURES.map((feature) => (
          <li key={feature.title} className={`${cardStyle} space-y-1.5`}>
            <p className="font-semibold">{feature.title}</p>
            <p className="text-sm text-fg-muted">{feature.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

const FEATURES = [
  {
    title: 'Your own copy',
    text: 'Everyone codes in their own space in the browser. Nothing to install.',
  },
  {
    title: 'Review together',
    text: 'Send your changes for review, get comments and AI tips, then add them to main.',
  },
  {
    title: 'Easy to undo',
    text: 'A merge can be undone, so mistakes are no big deal.',
  },
];

export function HomePage() {
  const status = useApiStatus();
  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <h1 className="bg-gradient-to-br from-fg to-accent-fg bg-clip-text pb-1 text-4xl font-extrabold tracking-tight text-transparent sm:text-5xl">
          DevSpace
        </h1>
        <p className="max-w-2xl text-lg text-fg-soft">
          Build projects together, right in your browser. Everyone works in their own copy, sends
          their changes for review, and a leader adds the reviewed work to main, the team’s shared
          version. Nothing to install, and mistakes are easy to undo.
        </p>
      </div>
      <Account />
      <ApiStatus state={status} />
    </section>
  );
}
