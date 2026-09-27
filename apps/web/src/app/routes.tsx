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
import { MembersPage } from '../pages/project/MembersPage';
import { OverviewPage } from '../pages/project/OverviewPage';
import { ProjectLayout } from '../pages/project/ProjectLayout';
import { SettingsPage } from '../pages/project/SettingsPage';

export const routes: RouteObject[] = [
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
