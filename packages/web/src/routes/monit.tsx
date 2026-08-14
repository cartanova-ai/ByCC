import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { MonitConsole } from "@/components/qgrid/MonitConsole";

const monitSearchSchema = z.object({
  // 직접 호출 모드 전환으로 scaling 뷰(워커 증감 관측)는 사라졌다.
  // 북마크된 ?level=scaling 같은 옛 URL 은 all 로 조용히 강등한다.
  level: z
    .enum(["all", "warn", "error"])
    .optional()
    .default("all")
    .catch(() => "all" as const),
});
export type MonitSearch = z.infer<typeof monitSearchSchema>;

export const Route = createFileRoute("/monit")({
  validateSearch: monitSearchSchema,
  component: MonitPage,
});

function MonitPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div className="max-w-[100rem] mx-auto">
      <MonitConsole
        search={search}
        // 필터 토글마다 히스토리를 쌓지 않도록 replace — 공유/새로고침 시 URL 이 필터를 복원한다.
        onSearchChange={(next) => navigate({ search: next, replace: true })}
      />
    </div>
  );
}
