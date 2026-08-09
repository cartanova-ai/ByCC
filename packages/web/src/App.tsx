import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, Suspense, useEffect } from "react";

import { BottomNav } from "./components/BottomNav";
import { ChatWidget } from "./components/qgrid/ChatWidget";
import Sidebar from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
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
    <div className="flex h-screen w-full bg-sand-100 overflow-hidden font-sans">
      {showSidebar && <Sidebar />}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {showSidebar && <Toolbar />}
        <main className="flex-1 overflow-y-auto main-scroll content-inset">
          <div className="px-3 py-4 sm:px-6 sm:py-5 md:px-8">
            <Suspense
              fallback={<div className="text-sand-400 text-center py-8 text-sm">로딩 중...</div>}
            >
              {children}
            </Suspense>
          </div>
        </main>
        {showSidebar && <BottomNav />}
      </div>
      {/* 라우트 Suspense 바깥이라 페이지 이동에도 언마운트되지 않고 대화 상태가 유지된다 */}
      {showSidebar && <ChatWidget />}
    </div>
  );
}

export default App;
