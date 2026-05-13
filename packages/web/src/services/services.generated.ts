/**
 * @generated
 * 직접 수정하지 마세요.
 */

/* oxlint-disable */

import { type AsyncIdConfig } from "@sonamu-kit/react-components/components";
import {
  queryOptions,
  useQuery,
  useInfiniteQuery,
  infiniteQueryOptions,
  useMutation,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { type AxiosProgressEvent } from "axios";
import qs from "qs";

import {
  Effort,
  CliResult,
  TokenStats,
  OAuthStartResult,
  UsageResponse,
  HealthResponse,
} from "./qgrid/qgrid.types";
import { RequestLogListParams, RequestLogSaveParams } from "./request-log/request-log.types";
import {
  TokenSubsetKey,
  TokenSubsetMapping,
  RequestLogSubsetKey,
  RequestLogSubsetMapping,
} from "./sonamu.generated";
import {
  type ListResult,
  type FilterQuery,
  fetch,
  type EventHandlers,
  type SSEStreamOptions,
  type WebSocketChannelOptions,
  useSSEStream,
  useWebSocketChannel,
  toFormData,
  dedupeAndFlatten,
  useRefreshable,
} from "./sonamu.shared";
import { TokenListParams, TokenSaveParams } from "./token/token.types";

export namespace TokenService {
  export async function getToken<T extends TokenSubsetKey>(
    subset: T,
    id: number,
  ): Promise<TokenSubsetMapping[T]> {
    return fetch({
      method: "GET",
      url: `/api/token/findById?${qs.stringify({ subset, id })}`,
    });
  }

  export const getTokenQueryOptions = <T extends TokenSubsetKey>(subset: T, id: number) =>
    queryOptions({
      queryKey: ["Token", "getToken", subset, id],
      queryFn: () => getToken(subset, id),
    });

  export const useToken = <T extends TokenSubsetKey>(
    subset: T,
    id: number,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useQuery({
        ...getTokenQueryOptions(subset, id),
        ...options,
      }),
    );

  export async function getTokens<T extends TokenSubsetKey, LP extends TokenListParams>(
    subset: T,
    rawParams?: LP,
  ): Promise<ListResult<LP, TokenSubsetMapping[T]>> {
    return fetch({
      method: "GET",
      url: `/api/token/findMany?${qs.stringify({ subset, rawParams })}`,
    });
  }

  export const getTokensQueryOptions = <T extends TokenSubsetKey, LP extends TokenListParams>(
    subset: T,
    rawParams?: LP,
  ) =>
    queryOptions({
      queryKey: ["Token", "getTokens", subset, rawParams],
      queryFn: () => getTokens(subset, rawParams),
    });

  export const useTokens = <T extends TokenSubsetKey, LP extends TokenListParams>(
    subset: T,
    rawParams?: LP,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useQuery({
        ...getTokensQueryOptions(subset, rawParams),
        ...options,
      }),
    );

  export const getTokensInfiniteQueryOptions = <
    T extends TokenSubsetKey,
    LP extends TokenListParams,
  >(
    subset: T,
    rawParams?: LP,
  ) =>
    infiniteQueryOptions({
      queryKey: ["Token", "getTokens", "infinite", subset, rawParams],
      queryFn: ({ pageParam }) => getTokens(subset, { ...rawParams, page: pageParam }),
      initialPageParam: 1 as number,
      getNextPageParam: (lastPage, allPages) => {
        const total = (lastPage as { total?: number })?.total ?? 0;
        const loaded = allPages.reduce(
          (sum, p) => sum + ((p as { rows?: unknown[] })?.rows?.length ?? 0),
          0,
        );
        return loaded < total ? allPages.length + 1 : undefined;
      },
      select: dedupeAndFlatten,
    });

  export const useTokensInfinite = <T extends TokenSubsetKey, LP extends TokenListParams>(
    subset: T,
    rawParams?: LP,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useInfiniteQuery({
        ...getTokensInfiniteQueryOptions(subset, rawParams),
        ...options,
      }),
    );

  export async function save(spa: TokenSaveParams[]): Promise<number[]> {
    return fetch({
      method: "POST",
      url: `/api/token/save`,
      data: { spa },
    });
  }

  export const useSaveMutation = () =>
    useMutation({
      mutationFn: (params: { spa: TokenSaveParams[] }) => save(params.spa),
    });

  export async function reorder(ids: number[]): Promise<{ done: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/token/reorder`,
      data: { ids },
    });
  }

  export const useReorderMutation = () =>
    useMutation({
      mutationFn: (params: { ids: number[] }) => reorder(params.ids),
    });

  export async function del(ids: number[]): Promise<number> {
    return fetch({
      method: "POST",
      url: `/api/token/del`,
      data: { ids },
    });
  }

  export const useDelMutation = () =>
    useMutation({
      mutationFn: (params: { ids: number[] }) => del(params.ids),
    });
}

export namespace RequestLogService {
  export async function getRequestLog<T extends RequestLogSubsetKey>(
    subset: T,
    id: number,
  ): Promise<RequestLogSubsetMapping[T]> {
    return fetch({
      method: "GET",
      url: `/api/requestLog/findById?${qs.stringify({ subset, id })}`,
    });
  }

  export const getRequestLogQueryOptions = <T extends RequestLogSubsetKey>(subset: T, id: number) =>
    queryOptions({
      queryKey: ["RequestLog", "getRequestLog", subset, id],
      queryFn: () => getRequestLog(subset, id),
    });

  export const useRequestLog = <T extends RequestLogSubsetKey>(
    subset: T,
    id: number,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useQuery({
        ...getRequestLogQueryOptions(subset, id),
        ...options,
      }),
    );

  export async function getRequestLogs<
    T extends RequestLogSubsetKey,
    LP extends RequestLogListParams,
  >(subset: T, rawParams?: LP): Promise<ListResult<LP, RequestLogSubsetMapping[T]>> {
    return fetch({
      method: "GET",
      url: `/api/requestLog/findMany?${qs.stringify({ subset, rawParams })}`,
    });
  }

  export const getRequestLogsQueryOptions = <
    T extends RequestLogSubsetKey,
    LP extends RequestLogListParams,
  >(
    subset: T,
    rawParams?: LP,
  ) =>
    queryOptions({
      queryKey: ["RequestLog", "getRequestLogs", subset, rawParams],
      queryFn: () => getRequestLogs(subset, rawParams),
    });

  export const useRequestLogs = <T extends RequestLogSubsetKey, LP extends RequestLogListParams>(
    subset: T,
    rawParams?: LP,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useQuery({
        ...getRequestLogsQueryOptions(subset, rawParams),
        ...options,
      }),
    );

  export const getRequestLogsInfiniteQueryOptions = <
    T extends RequestLogSubsetKey,
    LP extends RequestLogListParams,
  >(
    subset: T,
    rawParams?: LP,
  ) =>
    infiniteQueryOptions({
      queryKey: ["RequestLog", "getRequestLogs", "infinite", subset, rawParams],
      queryFn: ({ pageParam }) => getRequestLogs(subset, { ...rawParams, page: pageParam }),
      initialPageParam: 1 as number,
      getNextPageParam: (lastPage, allPages) => {
        const total = (lastPage as { total?: number })?.total ?? 0;
        const loaded = allPages.reduce(
          (sum, p) => sum + ((p as { rows?: unknown[] })?.rows?.length ?? 0),
          0,
        );
        return loaded < total ? allPages.length + 1 : undefined;
      },
      select: dedupeAndFlatten,
    });

  export const useRequestLogsInfinite = <
    T extends RequestLogSubsetKey,
    LP extends RequestLogListParams,
  >(
    subset: T,
    rawParams?: LP,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useInfiniteQuery({
        ...getRequestLogsInfiniteQueryOptions(subset, rawParams),
        ...options,
      }),
    );

  export async function save(spa: RequestLogSaveParams[]): Promise<number[]> {
    return fetch({
      method: "POST",
      url: `/api/requestLog/save`,
      data: { spa },
    });
  }

  export const useSaveMutation = () =>
    useMutation({
      mutationFn: (params: { spa: RequestLogSaveParams[] }) => save(params.spa),
    });

  export async function del(ids: number[]): Promise<number> {
    return fetch({
      method: "POST",
      url: `/api/requestLog/del`,
      data: { ids },
    });
  }

  export const useDelMutation = () =>
    useMutation({
      mutationFn: (params: { ids: number[] }) => del(params.ids),
    });
}

export namespace QgridService {
  export async function query(
    prompt: string,
    system?: string,
    timeout?: number,
    model?: string,
    projectName?: string,
    jsonSchema?: string,
    effort?: Effort,
  ): Promise<CliResult> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/query`,
      data: { prompt, system, timeout, model, projectName, jsonSchema, effort },
    });
  }

  export const useQueryMutation = () =>
    useMutation({
      mutationFn: (params: {
        prompt: string;
        system: string;
        timeout: number;
        model: string;
        projectName: string;
        jsonSchema: string;
        effort: Effort;
      }) =>
        query(
          params.prompt,
          params.system,
          params.timeout,
          params.model,
          params.projectName,
          params.jsonSchema,
          params.effort,
        ),
    });

  export async function stats(): Promise<TokenStats[]> {
    return fetch({
      method: "GET",
      url: `/api/qgrid/stats`,
    });
  }

  export const statsQueryOptions = () =>
    queryOptions({
      queryKey: ["Qgrid", "stats"],
      queryFn: () => stats(),
    });

  export const useStats = (options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...statsQueryOptions(),
        ...options,
      }),
    );

  export async function totalCost(tokenName?: string): Promise<{ usd: number }> {
    return fetch({
      method: "GET",
      url: `/api/qgrid/totalCost?${qs.stringify({ tokenName })}`,
    });
  }

  export const totalCostQueryOptions = (tokenName?: string) =>
    queryOptions({
      queryKey: ["Qgrid", "totalCost", tokenName],
      queryFn: () => totalCost(tokenName),
    });

  export const useTotalCost = (tokenName?: string, options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...totalCostQueryOptions(tokenName),
        ...options,
      }),
    );

  export async function projectNames(): Promise<{ names: string[] }> {
    return fetch({
      method: "GET",
      url: `/api/qgrid/projectNames`,
    });
  }

  export const projectNamesQueryOptions = () =>
    queryOptions({
      queryKey: ["Qgrid", "projectNames"],
      queryFn: () => projectNames(),
    });

  export const useProjectNames = (options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...projectNamesQueryOptions(),
        ...options,
      }),
    );

  export async function addToken(
    token: string,
    name: string,
    refreshToken?: string,
  ): Promise<{ added: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/addToken`,
      data: { token, name, refreshToken },
    });
  }

  export const useAddTokenMutation = () =>
    useMutation({
      mutationFn: (params: { token: string; name: string; refreshToken: string }) =>
        addToken(params.token, params.name, params.refreshToken),
    });

  export async function updateToken(
    token: string,
    name?: string,
    newToken?: string,
    refreshToken?: string,
  ): Promise<{ updated: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/updateToken`,
      data: { token, name, newToken, refreshToken },
    });
  }

  export const useUpdateTokenMutation = () =>
    useMutation({
      mutationFn: (params: {
        token: string;
        name: string;
        newToken: string;
        refreshToken: string;
      }) => updateToken(params.token, params.name, params.newToken, params.refreshToken),
    });

  export async function removeToken(token: string): Promise<{ removed: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/removeToken`,
      data: { token },
    });
  }

  export const useRemoveTokenMutation = () =>
    useMutation({
      mutationFn: (params: { token: string }) => removeToken(params.token),
    });

  export async function toggleToken(id: number): Promise<{ active: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/toggleToken`,
      data: { id },
    });
  }

  export const useToggleTokenMutation = () =>
    useMutation({
      mutationFn: (params: { id: number }) => toggleToken(params.id),
    });

  export async function oauthStart(name: string): Promise<OAuthStartResult> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/oauthStart`,
      data: { name },
    });
  }

  export const useOauthStartMutation = () =>
    useMutation({
      mutationFn: (params: { name: string }) => oauthStart(params.name),
    });

  export async function usage(tokenName?: string): Promise<UsageResponse> {
    return fetch({
      method: "GET",
      url: `/api/qgrid/usage?${qs.stringify({ tokenName })}`,
    });
  }

  export const usageQueryOptions = (tokenName?: string) =>
    queryOptions({
      queryKey: ["Qgrid", "usage", tokenName],
      queryFn: () => usage(tokenName),
    });

  export const useUsage = (tokenName?: string, options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...usageQueryOptions(tokenName),
        ...options,
      }),
    );

  export async function health(): Promise<HealthResponse> {
    return fetch({
      method: "GET",
      url: `/api/qgrid/health`,
    });
  }

  export const healthQueryOptions = () =>
    queryOptions({
      queryKey: ["Qgrid", "health"],
      queryFn: () => health(),
    });

  export const useHealth = (options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...healthQueryOptions(),
        ...options,
      }),
    );
}

// AsyncIdConfig: RequestLog
export const RequestLogAsyncIdConfig: AsyncIdConfig<
  RequestLogSubsetKey,
  RequestLogSubsetMapping,
  RequestLogListParams
> = {
  placeholderKey: "entity.RequestLog",
  useList: RequestLogService.useRequestLogs,
  useListInfinite: RequestLogService.useRequestLogsInfinite,
};

// AsyncIdConfig: Token
export const TokenAsyncIdConfig: AsyncIdConfig<
  TokenSubsetKey,
  TokenSubsetMapping,
  TokenListParams
> = {
  placeholderKey: "entity.Token",
  useList: TokenService.useTokens,
  useListInfinite: TokenService.useTokensInfinite,
};
