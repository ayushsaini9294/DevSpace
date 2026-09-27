import { FocusHeading, cardStyle } from '../../components/ui';
import { PERMISSION_KEYS, PERMISSION_LABELS, ROLE_LABELS } from '../../lib/labels';
import { OverviewRepository } from './OverviewRepository';
import { useProjectContext } from './ProjectLayout';

export function OverviewPage() {
  const { project } = useProjectContext();
  const switchedOn = PERMISSION_KEYS.filter((key) => project.myPermissions[key]);
  const isMember = project.myRole === 'member';

  return (
    <section aria-labelledby="overview-heading" className="space-y-4">
      <FocusHeading level={2}>
        <span id="overview-heading">Overview</span>
      </FocusHeading>
      <div className={`${cardStyle} space-y-3`}>
        <p className="font-medium">Your role: {ROLE_LABELS[project.myRole]}</p>
        <p className="text-gray-700">
          {project.memberCount === 1 ? '1 member' : `${project.memberCount} members`}
        </p>
        {isMember ? (
          <div className="space-y-1">
            <h3 className="font-medium">Your extra permissions</h3>
            {switchedOn.length === 0 ? (
              <p className="text-gray-700">
                None switched on yet. A leader can switch them on for you.
              </p>
            ) : (
              <ul className="list-inside list-disc text-gray-700">
                {switchedOn.map((key) => (
                  <li key={key}>{PERMISSION_LABELS[key]}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-gray-700">
            As a {ROLE_LABELS[project.myRole].toLowerCase()} you have every member permission.
          </p>
        )}
      </div>
      <OverviewRepository />
    </section>
  );
}
