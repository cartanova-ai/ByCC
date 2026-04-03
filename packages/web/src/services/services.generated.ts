/**
 * @generated
 * 직접 수정하지 마세요.
 */
/** biome-ignore-all lint: generated는 무시 */
/** biome-ignore-all assist: generated는 무시 */

import type { AsyncIdConfig } from "@sonamu-kit/react-components/components";
import {
  queryOptions,
  type UseMutationOptions,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import type { AxiosProgressEvent } from "axios";
import qs from "qs";
import { CliResult, HealthResponse, TokenStats } from "./bycc/bycc.types";
import {
  type EventHandlers,
  type FilterQuery,
  fetch,
  type ListResult,
  type SSEStreamOptions,
  toFormData,
  useSSEStream,
} from "./sonamu.shared";

export namespace ByccService {
  export async function query(
    prompt: string,
    system?: string,
    timeout?: number,
  ): Promise<CliResult> {
    return fetch({
      method: "POST",
      url: `/api/bycc/query`,
      data: { prompt, system, timeout },
    });
  }

  export const useQueryMutation = () =>
    useMutation({
      mutationFn: (params: { prompt: string; system: string; timeout: number }) =>
        query(params.prompt, params.system, params.timeout),
    });

  export async function stats(): Promise<TokenStats[]> {
    return fetch({
      method: "GET",
      url: `/api/bycc/stats`,
    });
  }

  export const statsQueryOptions = () =>
    queryOptions({
      queryKey: ["Bycc", "stats"],
      queryFn: () => stats(),
    });

  export const useStats = (options?: { enabled?: boolean }) =>
    useQuery({
      ...statsQueryOptions(),
      ...options,
    });

  export async function addToken(token: string, name?: string): Promise<{ added: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/bycc/addToken`,
      data: { token, name },
    });
  }

  export const useAddTokenMutation = () =>
    useMutation({
      mutationFn: (params: { token: string; name: string }) => addToken(params.token, params.name),
    });

  export async function updateToken(
    token: string,
    name?: string,
    newToken?: string,
  ): Promise<{ updated: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/bycc/updateToken`,
      data: { token, name, newToken },
    });
  }

  export const useUpdateTokenMutation = () =>
    useMutation({
      mutationFn: (params: { token: string; name: string; newToken: string }) =>
        updateToken(params.token, params.name, params.newToken),
    });

  export async function removeToken(token: string): Promise<{ removed: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/bycc/removeToken`,
      data: { token },
    });
  }

  export const useRemoveTokenMutation = () =>
    useMutation({
      mutationFn: (params: { token: string }) => removeToken(params.token),
    });

  export async function health(): Promise<HealthResponse> {
    return fetch({
      method: "GET",
      url: `/api/bycc/health`,
    });
  }

  export const healthQueryOptions = () =>
    queryOptions({
      queryKey: ["Bycc", "health"],
      queryFn: () => health(),
    });

  export const useHealth = (options?: { enabled?: boolean }) =>
    useQuery({
      ...healthQueryOptions(),
      ...options,
    });
}
