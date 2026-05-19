import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { RequestLogTable } from "@/components/qgrid/RequestLogTable";

const logsSearchSchema = z.object({
  token: z.string().optional(),
  project: z.string().optional(),
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
    <div className="max-w-[96rem] mx-auto">
      <RequestLogTable search={search} onSearchChange={(next) => navigate({ search: next })} />
    </div>
  );
}
