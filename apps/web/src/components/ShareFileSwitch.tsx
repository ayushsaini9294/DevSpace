import { useId } from 'react';
import { errorMessage } from '../lib/formErrors';
import { usePreferences, useUpdatePreferences } from '../lib/presence';
import { FormAlert } from './AuthPageShell';

/** "Share my open file": whether teammates see which file I have open in the IDE. */
export function ShareFileSwitch() {
  const preferences = usePreferences(true);
  const update = useUpdatePreferences();
  const labelId = useId();
  const hintId = useId();

  const on = preferences.data?.shareOpenFile ?? false;
  const busy = preferences.isPending || update.isPending;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <span id={labelId} className="block text-sm font-medium text-gray-900">
            Share my open file
          </span>
          <span id={hintId} className="block text-xs text-gray-600">
            Teammates see which file you have open in the IDE. When off, they only see that you are
            active.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          disabled={busy || preferences.isError}
          onClick={() => update.mutate({ shareOpenFile: !on })}
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
      {preferences.isError && (
        <FormAlert>Could not load this setting. {errorMessage(preferences.error)}</FormAlert>
      )}
      {update.isError && (
        <FormAlert>Could not change this setting. {errorMessage(update.error)}</FormAlert>
      )}
    </div>
  );
}
