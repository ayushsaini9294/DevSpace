import type { RouteObject } from 'react-router';
import { Layout } from './Layout';
import { HomePage } from '../pages/HomePage';
import { LogInPage } from '../pages/LogInPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { SignUpPage } from '../pages/SignUpPage';

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'login', element: <LogInPage /> },
      { path: 'signup', element: <SignUpPage /> },
      // Pages that need a logged-in user go under <RequireAuth /> (from Phase 3 on).
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
