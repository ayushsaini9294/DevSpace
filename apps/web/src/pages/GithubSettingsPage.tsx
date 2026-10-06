import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { GithubAccountView } from '@devspace/shared';
import { FormAlert } from '../components/AuthPageShell';
import {
  FocusHeading,
  LoadError,
  Loading,
  SuccessNote,
  buttonStyles,
  cardStyle,
  linkStyle,
} from '../components/ui';
import {
  GITHUB_SETTINGS_URL,
  NOT_CONFIGURED_MESSAGE,
  githubErrorMessage,
  useDisconnectGithub,
  useFinishGithubConnect,
  useGithubAccount,
  useStartGithubConnect,
} from '../lib/github';

/** The link that installs the DevSpace app on my GitHub account, with why it's needed. */
export function InstallAppLink({ installUrl }: { installUrl: string }) {
  return (
    <p className="text-sm text-fg-soft">
      DevSpace also needs its app installed on your GitHub account, so it can send your projects to
      the repositories it creates and read the ones you choose to import.{' '}
      <a
        href={installUrl}
        target="_blank"
        rel="noreferrer"
        data-testid="github-install-link"
        className={linkStyle}
      >
        Install the DevSpace app on GitHub
      </a>
    </p>
  );
}

function Account({ account }: { account: GithubAccountView }) {
  const start = useStartGithubConnect();
  const disconnect = useDisconnectGithub();

  return (
    <section aria-labelledby="github-account-heading" className={`${cardStyle} space-y-3`}>
      <h3 id="github-account-heading" className="text-lg font-semibold">
        GitHub account
      </h3>
      <p className="text-sm text-fg">
        Status:{' '}
        <strong data-testid="github-connection-status">
          {account.connected ? 'Connected' : 'Not connected'}
        </strong>
        {account.connected && account.login && (
          <>
            {' '}
            as <strong data-testid="github-login">{account.login}</strong>
          </>
        )}
      </p>
      {account.connected ? (
        <>
          <p className="text-sm text-fg-soft">
            Commits DevSpace makes for you now use your private GitHub address, so they show on your
            GitHub profile without showing your real email.
          </p>
          {account.appInstalled === true && (
            <p data-testid="github-app-installed" className="text-sm text-fg">
              The DevSpace app is installed on your GitHub account.
            </p>
          )}
          {account.installUrl && <InstallAppLink installUrl={account.installUrl} />}
          <p className="text-sm text-fg-soft">
            Disconnecting deletes your GitHub sign-in from DevSpace. Projects already on GitHub stay
            there.
          </p>
          {disconnect.isError && <FormAlert>{githubErrorMessage(disconnect.error)}</FormAlert>}
          <button
            type="button"
            disabled={disconnect.isPending}
            aria-busy={disconnect.isPending || undefined}
            className={buttonStyles.dangerOutline}
            onClick={() => disconnect.mutate()}
          >
            Disconnect
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-fg-soft">
            You’ll sign in on GitHub and allow DevSpace to create repositories for you. DevSpace
            keeps your sign-in encrypted and never shows it.
          </p>
          {start.isError && <FormAlert>{githubErrorMessage(start.error)}</FormAlert>}
          <button
            type="button"
            disabled={start.isPending || start.isSuccess}
            aria-busy={start.isPending || start.isSuccess || undefined}
            className={buttonStyles.primary}
            onClick={() => start.mutate()}
          >
            Connect GitHub
          </button>
        </>
      )}
      {disconnect.isSuccess && !account.connected && (
        <SuccessNote>Disconnected. DevSpace no longer has your GitHub sign-in.</SuccessNote>
      )}
    </section>
  );
}

/** `/settings/github`: connect my GitHub account and install the DevSpace app. */
export function GithubSettingsPage() {
  const account = useGithubAccount();
  const location = useLocation();
  const justConnected = (location.state as { connected?: boolean } | null)?.connected === true;

  return (
    <section aria-labelledby="github-settings-heading" className="space-y-4">
      <FocusHeading level={2}>
        <span id="github-settings-heading">GitHub settings</span>
      </FocusHeading>
      <p className="text-fg-soft">
        GitHub is a website where people keep and share code. Connect your account to put your
        DevSpace projects on GitHub, for example for your portfolio, or to start a project from one
        of your GitHub repositories.
      </p>
      {justConnected && account.data?.connected && <SuccessNote>GitHub connected.</SuccessNote>}
      {account.isPending ? (
        <Loading>Checking your GitHub connection…</Loading>
      ) : account.isError ? (
        <LoadError
          what="your GitHub connection"
          error={account.error}
          onRetry={() => account.refetch()}
        />
      ) : !account.data.configured ? (
        <p data-testid="github-not-configured" className={`${cardStyle} text-fg-soft`}>
          {NOT_CONFIGURED_MESSAGE} The person who runs this DevSpace needs to set it up first.
        </p>
      ) : (
        <Account account={account.data} />
      )}
    </section>
  );
}

/** `/settings/github/callback?code=&state=`: GitHub sent me back; finish connecting. */
export function GithubCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const finish = useFinishGithubConnect();
  const code = params.get('code') ?? '';
  const state = params.get('state') ?? '';
  const missing = !code || !state;
  const { mutate } = finish;

  // Once (the ref keeps StrictMode's second effect from using the single-use state again).
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || missing) return;
    sent.current = true;
    mutate(
      { code, state },
      {
        onSuccess: () =>
          navigate(GITHUB_SETTINGS_URL, { replace: true, state: { connected: true } }),
      },
    );
  }, [code, state, missing, mutate, navigate]);

  let body;
  if (missing) {
    body = (
      <FormAlert>
        GitHub didn’t send DevSpace a code, so the account wasn’t connected. Try connecting again.
      </FormAlert>
    );
  } else if (finish.isError) {
    body = <FormAlert>Couldn’t connect GitHub. {githubErrorMessage(finish.error)}</FormAlert>;
  } else {
    body = <Loading>Connecting your GitHub account…</Loading>;
  }

  return (
    <section className="space-y-4">
      <FocusHeading level={2}>Connecting GitHub</FocusHeading>
      {body}
      {(missing || finish.isError) && (
        <Link to={GITHUB_SETTINGS_URL} className={linkStyle}>
          Back to GitHub settings
        </Link>
      )}
    </section>
  );
}
