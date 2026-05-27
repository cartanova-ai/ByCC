import { Link, useRouterState } from "@tanstack/react-router";

const ROUTE_TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/tokens": "Tokens",
  "/logs": "Request Logs",
};

function getBreadcrumb(pathname: string): {
  parent?: string;
  parentPath?: string;
  current: string;
} {
  if (pathname.startsWith("/requests/show")) {
    return { parent: "Request Logs", parentPath: "/logs", current: "Detail" };
  }
  return { current: ROUTE_TITLES[pathname] ?? pathname };
}

export function Toolbar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const crumb = getBreadcrumb(pathname);

  return (
    <div className="toolbar-glass h-11 shrink-0 flex items-center px-5">
      <nav className="flex items-center gap-1.5 text-[13px]">
        {crumb.parent && crumb.parentPath && (
          <>
            <Link
              to={crumb.parentPath}
              className="text-sand-400 hover:text-sand-600 transition-colors no-underline"
            >
              {crumb.parent}
            </Link>
            <span className="text-sand-300 select-none">/</span>
          </>
        )}
        <span className="font-medium text-sand-800">{crumb.current}</span>
      </nav>
    </div>
  );
}
