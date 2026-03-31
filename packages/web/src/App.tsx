import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, Suspense, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import { SUPPORTED_LOCALES, setLocale } from "./i18n/sd.generated";

interface AppProps {
  children?: ReactNode;
}

const hideSidebarPaths = ["/login", "/signup"];

function App({ children }: AppProps) {
  useEffect(() => {
    const browserLocale = navigator.language.split("-")[0];
    if (SUPPORTED_LOCALES.includes(browserLocale as (typeof SUPPORTED_LOCALES)[number])) {
      setLocale(browserLocale as (typeof SUPPORTED_LOCALES)[number]);
    }
  }, []);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const showSidebar = !hideSidebarPaths.includes(pathname);

  return (
    <div className="flex h-screen w-full bg-white">
      {showSidebar && <Sidebar />}
      <main className="flex-1 overflow-auto p-4 md:p-8">
        <Suspense
          fallback={<div className="text-sand-400 text-center py-8 text-sm">로딩 중...</div>}
        >
          {children}
        </Suspense>
      </main>
    </div>
  );
}

export default App;
