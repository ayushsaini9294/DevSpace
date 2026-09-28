import type { RouteObject } from 'react-router';
import { Layout } from './Layout';
import { RequireAuth } from '../components/RequireAuth';
import { HomePage } from '../pages/HomePage';
import { InvitePage } from '../pages/InvitePage';
import { LogInPage } from '../pages/LogInPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { SignUpPage } from '../pages/SignUpPage';
import { TeamPage } from '../pages/TeamPage';
import { ActivityPage } from '../pages/project/ActivityPage';
import { IdePage } from '../pages/project/IdePage';
import { MembersPage } from '../pages/project/MembersPage';
import { OverviewPage } from '../pages/project/OverviewPage';
import { ProjectLayout } from '../pages/project/ProjectLayout';
import { SettingsPage } from '../pages/project/SettingsPage';
import { BlobPage } from '../pages/project/repository/BlobPage';
import { FilesPage } from '../pages/project/repository/FilesPage';
import { ReviewPage } from '../pages/project/submissions/ReviewPage';
import { SubmissionsPage } from '../pages/project/submissions/SubmissionsPage';
import { NewSubmissionPage, UpdateSubmissionPage } from '../pages/project/submissions/SubmitPage';
import { TasksPage } from '../pages/project/tasks/TasksPage';

export const routes: RouteObject[] = [
  // The IDE fills the whole window, so it sits outside the normal page layout.
  {
    element: <RequireAuth />,
    children: [
      { path: 'projects/:projectId/ide', element: <IdePage /> },
      // A leader or co-leader in a member's copy (Phase 7): the same page, for that copy.
      { path: 'projects/:projectId/members/:userId/ide', element: <IdePage /> },
    ],
  },
  {
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'login', element: <LogInPage /> },
      { path: 'signup', element: <SignUpPage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: 'teams/:teamId', element: <TeamPage /> },
          {
            path: 'projects/:projectId',
            element: <ProjectLayout />,
            children: [
              { index: true, element: <OverviewPage /> },
              { path: 'files/*', element: <FilesPage /> },
              { path: 'blob/*', element: <BlobPage /> },
              { path: 'submissions', element: <SubmissionsPage /> },
              { path: 'submissions/new', element: <NewSubmissionPage /> },
              { path: 'submissions/:submissionId', element: <ReviewPage /> },
              { path: 'submissions/:submissionId/update', element: <UpdateSubmissionPage /> },
              { path: 'tasks', element: <TasksPage /> },
              { path: 'members', element: <MembersPage /> },
              { path: 'activity', element: <ActivityPage /> },
              { path: 'settings', element: <SettingsPage /> },
            ],
          },
          { path: 'invite/:token', element: <InvitePage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
