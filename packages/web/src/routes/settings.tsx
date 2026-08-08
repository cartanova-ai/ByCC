import { createFileRoute } from "@tanstack/react-router";

import { SettingsPanel } from "@/components/qgrid/SettingsPanel";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="max-w-4xl mx-auto">
      <SettingsPanel />
    </div>
  );
}
