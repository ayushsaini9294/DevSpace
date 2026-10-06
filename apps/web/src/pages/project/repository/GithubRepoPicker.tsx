import { useId } from 'react';
import { Link } from 'react-router';
import { LoadError, Loading, buttonStyles, linkStyle } from '../../../components/ui';
import { GITHUB_SETTINGS_URL, githubErrorMessage, useGithubRepos } from '../../../lib/github';
import { errorCode } from '../../../lib/formErrors';

/**
 * Pick one of my GitHub repositories (through the DevSpace app's installations, private ones
 * included). Shown only once my GitHub account is connected.
 */
export function GithubRepoPicker({
  value,
  onChange,
  error,
  installUrl,
}: {
  value: string;
  onChange: (fullName: string) => void;
  error: string | undefined;
  installUrl: string | null;
}) {
  const repos = useGithubRepos(true);
  const selectId = useId();
  const hintId = useId();
  const errorId = useId();

  if (repos.isPending) return <Loading>Loading your GitHub repositories…</Loading>;
  if (repos.isError) {
    if (errorCode(repos.error) === 'github_not_connected') {
      return (
        <p className="text-sm text-fg-soft">
          {githubErrorMessage(repos.error)}{' '}
          <Link to={GITHUB_SETTINGS_URL} className={linkStyle}>
            Go to GitHub settings
          </Link>
        </p>
      );
    }
    return (
      <LoadError
        what="your GitHub repositories"
        error={repos.error}
        onRetry={() => repos.refetch()}
      />
    );
  }

  const install = repos.data.installUrl ?? installUrl;
  const installLink = install && (
    <a
      href={install}
      target="_blank"
      rel="noreferrer"
      data-testid="github-install-link"
      className={linkStyle}
    >
      Install the DevSpace app on GitHub
    </a>
  );
  const refresh = (
    <button
      type="button"
      className={buttonStyles.secondary}
      disabled={repos.isFetching}
      aria-busy={repos.isFetching || undefined}
      onClick={() => void repos.refetch()}
    >
      Refresh the list
    </button>
  );

  if (repos.data.repos.length === 0) {
    return (
      <div className="space-y-2" data-testid="github-no-repos">
        <p className="text-sm text-fg-soft">
          DevSpace can’t see any of your GitHub repositories yet. Install the DevSpace app on GitHub
          and choose which repositories it may use, then refresh the list. {installLink}
        </p>
        {refresh}
      </div>
    );
  }

  const describedBy = [hintId, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="space-y-2">
      <label htmlFor={selectId} className="block text-sm font-medium text-fg">
        GitHub repository
      </label>
      <p id={hintId} className="text-sm text-fg-muted">
        Its main branch (the default branch on GitHub) becomes the project’s main, with its history.
        Up to 200 MB. Missing one? Add it to the DevSpace app on GitHub, then refresh the list.{' '}
        {installLink}
      </p>
      <select
        id={selectId}
        name="repoFullName"
        data-testid="github-repo-picker"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`block w-full rounded-lg border bg-surface px-3 py-2 text-base shadow-card focus:ring-2 focus:outline-none ${
          error
            ? 'border-danger-solid focus:border-danger-solid focus:ring-danger-ring'
            : 'border-line-strong focus:border-accent focus:ring-4 focus:ring-accent-ring/40'
        }`}
      >
        <option value="">Choose a repository…</option>
        {repos.data.repos.map((repo) => (
          <option key={repo.fullName} value={repo.fullName}>
            {repo.private ? `${repo.fullName} (private)` : repo.fullName}
          </option>
        ))}
      </select>
      {error && (
        <p id={errorId} className="text-sm text-danger-fg">
          {error}
        </p>
      )}
      {refresh}
    </div>
  );
}
