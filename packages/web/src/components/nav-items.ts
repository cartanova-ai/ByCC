import type React from "react";
import ActivityIcon from "~icons/lucide/file-text";
import GaugeIcon from "~icons/lucide/home";
import KeyRoundIcon from "~icons/lucide/key-round";
import SettingsIcon from "~icons/lucide/settings";
import TerminalIcon from "~icons/lucide/terminal";

export type NavItem = {
  title: string;
  /** 좁은 화면 탭 바용 짧은 라벨. 없으면 title 을 쓴다. */
  shortTitle?: string;
  path: string;
  icon: React.FC<React.SVGProps<SVGSVGElement>>;
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

/** 사이드바(데스크톱)와 하단 탭 바(모바일)가 공유하는 단일 정의. */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [{ title: "Dashboard", path: "/", icon: GaugeIcon }],
  },
  {
    label: "Manage",
    items: [
      { title: "Tokens", path: "/tokens", icon: KeyRoundIcon },
      { title: "Request Logs", shortTitle: "Logs", path: "/logs", icon: ActivityIcon },
      { title: "Server Logs", shortTitle: "Server", path: "/monit", icon: TerminalIcon },
      { title: "Settings", path: "/settings", icon: SettingsIcon },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

export function isNavItemActive(path: string, pathname: string): boolean {
  if (path === "/") return pathname === "/" || pathname === "";
  return pathname.startsWith(path);
}
