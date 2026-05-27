import { Link, useRouterState } from "@tanstack/react-router";
import type React from "react";
import ActivityIcon from "~icons/lucide/file-text";
import GaugeIcon from "~icons/lucide/home";
import KeyRoundIcon from "~icons/lucide/key-round";

interface MenuSection {
  label: string;
  items: { title: string; path: string; icon: React.FC<React.SVGProps<SVGSVGElement>> }[];
}

const sections: MenuSection[] = [
  {
    label: "Overview",
    items: [{ title: "Dashboard", path: "/", icon: GaugeIcon }],
  },
  {
    label: "Manage",
    items: [
      { title: "Tokens", path: "/tokens", icon: KeyRoundIcon },
      { title: "Request Logs", path: "/logs", icon: ActivityIcon },
    ],
  },
];

interface SidebarProps {
  className?: string;
}

export default function Sidebar({ className }: SidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const isActive = (path: string) => {
    if (path === "/") return pathname === "/" || pathname === "";
    return pathname.startsWith(path);
  };

  return (
    <aside
      className={`hidden md:flex w-[200px] bg-sand-50 flex-col shrink-0 border-r border-sand-200/40 ${className ?? ""}`}
    >
      <div className="h-11 flex items-center px-4 border-b border-sand-200/30">
        <span className="text-[13px] font-semibold text-sand-800 tracking-tight">Qgrid</span>
      </div>

      <nav className="flex-1 px-2.5 py-3 space-y-4 overflow-y-auto">
        {sections.map((section) => (
          <div key={section.label}>
            <div className="px-2 pb-1.5">
              <span className="text-[10px] uppercase tracking-[0.08em] text-sand-400 font-medium">
                {section.label}
              </span>
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const active = isActive(item.path);
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={`flex items-center gap-2 px-2 py-[6px] rounded-[7px] text-[13px] no-underline transition-all duration-150 ${
                      active
                        ? "bg-sand-200/60 text-sand-900 font-medium"
                        : "text-sand-500 hover:bg-sand-100 hover:text-sand-700"
                    }`}
                    style={
                      active
                        ? {
                            boxShadow:
                              "0 0.5px 1px rgba(0,0,0,0.04), inset 0 0.5px 0 rgba(255,255,255,0.6)",
                          }
                        : undefined
                    }
                  >
                    <item.icon
                      className={`size-[15px] shrink-0 ${active ? "text-sienna-500" : "text-sand-400"}`}
                    />
                    <span>{item.title}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-4 py-3 border-t border-sand-200/30">
        <div className="flex items-center gap-2">
          <div className="size-1.5 rounded-full bg-sage-400" />
          <span className="text-[10px] text-sand-400">v0.1.0</span>
        </div>
      </div>
    </aside>
  );
}
