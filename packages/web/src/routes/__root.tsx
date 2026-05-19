import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

import App from "@/App";
import { SonamuProvider } from "@/contexts/sonamu-provider";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0" },
      { title: "Qgrid" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <html lang="en">
      <head>
        <link rel="icon" type="image/svg+xml" href="/sonamu.svg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300..700;1,9..40,300..700&family=DM+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <HeadContent />
      </head>
      <body>
        <div id="root">
          <QueryClientProvider client={queryClient}>
            <SonamuProvider>
              <App>
                <Outlet />
              </App>
            </SonamuProvider>
          </QueryClientProvider>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
