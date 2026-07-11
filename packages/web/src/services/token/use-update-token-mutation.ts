import { useMutation } from "@tanstack/react-query";

import { QgridService } from "../services.generated";

export type UpdateTokenParams = {
  id: number;
  name?: string;
  quotaThreshold?: number | null;
  weight?: number;
};

export function useUpdateTokenMutation() {
  return useMutation({
    mutationFn: ({ id, name, quotaThreshold, weight }: UpdateTokenParams) =>
      QgridService.updateToken(id, name, quotaThreshold, weight),
  });
}
