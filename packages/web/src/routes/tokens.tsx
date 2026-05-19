import { createFileRoute } from "@tanstack/react-router";

import { AddTokenModal } from "@/components/qgrid/AddTokenModal";
import { TokenTable } from "@/components/qgrid/TokenTable";
import { TokenService } from "@/services/services.generated";

export const Route = createFileRoute("/tokens")({
  component: TokensPage,
});

function TokensPage() {
  const { data, isLoading } = TokenService.useTokens("A");

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-end">
        <AddTokenModal />
      </div>
      <TokenTable data={data?.rows} isLoading={isLoading} />
    </div>
  );
}
