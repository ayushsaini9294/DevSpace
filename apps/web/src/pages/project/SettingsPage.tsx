import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  RenameProjectRequestSchema,
  type ProjectSettings,
  type UpdateProjectSettingsRequest,
} from '@devspace/shared';
import { FormAlert } from '../../components/AuthPageShell';
import { NameForm } from '../../components/NameForm';
import { FocusHeading, SuccessNote, buttonStyles, cardStyle, linkStyle } from '../../components/ui';
import { errorMessage } from '../../lib/formErrors';
import { useDeleteProject, useRenameProject, useUpdateSettings } from '../../lib/projects';
import { canOpenSettings, useProjectContext } from './ProjectLayout';

function RenameSection({ projectId, name }: { projectId: string; name: string }) {
  const rename = useRenameProject(projectId);
  return (
    <section aria-labelledby="rename-heading" className={`${cardStyle} space-y-3`}>
      <h3 id="rename-heading" className="text-lg font-semibold">
        Name
      </h3>
      <NameForm
        // Start again from the saved name whenever it changes.
        key={name}
        label="Project name"
        submitLabel="Save name"
        schema={RenameProjectRequestSchema}
        defaultValue={name}
        pending={rename.isPending}
        error={rename.error}
        onEdit={rename.reset}
        onValid={(newName) => rename.mutate(newName)}
      />
      {rename.isSuccess && <SuccessNote>Name saved.</SuccessNote>}
    </section>
  );
}

function Choice({
  name,
  value,
  defaultChecked,
  type,
  children,
  hint,
}: {
  name: string;
  value?: string;
  defaultChecked: boolean;
  type: 'checkbox' | 'radio';
  children: ReactNode;
  hint?: string;
}) {
  const hintId = useId();
  return (
    <div>
      <label className="flex items-start gap-2 text-gray-800">
        <input
          type={type}
          name={name}
          value={value}
          defaultChecked={defaultChecked}
          aria-describedby={hint ? hintId : undefined}
          className="mt-1 h-4 w-4 shrink-0 border-gray-300"
        />
        <span>{children}</span>
      </label>
      {hint && (
        <p id={hintId} className="ml-6 text-sm text-gray-600">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Read the settings form. */
function readSettings(form: HTMLFormElement): ProjectSettings {
  const data = new FormData(form);
  return {
    requireApproval: data.get('requireApproval') === 'on',
    membersCanBrowseCopies: data.get('membersCanBrowseCopies') === 'on',
    copyUpdateMode: data.get('copyUpdateMode') === 'manual' ? 'manual' : 'automatic',
    githubMode: data.get('githubMode') === 'keep_updated' ? 'keep_updated' : 'publish_once',
    aiReviewEnabled: data.get('aiReviewEnabled') === 'on',
  };
}

/** Only the settings that differ from the saved ones. */
export function changedSettings(
  saved: ProjectSettings,
  next: ProjectSettings,
): UpdateProjectSettingsRequest {
  const changes: UpdateProjectSettingsRequest = {};
  for (const key of Object.keys(next) as (keyof ProjectSettings)[]) {
    if (next[key] !== saved[key]) Object.assign(changes, { [key]: next[key] });
  }
  return changes;
}

function SettingsSection({ projectId, saved }: { projectId: string; saved: ProjectSettings }) {
  const update = useUpdateSettings(projectId);
  const [note, setNote] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const changes = changedSettings(saved, readSettings(event.currentTarget));
    if (Object.keys(changes).length === 0) {
      update.reset();
      setNote('Nothing changed.');
      return;
    }
    setNote(null);
    update.mutate(changes, { onSuccess: () => setNote('Settings saved.') });
  }

  return (
    <section aria-labelledby="settings-heading" className={`${cardStyle} space-y-3`}>
      <h3 id="settings-heading" className="text-lg font-semibold">
        Project settings
      </h3>
      {/* Remount with fresh defaults whenever the saved settings change. */}
      <form key={JSON.stringify(saved)} onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Choice
            type="checkbox"
            name="requireApproval"
            defaultChecked={saved.requireApproval}
            hint="A submission needs an approval before a leader can merge it."
          >
            Require approval before merge
          </Choice>
          <Choice
            type="checkbox"
            name="membersCanBrowseCopies"
            defaultChecked={saved.membersCanBrowseCopies}
            hint="Members can look at (not change) other members’ copies."
          >
            Members can browse others’ copies
          </Choice>
          <Choice
            type="checkbox"
            name="aiReviewEnabled"
            defaultChecked={saved.aiReviewEnabled}
            hint="Warning: when this is on, members can send a submission’s changes (code and file names) to outside AI providers through their own OpenRouter account. Free models may keep or learn from what they receive. Leave it off for code that mustn’t leave DevSpace."
          >
            Allow AI review (sends code to AI providers)
          </Choice>
        </div>
        <fieldset className="space-y-1">
          <legend className="font-medium text-gray-800">Update copies after merge</legend>
          <Choice
            type="radio"
            name="copyUpdateMode"
            value="automatic"
            defaultChecked={saved.copyUpdateMode === 'automatic'}
          >
            Automatic
          </Choice>
          <Choice
            type="radio"
            name="copyUpdateMode"
            value="manual"
            defaultChecked={saved.copyUpdateMode === 'manual'}
          >
            Manual
          </Choice>
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="font-medium text-gray-800">GitHub mode</legend>
          <Choice
            type="radio"
            name="githubMode"
            value="publish_once"
            defaultChecked={saved.githubMode === 'publish_once'}
          >
            Publish once
          </Choice>
          <Choice
            type="radio"
            name="githubMode"
            value="keep_updated"
            defaultChecked={saved.githubMode === 'keep_updated'}
          >
            Keep updated
          </Choice>
        </fieldset>
        {update.isError && <FormAlert>{errorMessage(update.error)}</FormAlert>}
        <button
          type="submit"
          disabled={update.isPending}
          aria-busy={update.isPending || undefined}
          className={buttonStyles.primary}
        >
          Save settings
        </button>
      </form>
      {note && <SuccessNote>{note}</SuccessNote>}
    </section>
  );
}

function DangerZone({ projectId, name }: { projectId: string; name: string }) {
  const remove = useDeleteProject(projectId);
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const hintId = useId();
  const matches = typed === name;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!matches) return;
    remove.mutate(typed);
  }

  return (
    <section
      aria-labelledby="danger-heading"
      className="space-y-3 rounded-lg border border-red-300 bg-white p-4 shadow-sm sm:p-6"
    >
      <h3 id="danger-heading" className="text-lg font-semibold text-red-800">
        Danger zone
      </h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor={inputId} className="block text-sm font-medium text-gray-800">
            Type the project name to confirm
          </label>
          <p id={hintId} className="text-sm text-gray-700">
            Deleting removes the project, its members and its activity for everyone. This can’t be
            undone. Type <strong className="break-all">{name}</strong> exactly.
          </p>
          <input
            id={inputId}
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            autoComplete="off"
            aria-describedby={hintId}
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base shadow-sm focus:border-red-600 focus:ring-2 focus:ring-red-200 focus:outline-none"
          />
        </div>
        {remove.isError && <FormAlert>{errorMessage(remove.error)}</FormAlert>}
        <button
          type="submit"
          disabled={!matches || remove.isPending}
          aria-busy={remove.isPending || undefined}
          className={buttonStyles.danger}
        >
          Delete project
        </button>
      </form>
    </section>
  );
}

export function SettingsPage() {
  const { project } = useProjectContext();
  const allowed = (action: (typeof project.allowedActions)[number]) =>
    project.allowedActions.includes(action);

  return (
    <section aria-labelledby="settings-page-heading" className="space-y-4">
      <FocusHeading level={2}>
        <span id="settings-page-heading">Settings</span>
      </FocusHeading>
      {!canOpenSettings(project) ? (
        <div className="space-y-2">
          <p className="text-gray-700">Only the project’s leaders can change its settings.</p>
          <Link to={`/projects/${project.id}`} className={linkStyle}>
            Back to the overview
          </Link>
        </div>
      ) : (
        <>
          {allowed('project.rename') && (
            <RenameSection projectId={project.id} name={project.name} />
          )}
          {allowed('project.updateSettings') && (
            <SettingsSection projectId={project.id} saved={project.settings} />
          )}
          {allowed('project.delete') && <DangerZone projectId={project.id} name={project.name} />}
        </>
      )}
    </section>
  );
}
