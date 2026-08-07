import { Link, useRouterState } from "@tanstack/react-router";

import { isNavItemActive, NAV_ITEMS } from "./nav-items";

/**
 * 좁은 화면 전용 하단 탭 바.
 *
 * 사이드바는 `md` 미만에서 숨겨지는데, 그러면 URL 을 직접 치지 않는 한 페이지 이동이
 * 불가능해진다. 항목이 4개뿐이라 햄버거 메뉴보다 탭 바가 맞다 — 한 번의 탭으로 이동하고
 * 현재 위치도 항상 보인다.
 */
export function BottomNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="md:hidden shrink-0 border-t border-sand-200/60 bg-sand-50/95 backdrop-blur-sm pb-[env(safe-area-inset-bottom)]">
      <div className="flex">
        {NAV_ITEMS.map((item) => {
          const active = isNavItemActive(item.path, pathname);
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2 no-underline transition-colors duration-150 ${
                active ? "text-sienna-600" : "text-sand-500"
              }`}
            >
              <item.icon className={`size-5 ${active ? "text-sienna-500" : "text-sand-400"}`} />
              <span className={`text-[10px] ${active ? "font-medium" : ""}`}>
                {item.shortTitle ?? item.title}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
