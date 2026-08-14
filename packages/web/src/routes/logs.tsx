import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { RequestLogTable } from "@/components/qgrid/RequestLogTable";

const logsSearchSchema = z.object({
  token: z.string().optional(),
  project: z.string().optional(),
  model: z.string().optional(),
  /** `컬럼-방향` (예: cost_usd-desc). 미지정이면 기본 정렬(id-desc). */
  sort: z.string().optional(),
  /** structured 응답이 깨진(JSON 파싱 실패) 행만 보기 */
  broken: z.boolean().optional(),
  page: z.number().optional().default(1),
});
export type LogsSearch = z.infer<typeof logsSearchSchema>;

export const Route = createFileRoute("/logs")({
  validateSearch: logsSearchSchema,
  component: LogsPage,
});

function LogsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div className="max-w-[100rem] mx-auto">
      <RequestLogTable search={search} onSearchChange={(next) => navigate({ search: next })} />
    </div>
  );
}
