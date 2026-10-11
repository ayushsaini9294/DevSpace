import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { routes } from './app/routes';
import { retryServerErrors } from './lib/api';
import './index.css';

async function start() {
  let appRoutes = routes;
  // The demo build (sample data, no server). Behind the flag, so a normal build leaves it out.
  if (import.meta.env.VITE_DEMO === '1') {
    const demo = await import('./demo');
    demo.installDemoApi();
    appRoutes = demo.demoRoutes(routes);
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: retryServerErrors } },
  });
  // BASE_URL is '/' normally; a demo hosted in a subfolder (GitHub Pages: /DevSpace/) sets it.
  const router = createBrowserRouter(appRoutes, {
    basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/',
  });

  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Root element #root not found');

  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
