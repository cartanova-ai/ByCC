import { Link, useRouterState } from "@tanstack/react-router";
import type React from "react";
import HomeIcon from "~icons/lucide/home";
import KeyRoundIcon from "~icons/lucide/key-round";

interface MenuItemProps {
  title: string;
  path: string;
  icon?: React.FC<React.SVGProps<SVGSVGElement>>;
}

const menuItems: MenuItemProps[] = [
  { title: "Dashboard", path: "/", icon: HomeIcon },
  { title: "Tokens", path: "/tokens", icon: KeyRoundIcon },
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
      className={`hidden md:flex w-56 bg-sand-50 flex-col shrink-0 border-r border-sand-200 ${className ?? ""}`}
    >
      <div className="px-5 py-5 border-b border-sand-200">
        <span className="text-base font-semibold text-sand-900">ByCC</span>
        <p className="text-[11px] text-sand-400 mt-0.5">Token Management</p>
      </div>

      <nav className="flex-1 px-3 py-3 space-y-1">
        {menuItems.map((item) => {
          const active = isActive(item.path);
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm no-underline transition-colors duration-150 ${
                active
                  ? "bg-sand-100 text-sand-800 font-medium"
                  : "text-sand-500 hover:bg-sand-100/60 hover:text-sand-700"
              }`}
            >
              {item.icon && <item.icon className={`size-4 ${active ? "text-sienna-400" : ""}`} />}
              <span>{item.title}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
