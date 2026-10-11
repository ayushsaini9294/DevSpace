import {
  DEFAULT_MEMBER_PERMISSIONS,
  type ActivityEntry,
  type AiReviewView,
  type Comment,
  type FileChange,
  type Invitation,
  type MemberPermissions,
  type NotificationView,
  type PresenceView,
  type ProjectRole,
  type ProjectSettings,
  type Review,
  type SubmissionStatus,
  type TaskStatus,
  type TemplateId,
} from '@devspace/shared';
import { lineOf, mainFiles, versions } from './repoFiles';

/**
 * Everything the demo's stand-in API knows. Plain JSON (no Maps or Dates), so it can be kept in
 * sessionStorage for the visit. Views sent to the app are computed from this in `server.ts`.
 */

export type DemoUser = { id: string; name: string; email: string; createdAt: string };

export type DemoTeam = { id: string; name: string; ownerId: string; createdAt: string };

export type DemoMember = {
  userId: string;
  role: ProjectRole;
  permissions: MemberPermissions;
  joinedAt: string;
};

export type DemoCommit = {
  sha: string;
  message: string;
  authorName: string;
  committedAt: string;
};

/** A member's copy: main at `baseSha`, plus their own changes (null = deleted). */
export type DemoCopy = {
  id: string;
  createdAt: string;
  lastActiveAt: string | null;
  baseSha: string;
  /** Main's files at `baseSha`. */
  base: Record<string, string>;
  changes: Record<string, string | null>;
  /** Automatic update found clashes and left the copy as it was. */
  pendingConflictPaths: string[];
};

export type DemoSubmissionFile = {
  path: string;
  change: FileChange;
  /** The file at the submission's base (null: it didn't exist). */
  base: string | null;
  /** The file in the submission's current version (null: deleted). */
  head: string | null;
};

export type DemoSubmission = {
  id: string;
  title: string;
  description: string;
  status: SubmissionStatus;
  authorId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  baseSha: string;
  headSha: string;
  rejectReason: string | null;
  closedAt: string | null;
  files: DemoSubmissionFile[];
  reviews: Review[];
  comments: Comment[];
  conflictPaths: string[];
  mergedSha: string | null;
  mergedById: string | null;
  mergedAt: string | null;
  revertedSha: string | null;
  revertedById: string | null;
  revertedAt: string | null;
  taskId: string | null;
  /**
   * When Maya (the sample co-leader) approves this version automatically (ms since 1970), so a
   * visitor can try Merge on their own work. Only set on the visitor's submissions.
   */
  autoApproveAt?: number | null;
};

export type DemoTask = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dueDate: string | null;
  position: number;
  assigneeIds: string[];
  createdById: string;
  doneConfirmPending: boolean;
  reopenNote: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DemoProject = {
  id: string;
  name: string;
  teamId: string;
  createdAt: string;
  settings: ProjectSettings;
  members: DemoMember[];
  invitations: Invitation[];
  repository: {
    status: 'none' | 'ready';
    source: 'empty' | 'template' | null;
    template: TemplateId | null;
  };
  /** Oldest first. */
  commits: DemoCommit[];
  main: Record<string, string>;
  copies: Record<string, DemoCopy>;
  submissions: DemoSubmission[];
  tasks: DemoTask[];
  activity: ActivityEntry[];
  presence: PresenceView[];
  aiReviews: AiReviewView[];
  gettingStartedHidden: boolean;
  previewed: boolean;
};

export type DemoState = {
  version: typeof STATE_VERSION;
  loggedIn: boolean;
  meId: string;
  users: DemoUser[];
  teams: DemoTeam[];
  projects: DemoProject[];
  notifications: NotificationView[];
  shareOpenFile: boolean;
  allowPaidModels: boolean;
  /** Counter for new ids. */
  seq: number;
};

export const STATE_VERSION = 1;

export const ME = 'demo-leader';
export const MAYA = 'maya-chen';
export const LEO = 'leo-martins';
export const SARA = 'sara-okafor';

export const SAMPLE_PROJECT_ID = 'class-website';
export const SAMPLE_TEAM_ID = 'demo-team';

/** A short, stable fake commit id from any text. */
export function fakeSha(seed: string): string {
  let out = '';
  let h = 2166136261;
  for (let round = 0; out.length < 40; round++) {
    for (const ch of `${seed}:${round}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}

const ALL_PERMISSIONS: MemberPermissions = {
  approve: true,
  comment: true,
  createTasks: true,
  aiReview: true,
  publishGithub: true,
};

/** The demo as it starts: one team, one project, four people, work in every state. */
export function initialState(now: number = Date.now()): DemoState {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const HOUR = 60;
  const DAY = 24 * HOUR;
  const dayFromNow = (days: number) =>
    new Date(now + days * DAY * 60_000).toISOString().slice(0, 10);

  const users: DemoUser[] = [
    { id: ME, name: 'Demo Leader', email: 'demo.leader@example.com', createdAt: ago(9 * DAY) },
    { id: MAYA, name: 'Maya Chen', email: 'maya.chen@example.com', createdAt: ago(8 * DAY) },
    { id: LEO, name: 'Leo Martins', email: 'leo.martins@example.com', createdAt: ago(8 * DAY) },
    { id: SARA, name: 'Sara Okafor', email: 'sara.okafor@example.com', createdAt: ago(7 * DAY) },
  ];
  const ref = (id: string) => {
    const user = users.find((u) => u.id === id)!;
    return { id: user.id, name: user.name };
  };

  // ---------- Main's history ----------
  const commits: DemoCommit[] = [
    {
      sha: fakeSha('commit-template'),
      message: 'Start from the HTML/CSS/JS website template',
      authorName: 'Demo Leader',
      committedAt: ago(7 * DAY),
    },
    {
      sha: fakeSha('commit-timetable'),
      message: 'Add the class timetable',
      authorName: 'Leo Martins',
      committedAt: ago(5 * DAY),
    },
    {
      sha: fakeSha('commit-nav'),
      message: 'Add the navigation bar',
      authorName: 'Maya Chen',
      committedAt: ago(1 * DAY),
    },
  ];
  const beforeNavSha = commits[1]!.sha;
  const mainSha = commits[2]!.sha;

  // ---------- Submissions ----------
  const v = versions;
  const gallerySuggestionLine = lineOf(v.scriptGallery, "document.querySelectorAll('img')");
  const galleryCssLine = lineOf(v.styleGallery, 'grid-template-columns');

  const gallery: DemoSubmission = {
    id: 'sub-gallery',
    title: 'Add a photo gallery page',
    description:
      'A new Photos page with our class photos. Clicking a photo shows it bigger (a "lightbox"), clicking again closes it.',
    status: 'open',
    authorId: LEO,
    version: 1,
    createdAt: ago(5 * HOUR),
    updatedAt: ago(3 * HOUR),
    baseSha: mainSha,
    headSha: fakeSha('sub-gallery-v1'),
    rejectReason: null,
    closedAt: null,
    files: [
      { path: 'gallery.html', change: 'added', base: null, head: v.galleryHtml },
      { path: 'script.js', change: 'modified', base: v.scriptMain, head: v.scriptGallery },
      { path: 'style.css', change: 'modified', base: v.styleMain, head: v.styleGallery },
    ],
    reviews: [],
    comments: [
      {
        id: 'comment-gallery-1',
        author: ref(MAYA),
        parentId: null,
        path: 'style.css',
        side: 'head',
        line: galleryCssLine,
        startLine: galleryCssLine,
        version: 1,
        body: 'Nice! On my phone this makes the photos quite small. Maybe 10rem instead of 12rem?',
        suggestion: null,
        suggestionStatus: null,
        outdated: false,
        createdAt: ago(4 * HOUR),
      },
      {
        id: 'comment-gallery-2',
        author: ref(LEO),
        parentId: 'comment-gallery-1',
        path: null,
        side: null,
        line: null,
        startLine: null,
        version: 1,
        body: 'Good idea, I will try it on my phone too.',
        suggestion: null,
        suggestionStatus: null,
        outdated: false,
        createdAt: ago(3 * HOUR + 30),
      },
      {
        id: 'comment-gallery-3',
        author: ref(MAYA),
        parentId: null,
        path: 'script.js',
        side: 'head',
        line: gallerySuggestionLine,
        startLine: gallerySuggestionLine,
        version: 1,
        body: 'This picks every image on the page, including the class logo. Only pick the gallery photos:',
        suggestion: "const photos = document.querySelectorAll('.gallery img');",
        suggestionStatus: 'pending',
        outdated: false,
        createdAt: ago(3 * HOUR + 10),
      },
      {
        id: 'comment-gallery-4',
        author: ref(SARA),
        parentId: null,
        path: null,
        side: null,
        line: null,
        startLine: null,
        version: 1,
        body: 'Love the volcano photo!',
        suggestion: null,
        suggestionStatus: null,
        outdated: false,
        createdAt: ago(3 * HOUR),
      },
    ],
    conflictPaths: [],
    mergedSha: null,
    mergedById: null,
    mergedAt: null,
    revertedSha: null,
    revertedById: null,
    revertedAt: null,
    taskId: 'task-gallery',
  };

  const contact: DemoSubmission = {
    id: 'sub-contact',
    title: 'Add a contact form',
    description: 'A Contact page with a simple form, and a Contact link in the menu.',
    status: 'approved',
    authorId: SARA,
    version: 2,
    createdAt: ago(1 * DAY + 4 * HOUR),
    updatedAt: ago(2 * HOUR),
    baseSha: mainSha,
    headSha: fakeSha('sub-contact-v2'),
    rejectReason: null,
    closedAt: null,
    files: [
      { path: 'contact.html', change: 'added', base: null, head: v.contactHtml },
      { path: 'index.html', change: 'modified', base: v.indexMain, head: v.indexWithContact },
    ],
    reviews: [
      {
        id: 'review-contact-1',
        reviewer: ref(LEO),
        decision: 'changes_requested',
        body: 'The email box should check that it is a real email address (type="email").',
        version: 1,
        stale: true,
        createdAt: ago(20 * HOUR),
      },
      {
        id: 'review-contact-2',
        reviewer: ref(LEO),
        decision: 'approved',
        body: 'Works great now. Ready to merge!',
        version: 2,
        stale: false,
        createdAt: ago(2 * HOUR),
      },
    ],
    comments: [],
    conflictPaths: [],
    mergedSha: null,
    mergedById: null,
    mergedAt: null,
    revertedSha: null,
    revertedById: null,
    revertedAt: null,
    taskId: 'task-contact',
  };

  const nav: DemoSubmission = {
    id: 'sub-nav',
    title: 'Add the navigation bar',
    description: 'A menu at the top of the home page, so people can find the other pages.',
    status: 'merged',
    authorId: MAYA,
    version: 1,
    createdAt: ago(2 * DAY),
    updatedAt: ago(1 * DAY),
    baseSha: beforeNavSha,
    headSha: fakeSha('sub-nav-v1'),
    rejectReason: null,
    closedAt: null,
    files: [
      { path: 'index.html', change: 'modified', base: v.indexBeforeNav, head: v.indexMain },
      { path: 'style.css', change: 'modified', base: v.styleBeforeNav, head: v.styleMain },
    ],
    reviews: [
      {
        id: 'review-nav-1',
        reviewer: ref(ME),
        decision: 'approved',
        body: 'Looks clean. Thanks Maya!',
        version: 1,
        stale: false,
        createdAt: ago(1 * DAY + 2 * HOUR),
      },
    ],
    comments: [],
    conflictPaths: [],
    mergedSha: mainSha,
    mergedById: ME,
    mergedAt: ago(1 * DAY),
    revertedSha: null,
    revertedById: null,
    revertedAt: null,
    taskId: 'task-menu',
  };

  const dark: DemoSubmission = {
    id: 'sub-dark',
    title: 'Add a dark mode button',
    description: 'A button in the header that switches the site to dark colours.',
    status: 'changes_requested',
    authorId: SARA,
    version: 1,
    createdAt: ago(9 * HOUR),
    updatedAt: ago(6 * HOUR),
    baseSha: mainSha,
    headSha: fakeSha('sub-dark-v1'),
    rejectReason: null,
    closedAt: null,
    files: [
      { path: 'script.js', change: 'modified', base: v.scriptMain, head: v.scriptDark },
      { path: 'style.css', change: 'modified', base: v.styleMain, head: v.styleDark },
    ],
    reviews: [
      {
        id: 'review-dark-1',
        reviewer: ref(MAYA),
        decision: 'changes_requested',
        body: 'Cool idea! Two things: the links in the menu are hard to read in dark mode, and the choice is forgotten when you open another page. Could you save it?',
        version: 1,
        stale: false,
        createdAt: ago(6 * HOUR),
      },
    ],
    comments: [],
    conflictPaths: [],
    mergedSha: null,
    mergedById: null,
    mergedAt: null,
    revertedSha: null,
    revertedById: null,
    revertedAt: null,
    taskId: 'task-dark',
  };

  // ---------- Tasks ----------
  const task = (t: Partial<DemoTask> & Pick<DemoTask, 'id' | 'title' | 'status'>): DemoTask => ({
    description: '',
    dueDate: null,
    position: 1,
    assigneeIds: [ME],
    createdById: ME,
    doneConfirmPending: false,
    reopenNote: null,
    createdAt: ago(6 * DAY),
    updatedAt: ago(6 * DAY),
    completedAt: null,
    ...t,
  });
  const tasks: DemoTask[] = [
    task({
      id: 'task-photo',
      title: 'Add our class photo to the home page',
      status: 'todo',
      position: 1,
      assigneeIds: [LEO],
      dueDate: dayFromNow(5),
      description: 'Use the photo from the first day of school (ask the teacher which one).',
    }),
    task({
      id: 'task-footer',
      title: 'Fix the footer on phones',
      status: 'todo',
      position: 2,
      assigneeIds: [SARA],
      description: 'The footer text is too big on small screens.',
    }),
    task({
      id: 'task-about',
      title: 'Write the About us page',
      status: 'in_progress',
      position: 1,
      assigneeIds: [ME],
      dueDate: dayFromNow(2),
      description: 'Who we are, our class pets, and our favourite things.',
      updatedAt: ago(2 * HOUR),
    }),
    task({
      id: 'task-gallery',
      title: 'Photo gallery page',
      status: 'in_review',
      position: 1,
      assigneeIds: [LEO],
      createdById: MAYA,
      updatedAt: ago(5 * HOUR),
    }),
    task({
      id: 'task-contact',
      title: 'Make a contact page',
      status: 'in_review',
      position: 2,
      assigneeIds: [SARA],
      updatedAt: ago(1 * DAY + 4 * HOUR),
    }),
    task({
      id: 'task-dark',
      title: 'Dark mode',
      status: 'in_review',
      position: 3,
      assigneeIds: [SARA],
      createdById: SARA,
      updatedAt: ago(9 * HOUR),
    }),
    task({
      id: 'task-menu',
      title: 'Add a menu to every page',
      status: 'done',
      position: 1,
      assigneeIds: [MAYA],
      completedAt: ago(1 * DAY),
      updatedAt: ago(1 * DAY),
    }),
    task({
      id: 'task-setup',
      title: 'Set up the project',
      status: 'done',
      position: 2,
      assigneeIds: [ME],
      completedAt: ago(7 * DAY),
      updatedAt: ago(7 * DAY),
    }),
  ];

  // ---------- AI cross-review of the gallery (three models) ----------
  const finding = (
    path: string,
    snippet: string,
    content: string,
    severity: 'high' | 'medium' | 'low',
    title: string,
    detail: string,
  ) => ({ path, line: lineOf(content, snippet), severity, title, detail });
  const aiBase = {
    submissionId: gallery.id,
    version: 1,
    requestedBy: ref(ME),
    source: 'auto' as const,
    isFree: true,
    status: 'done' as const,
    parseError: false,
    raw: null,
    error: null,
    errorCode: null,
    createdAt: ago(2 * HOUR + 20),
  };
  const aiReviews: AiReviewView[] = [
    {
      ...aiBase,
      id: 'ai-gallery-qwen',
      model: 'qwen/qwen3-coder:free',
      requestedModel: 'qwen/qwen3-coder:free',
      finishedAt: ago(2 * HOUR + 18),
      findings: [
        finding(
          'script.js',
          "document.querySelectorAll('img')",
          v.scriptGallery,
          'medium',
          'Selects every image on the page',
          'querySelectorAll("img") also matches the lightbox image itself and any logo, so clicking those opens the lightbox too. Use ".gallery img".',
        ),
        finding(
          'gallery.html',
          'id="lightbox-image"',
          v.galleryHtml,
          'low',
          'Empty alt text on the big image',
          'The big image starts with alt="" and is only filled in by JavaScript. That is fine, but screen readers will skip it until a photo is opened.',
        ),
      ],
    },
    {
      ...aiBase,
      id: 'ai-gallery-llama',
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      requestedModel: 'meta-llama/llama-3.3-70b-instruct:free',
      finishedAt: ago(2 * HOUR + 17),
      findings: [
        finding(
          'script.js',
          "document.querySelectorAll('img')",
          v.scriptGallery,
          'medium',
          'Lightbox also catches clicks on itself',
          'Because the lightbox image is an <img>, it gets a click handler too. Narrow the selector to the gallery photos.',
        ),
        finding(
          'script.js',
          "lightbox.addEventListener('click'",
          v.scriptGallery,
          'low',
          'No way to close with the keyboard',
          'Let people press Escape to close the lightbox, so it also works without a mouse.',
        ),
      ],
    },
    {
      ...aiBase,
      id: 'ai-gallery-mistral',
      model: 'mistralai/mistral-small-3.2-24b-instruct:free',
      requestedModel: 'mistralai/mistral-small-3.2-24b-instruct:free',
      finishedAt: ago(2 * HOUR + 15),
      findings: [
        finding(
          'style.css',
          'grid-template-columns',
          v.styleGallery,
          'low',
          'Photos may be small on phones',
          'minmax(12rem, 1fr) gives one narrow column on small screens. Something like minmax(10rem, 1fr) fits two.',
        ),
      ],
    },
  ];

  // ---------- Activity (newest first) ----------
  let activityId = 0;
  const act = (
    minutesAgo: number,
    action: string,
    actorId: string | null,
    target: string | null,
    data: Record<string, unknown> = {},
  ): ActivityEntry => ({
    id: `activity-${++activityId}`,
    action,
    actorId,
    actorName: actorId ? ref(actorId).name : null,
    target,
    data,
    createdAt: ago(minutesAgo),
  });
  const activity: ActivityEntry[] = [
    act(2 * HOUR, 'submission.reviewed', LEO, contact.id, { decision: 'approved' }),
    act(3 * HOUR, 'submission.commented', SARA, gallery.id),
    act(3 * HOUR + 10, 'submission.commented', MAYA, gallery.id),
    act(4 * HOUR, 'submission.commented', MAYA, gallery.id),
    act(5 * HOUR, 'task.moved', null, 'task-gallery', {
      title: 'Photo gallery page',
      from: 'in_progress',
      to: 'in_review',
      automatic: true,
    }),
    act(5 * HOUR, 'submission.created', LEO, gallery.id, { title: gallery.title }),
    act(6 * HOUR, 'submission.reviewed', MAYA, dark.id, { decision: 'changes_requested' }),
    act(9 * HOUR, 'submission.created', SARA, dark.id, { title: dark.title }),
    act(1 * DAY, 'task.done_confirmed', ME, 'task-menu', {
      title: 'Add a menu to every page',
      done: true,
    }),
    act(1 * DAY, 'submission.merged', ME, nav.id, { title: nav.title, sha: mainSha }),
    act(1 * DAY + 4 * HOUR, 'submission.created', SARA, contact.id, { title: contact.title }),
    act(2 * DAY, 'submission.created', MAYA, nav.id, { title: nav.title }),
    act(5 * DAY, 'task.created', MAYA, 'task-gallery', { title: 'Photo gallery page' }),
    act(6 * DAY, 'member.joined', SARA, null),
    act(6 * DAY + 2 * HOUR, 'member.permissions_changed', ME, LEO, {
      memberName: 'Leo Martins',
    }),
    act(6 * DAY + 3 * HOUR, 'member.role_changed', ME, MAYA, {
      memberName: 'Maya Chen',
      to: 'co_leader',
    }),
    act(7 * DAY, 'member.joined', LEO, null),
    act(7 * DAY, 'member.joined', MAYA, null),
    act(7 * DAY, 'repository.created', ME, null, { template: 'html' }),
    act(7 * DAY + 10, 'project.created', ME, null),
  ];

  // ---------- Notifications for Demo Leader (newest first) ----------
  const project = { id: SAMPLE_PROJECT_ID, name: 'Class Website' };
  const notifications: NotificationView[] = [
    {
      id: 'notification-ai',
      type: 'ai_review.finished',
      project,
      data: {
        submissionId: gallery.id,
        title: gallery.title,
        done: 3,
        failed: 0,
        findingCount: 5,
      },
      readAt: null,
      createdAt: ago(2 * HOUR + 15),
    },
    {
      id: 'notification-gallery',
      type: 'submission.opened',
      project,
      data: { submissionId: gallery.id, title: gallery.title, actorName: 'Leo Martins' },
      readAt: null,
      createdAt: ago(5 * HOUR),
    },
    {
      id: 'notification-dark',
      type: 'submission.opened',
      project,
      data: { submissionId: dark.id, title: dark.title, actorName: 'Sara Okafor' },
      readAt: ago(8 * HOUR),
      createdAt: ago(9 * HOUR),
    },
    {
      id: 'notification-contact',
      type: 'submission.opened',
      project,
      data: { submissionId: contact.id, title: contact.title, actorName: 'Sara Okafor' },
      readAt: ago(1 * DAY),
      createdAt: ago(1 * DAY + 4 * HOUR),
    },
    {
      id: 'notification-joined',
      type: 'invitation.accepted',
      project,
      data: { userId: SARA, userName: 'Sara Okafor' },
      readAt: ago(6 * DAY),
      createdAt: ago(6 * DAY),
    },
  ];

  const sampleProject: DemoProject = {
    id: SAMPLE_PROJECT_ID,
    name: 'Class Website',
    teamId: SAMPLE_TEAM_ID,
    createdAt: ago(7 * DAY + 10),
    settings: {
      requireApproval: true,
      membersCanBrowseCopies: false,
      copyUpdateMode: 'automatic',
      githubMode: 'publish_once',
      aiReviewEnabled: true,
    },
    members: [
      { userId: ME, role: 'leader', permissions: ALL_PERMISSIONS, joinedAt: ago(7 * DAY + 10) },
      { userId: MAYA, role: 'co_leader', permissions: ALL_PERMISSIONS, joinedAt: ago(7 * DAY) },
      {
        userId: LEO,
        role: 'member',
        permissions: { ...DEFAULT_MEMBER_PERMISSIONS, approve: true, comment: true },
        joinedAt: ago(7 * DAY),
      },
      {
        userId: SARA,
        role: 'member',
        permissions: { ...DEFAULT_MEMBER_PERMISSIONS, comment: true },
        joinedAt: ago(6 * DAY),
      },
    ],
    invitations: [],
    repository: { status: 'ready', source: 'template', template: 'html' },
    commits,
    main: mainFiles(),
    copies: {
      [ME]: {
        id: '8f14e45f-ceea-467a-9575-0000000000a1',
        createdAt: ago(7 * DAY),
        lastActiveAt: ago(2 * HOUR),
        baseSha: mainSha,
        base: mainFiles(),
        // Work in progress for "Write the About us page".
        changes: { 'about.html': v.aboutHtml, 'README.md': v.readmeWithAbout },
        pendingConflictPaths: [],
      },
      [MAYA]: {
        id: '8f14e45f-ceea-467a-9575-0000000000a2',
        createdAt: ago(7 * DAY),
        lastActiveAt: ago(1),
        baseSha: mainSha,
        base: mainFiles(),
        changes: {},
        pendingConflictPaths: [],
      },
      [LEO]: {
        id: '8f14e45f-ceea-467a-9575-0000000000a3',
        createdAt: ago(7 * DAY),
        lastActiveAt: ago(3 * HOUR),
        baseSha: mainSha,
        base: mainFiles(),
        changes: {},
        pendingConflictPaths: [],
      },
      [SARA]: {
        id: '8f14e45f-ceea-467a-9575-0000000000a4',
        createdAt: ago(6 * DAY),
        lastActiveAt: ago(6 * HOUR),
        baseSha: mainSha,
        base: mainFiles(),
        changes: {},
        pendingConflictPaths: [],
      },
    },
    submissions: [gallery, contact, dark, nav],
    tasks,
    activity,
    presence: [
      {
        user: ref(MAYA),
        state: 'active',
        file: 'src/app.js',
        copyOwner: null,
        lastSeenAt: ago(0),
      },
      { user: ref(LEO), state: 'online', file: null, copyOwner: null, lastSeenAt: ago(2) },
      { user: ref(SARA), state: 'offline', file: null, copyOwner: null, lastSeenAt: ago(5 * HOUR) },
      { user: ref(ME), state: 'online', file: null, copyOwner: null, lastSeenAt: ago(0) },
    ],
    aiReviews,
    gettingStartedHidden: false,
    previewed: false,
  };

  return {
    version: STATE_VERSION,
    loggedIn: true,
    meId: ME,
    users,
    teams: [{ id: SAMPLE_TEAM_ID, name: 'Demo Team', ownerId: ME, createdAt: ago(7 * DAY + 20) }],
    projects: [sampleProject],
    notifications,
    shareOpenFile: true,
    allowPaidModels: false,
    seq: 100,
  };
}
