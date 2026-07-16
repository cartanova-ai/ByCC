import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { MonitConsole } from "@/components/qgrid/MonitConsole";

const monitSearchSchema = z.object({
  // scaling 은 레벨이 아니라 뷰 모드 — autoscale/worker 증감 라인만 보여준다.
  level: z.enum(["all", "scaling", "warn", "error"]).optional().default("all"),
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
