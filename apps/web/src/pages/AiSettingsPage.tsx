import { useEffect, useId, useRef } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { AiAssistantUsage, AiConnectionView } from '@devspace/shared';
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
  useAcceptAiNotice,
  useAiConnection,
  useAiPreferences,
  useUpdateAiPreferences,
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

/** The one-time AI notice, while I haven't accepted it (the IDE assistant waits for it). */
function Notice() {
  const accept = useAcceptAiNotice();
  return (
    <section
      aria-labelledby="ai-notice-heading"
      data-testid="ai-notice"
      className={`${cardStyle} space-y-3`}
    >
      <h3 id="ai-notice-heading" className="text-lg font-semibold">
        Before you use AI
      </h3>
      <ul className="list-disc space-y-1 pl-5 text-sm text-gray-800">
        <li>
          AI review and the IDE’s AI assistant send your code and file names to outside AI providers
          through your OpenRouter account.
        </li>
        <li>
          Free models may keep or learn from what they receive. Don’t use AI on code you aren’t
          allowed to share.
        </li>
        <li>
          AI can be wrong. Check what it writes; a person still reviews and approves the work.
        </li>
      </ul>
      <p className="text-sm text-gray-700">You only need to accept this once.</p>
      {accept.isError && <FormAlert>{aiErrorMessage(accept.error)}</FormAlert>}
      <button
        type="button"
        disabled={accept.isPending}
        aria-busy={accept.isPending || undefined}
        className={buttonStyles.primary}
        onClick={() => accept.mutate()}
      >
        I understand
      </button>
    </section>
  );
}

function requestCount(n: number): string {
  return n === 1 ? '1 request' : `${n} requests`;
}

function AssistantUsage({ usage }: { usage: AiAssistantUsage }) {
  return (
    <div data-testid="ai-assistant-usage" className="text-sm text-gray-800">
      <p>
        Assistant use today (UTC):{' '}
        {usage.requests === 0 ? 'no requests yet' : requestCount(usage.requests)}.
      </p>
      {usage.models.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-gray-700">
          {usage.models.map((m) => (
            <li key={m.model}>
              <span className="font-mono text-xs break-all">{m.model}</span>:{' '}
              {requestCount(m.requests)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The IDE's built-in AI assistant: the paid-models switch and today's requests (Phase 12). */
function Assistant() {
  const preferences = useAiPreferences();
  const update = useUpdateAiPreferences();
  const labelId = useId();
  const hintId = useId();
  const on = preferences.data?.allowPaid ?? false;

  return (
    <section aria-labelledby="ai-assistant-heading" className={`${cardStyle} space-y-3`}>
      <h3 id="ai-assistant-heading" className="text-lg font-semibold">
        AI assistant in the IDE
      </h3>
      <p className="text-sm text-gray-700">
        Your IDE has a built-in AI assistant: click the AI icon on the left and describe what to
        build. It uses your OpenRouter account through DevSpace, so there’s no key to copy. A leader
        must allow AI in the project’s Settings first.
      </p>
      <p data-testid="ai-helper-note" className="text-sm text-gray-700">
        When a leader or co-leader opens your copy to help you, they can use the assistant too. It
        works as you and uses your requests, but they can never see your key.
      </p>
      {preferences.isPending ? (
        <Loading>Loading your assistant settings…</Loading>
      ) : preferences.isError ? (
        <LoadError
          what="your assistant settings"
          error={preferences.error}
          onRetry={() => preferences.refetch()}
        />
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <span id={labelId} className="block text-sm font-medium text-gray-900">
                Allow paid models in the IDE assistant (uses your OpenRouter credits)
              </span>
              <span id={hintId} className="block text-xs text-gray-600">
                When off, the assistant can only use free models. When on, it can use any model you
                choose in it, and paid models use your OpenRouter credits.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              data-testid="ai-allow-paid"
              aria-checked={on}
              aria-labelledby={labelId}
              aria-describedby={hintId}
              disabled={update.isPending}
              aria-busy={update.isPending || undefined}
              onClick={() => update.mutate({ allowPaid: !on })}
              className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none disabled:opacity-60 ${
                on ? 'bg-blue-700' : 'bg-gray-300'
              }`}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  on ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          {update.isError && (
            <FormAlert>Could not change this setting. {aiErrorMessage(update.error)}</FormAlert>
          )}
          <AssistantUsage usage={preferences.data.assistantUsageToday} />
        </>
      )}
    </section>
  );
}

/** `/settings/ai`: my OpenRouter account, the AI notice, and the IDE assistant's settings. */
export function AiSettingsPage() {
  const connection = useAiConnection();
  const location = useLocation();
  const justConnected = (location.state as { connected?: boolean } | null)?.connected === true;

  return (
    <section aria-labelledby="ai-settings-heading" className="space-y-4">
      <FocusHeading level={2}>
        <span id="ai-settings-heading">AI settings</span>
      </FocusHeading>
      <p className="text-gray-700">
        AI review and the IDE’s AI assistant use your own OpenRouter account. Free models are used
        by default: OpenRouter gives 50 free requests a day, and one review with three models uses
        about three of them. Paid models are only used when you choose them (for AI review) or allow
        them (for the assistant).
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
        <>
          <Connection connection={connection.data} />
          {connection.data.noticeAcceptedAt === null && <Notice />}
        </>
      )}
      <Assistant />
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
          Back to AI settings
        </Link>
      )}
    </section>
  );
}
