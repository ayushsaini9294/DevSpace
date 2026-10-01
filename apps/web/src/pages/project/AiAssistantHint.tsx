import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { AiAssistantStatus } from '@devspace/shared';
import { linkStyle } from '../../components/ui';
import { AI_SETTINGS_URL } from '../../lib/ai';

const READY = 'Click the AI icon on the left and describe what to build.';

/**
 * One line under the IDE toolbar about the IDE's built-in AI assistant (Phase 12): how to use it
 * when it's ready, otherwise why it can't answer yet and where to fix that. The status is always
 * the copy owner's, so a helping lead reads it about the member.
 */
export function AiAssistantHint({
  projectId,
  status,
  memberName,
  canChangeSettings,
}: {
  projectId: string;
  status: AiAssistantStatus;
  /** Null for my own copy; the member's name (or a stand-in) when a lead opened their copy. */
  memberName: string | null;
  /** Whether I can switch AI on in the project's Settings (leaders and co-leaders). */
  canChangeSettings: boolean;
}) {
  const own = memberName === null;
  let text: ReactNode;

  if (status.ready || status.reason === null) {
    text = own ? READY : `${READY} It works as ${memberName} and uses their AI requests.`;
  } else if (status.reason === 'ai_disabled') {
    text = canChangeSettings ? (
      <>
        AI is switched off in this project.{' '}
        <Link to={`/projects/${projectId}/settings`} className={linkStyle}>
          Switch it on in Settings
        </Link>
      </>
    ) : (
      'AI is switched off in this project. Ask a leader to switch it on in the project’s Settings.'
    );
  } else if (!own) {
    text =
      status.reason === 'not_connected'
        ? `${memberName} hasn’t connected an OpenRouter account yet, so the assistant can’t answer in their copy.`
        : `${memberName} hasn’t accepted the AI notice yet, so the assistant can’t answer in their copy.`;
  } else if (status.reason === 'not_connected') {
    text = (
      <>
        To use it, first{' '}
        <Link to={AI_SETTINGS_URL} className={linkStyle}>
          connect your OpenRouter account
        </Link>
        .
      </>
    );
  } else {
    text = (
      <>
        To use it, first{' '}
        <Link to={AI_SETTINGS_URL} className={linkStyle}>
          read and accept the AI notice
        </Link>
        .
      </>
    );
  }

  return (
    <p
      data-testid="ide-ai-hint"
      data-ready={status.ready ? 'true' : 'false'}
      data-reason={status.reason ?? undefined}
      className="shrink-0 border-b border-gray-200 bg-white px-4 py-1.5 text-sm text-gray-800"
    >
      <strong className="font-semibold">AI assistant:</strong> {text}
    </p>
  );
}
