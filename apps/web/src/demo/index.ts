/**
 * The demo build (VITE_DEMO=1): the real web app with an in-browser stand-in API and sample
 * data. main.tsx loads this module only behind the flag, so a normal build contains none of it.
 */
export { installDemoApi } from './standIn';
export { demoRoutes } from './routes';
