import type { RouteObject } from 'react-router';
import { DemoAuthPage } from './DemoAuthPage';
import { DemoRoot } from './DemoBanner';
import { DemoIdePage } from './DemoIdePage';

const IDE_PATHS = new Set(['projects/:projectId/ide', 'projects/:projectId/members/:userId/ide']);

function demoRoute(route: RouteObject, isRoot: boolean): RouteObject {
  let element = route.element;
  if (isRoot) element = <DemoRoot />;
  else if (route.path === 'login') element = <DemoAuthPage mode="login" />;
  else if (route.path === 'signup') element = <DemoAuthPage mode="signup" />;
  else if (route.path && IDE_PATHS.has(route.path)) element = <DemoIdePage />;

  if (route.index) return { ...route, element };
  return { ...route, element, children: route.children?.map((child) => demoRoute(child, false)) };
}

/**
 * The app's routes for the demo build: the root shows the demo banner (and opens no live
 * connection), log-in and sign-up let the visitor straight in, and the IDE pages explain what
 * the real IDE does. Every other page is the real one.
 */
export function demoRoutes(routes: RouteObject[]): RouteObject[] {
  return routes.map((route) => demoRoute(route, true));
}
