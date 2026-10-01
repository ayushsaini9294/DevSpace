import {
  TEMPLATES,
  type ActivityEntry,
  type PermissionKey,
  type ProjectRole,
} from '@devspace/shared';

export const ROLE_LABELS: Record<ProjectRole, string> = {
  leader: 'Leader',
  co_leader: 'Co-leader',
  member: 'Member',
};

/** The five extra permissions a leader can switch on for a member, in display order. */
export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  approve: 'Approve submissions',
  comment: 'Comment',
  createTasks: 'Create tasks',
  aiReview: 'AI cross-review',
  publishGithub: 'Publish to GitHub',
};

export const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as PermissionKey[];

/** First string value among the given keys of an activity entry's data. */
function dataString(data: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function roleLabel(value: string | null): string | null {
  if (value === 'leader' || value === 'co_leader' || value === 'member') return ROLE_LABELS[value];
  return value;
}

const TASK_STATUS_WORDS: Record<string, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};

function taskStatusLabel(value: string | null): string | null {
  return value === null ? null : (TASK_STATUS_WORDS[value] ?? value);
}

/** A human-readable sentence for an activity entry; unknown actions fall back to the raw code. */
export function describeActivity(entry: ActivityEntry): string {
  const actor = entry.actorName ?? 'Someone';
  const { data } = entry;
  const who = dataString(data, 'memberName', 'targetName', 'name', 'email') ?? 'a member';
  // Invitations record the invited email as the target.
  const email = dataString(data, 'email') ?? entry.target;

  switch (entry.action) {
    case 'project.created':
      return `${actor} created the project`;
    case 'project.renamed': {
      const from = dataString(data, 'from', 'oldName');
      const to = dataString(data, 'to', 'newName', 'name');
      if (from && to) return `${actor} renamed the project from “${from}” to “${to}”`;
      if (to) return `${actor} renamed the project to “${to}”`;
      return `${actor} renamed the project`;
    }
    case 'project.settings_changed':
      return `${actor} changed the project settings`;
    case 'member.invited':
      return email ? `${actor} invited ${email}` : `${actor} invited someone`;
    case 'invitation.cancelled':
      return email
        ? `${actor} cancelled the invitation for ${email}`
        : `${actor} cancelled an invitation`;
    case 'member.joined':
      return `${actor} joined the project`;
    case 'member.removed':
      return `${actor} removed ${who} from the project`;
    case 'member.left':
      return `${actor} left the project`;
    case 'member.role_changed': {
      const role = roleLabel(dataString(data, 'to', 'role', 'newRole'));
      return role ? `${actor} changed ${who}’s role to ${role}` : `${actor} changed ${who}’s role`;
    }
    case 'member.permissions_changed':
      return `${actor} changed ${who}’s permissions`;
    case 'ownership.transferred':
      return `${actor} made ${who} the leader`;
    case 'repository.created': {
      const template = TEMPLATES.find((t) => t.id === dataString(data, 'template'));
      return template && template.id !== 'empty'
        ? `${actor} started the project from the ${template.name} template`
        : `${actor} started the repository empty`;
    }
    case 'repository.imported': {
      const url = dataString(data, 'url', 'importUrl') ?? entry.target;
      return url
        ? `${actor} imported the repository from ${url}`
        : `${actor} imported the repository`;
    }
    case 'repository.import_failed': {
      const url = dataString(data, 'url', 'importUrl') ?? entry.target;
      return url
        ? `${actor} tried to import from ${url}, but it failed`
        : `${actor} tried to import the repository, but it failed`;
    }
    case 'submission.created': {
      const title = dataString(data, 'title');
      return title
        ? `${actor} submitted “${title}” for review`
        : `${actor} submitted work for review`;
    }
    case 'submission.updated':
      return `${actor} updated a submission`;
    case 'submission.commented':
      return `${actor} commented on a submission`;
    case 'submission.reviewed':
      return dataString(data, 'decision') === 'changes_requested'
        ? `${actor} requested changes on a submission`
        : `${actor} approved a submission`;
    case 'submission.suggestion_accepted':
      return `${actor} accepted a suggested change`;
    case 'submission.suggestion_rejected':
      return `${actor} rejected a suggested change`;
    case 'submission.rejected':
      return `${actor} rejected a submission`;
    case 'submission.closed':
      return `${actor} closed a submission`;
    case 'submission.merged': {
      const title = dataString(data, 'title');
      return title
        ? `${actor} merged “${title}” into main`
        : `${actor} merged a submission into main`;
    }
    case 'submission.reverted': {
      const title = dataString(data, 'title');
      return title
        ? `${actor} undid the merge of “${title}”`
        : `${actor} undid the merge of a submission`;
    }
    case 'copy.updated':
      // Automatic updates (after a merge or undo) have no actor.
      return entry.actorName === null || data.automatic === true
        ? 'A copy was updated to the latest main automatically'
        : `${actor} updated their copy to the latest main`;
    case 'copy.helped': {
      const owner = dataString(data, 'ownerName', 'memberName', 'targetName', 'name');
      return owner ? `${actor} opened ${owner}’s copy` : `${actor} opened a member’s copy`;
    }
    case 'task.created': {
      const title = dataString(data, 'title');
      return title ? `${actor} created the task “${title}”` : `${actor} created a task`;
    }
    case 'task.updated': {
      const title = dataString(data, 'title');
      return title ? `${actor} edited the task “${title}”` : `${actor} edited a task`;
    }
    case 'task.deleted': {
      const title = dataString(data, 'title');
      return title ? `${actor} deleted the task “${title}”` : `${actor} deleted a task`;
    }
    case 'task.moved': {
      const title = dataString(data, 'title');
      const task = title ? `“${title}”` : 'a task';
      const to = taskStatusLabel(dataString(data, 'to'));
      const from = taskStatusLabel(dataString(data, 'from'));
      const where = to ? (from ? ` from ${from} to ${to}` : ` to ${to}`) : '';
      // Automatic moves (a linked submission changed) have no actor.
      if (entry.actorName === null || data.automatic === true) {
        return `The task ${task} moved${where} automatically`;
      }
      return `${actor} moved the task ${task}${where}`;
    }
    case 'task.done_confirmed': {
      const title = dataString(data, 'title');
      const task = title ? `“${title}”` : 'a task';
      return data.done === false
        ? `${actor} said the task ${task} isn’t done yet`
        : `${actor} marked the task ${task} done`;
    }
    case 'github.published': {
      const repo = dataString(data, 'repoFullName');
      const where = repo ? `GitHub (${repo})` : 'GitHub';
      return data.private === false
        ? `${actor} published the project to ${where} as a public repository`
        : `${actor} published the project to ${where}`;
    }
    case 'github.unlinked': {
      const repo = dataString(data, 'repoFullName');
      return repo
        ? `${actor} stopped sending the project to GitHub (${repo})`
        : `${actor} stopped sending the project to GitHub`;
    }
    case 'github.sync_paused': {
      const reason = dataString(data, 'reason');
      return reason
        ? `Sending main to GitHub was paused: ${reason}`
        : 'Sending main to GitHub was paused';
    }
    case 'github.sync_failed': {
      const reason = dataString(data, 'reason');
      return reason ? `Sending main to GitHub failed: ${reason}` : 'Sending main to GitHub failed';
    }
    default:
      return `${actor}: ${entry.action}`;
  }
}
