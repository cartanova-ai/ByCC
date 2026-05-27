import { createFileRoute } from "@tanstack/react-router";

import { UsageCard } from "@/components/qgrid/UsageCard";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  return (
    <div className="max-w-6xl mx-auto">
      <UsageCard />
    </div>
  );
}
