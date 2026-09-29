import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { AiConnectionView } from '@devspace/shared';
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
  AI_SETTINGS_URL,
  aiErrorMessage,
  useAiConnection,
  useDisconnectAi,
  useFinishAiConnect,
  useStartAiConnect,
} from '../lib/ai';
import { fullDate } from '../lib/time';

/** Where a member can delete the key on OpenRouter's side too. */
const OPENROUTER_KEYS_URL = 'https://openrouter.ai/settings/keys';

function FreeRequests({ connection }: { connection: AiConnectionView }) {
  const free = connection.freeRequestsToday;
  return (
    <p data-testid="ai-free-requests" className="text-sm text-gray-800">
      {free
        ? `${free.remaining} of ${free.limit} free requests left today (UTC).`
        : 'Couldn’t check your free requests with OpenRouter right now.'}
    </p>
  );
}

function Connection({ connection }: { connection: AiConnectionView }) {
  const start = useStartAiConnect();
  const disconnect = useDisconnectAi();

  return (
    <section aria-labelledby="ai-connection-heading" className={`${cardStyle} space-y-3`}>
      <h3 id="ai-connection-heading" className="text-lg font-semibold">
        OpenRouter account
      </h3>
      <p className="text-sm text-gray-800">
        Status:{' '}
        <strong data-testid="ai-connection-status">
          {connection.connected ? 'Connected' : 'Not connected'}
        </strong>
      </p>
      {connection.connected ? (
        <>
          <p className="text-sm text-gray-700">
            {connection.keyHint ? `Key ending in …${connection.keyHint}` : 'Key stored'}
            {connection.connectedAt &&
              ` · connected ${fullDate.format(new Date(connection.connectedAt))}`}
          </p>
          <FreeRequests connection={connection} />
          <p className="text-sm text-gray-700">
            Disconnecting deletes the key from DevSpace. You can also delete it in your{' '}
            <a href={OPENROUTER_KEYS_URL} target="_blank" rel="noreferrer" className={linkStyle}>
              OpenRouter settings
            </a>
            .
          </p>
          {disconnect.isError && <FormAlert>{aiErrorMessage(disconnect.error)}</FormAlert>}
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
          <p className="text-sm text-gray-700">
            You’ll log in on OpenRouter and allow DevSpace to use your account. DevSpace keeps the
            key encrypted and never shows it again.
          </p>
          {start.isError && <FormAlert>{aiErrorMessage(start.error)}</FormAlert>}
          <button
            type="button"
            disabled={start.isPending || start.isSuccess}
            aria-busy={start.isPending || start.isSuccess || undefined}
            className={buttonStyles.primary}
            onClick={() => start.mutate()}
          >
            Connect OpenRouter
          </button>
        </>
      )}
      {disconnect.isSuccess && !connection.connected && (
        <SuccessNote>Disconnected. DevSpace no longer has your key.</SuccessNote>
      )}
    </section>
  );
}

/** `/settings/ai`: connect my OpenRouter account for AI review. */
export function AiSettingsPage() {
  const connection = useAiConnection();
  const location = useLocation();
  const justConnected = (location.state as { connected?: boolean } | null)?.connected === true;

  return (
    <section aria-labelledby="ai-settings-heading" className="space-y-4">
      <FocusHeading level={2}>
        <span id="ai-settings-heading">AI review</span>
      </FocusHeading>
      <p className="text-gray-700">
        AI review uses your own OpenRouter account. Free models are used by default: OpenRouter
        gives 50 free requests a day, and one review with three models uses about three of them.
        Paid models are only used when you pick them and confirm.
      </p>
      {justConnected && connection.data?.connected && (
        <SuccessNote>OpenRouter connected.</SuccessNote>
      )}
      {connection.isPending ? (
        <Loading>Checking your OpenRouter connection…</Loading>
      ) : connection.isError ? (
        <LoadError
          what="your OpenRouter connection"
          error={connection.error}
          onRetry={() => connection.refetch()}
        />
      ) : (
        <Connection connection={connection.data} />
      )}
    </section>
  );
}

/** `/settings/ai/callback?code=&state=`: OpenRouter sent me back; finish connecting. */
export function AiCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const finish = useFinishAiConnect();
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
      { onSuccess: () => navigate(AI_SETTINGS_URL, { replace: true, state: { connected: true } }) },
    );
  }, [code, state, missing, mutate, navigate]);

  let body;
  if (missing) {
    body = (
      <FormAlert>
        OpenRouter didn’t send DevSpace a code, so the account wasn’t connected. Try connecting
        again.
      </FormAlert>
    );
  } else if (finish.isError) {
    body = <FormAlert>Couldn’t connect OpenRouter. {aiErrorMessage(finish.error)}</FormAlert>;
  } else {
    body = <Loading>Connecting your OpenRouter account…</Loading>;
  }

  return (
    <section className="space-y-4">
      <FocusHeading level={2}>Connecting OpenRouter</FocusHeading>
      {body}
      {(missing || finish.isError) && (
        <Link to={AI_SETTINGS_URL} className={linkStyle}>
          Back to AI review settings
        </Link>
      )}
    </section>
  );
}
