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

import { MonitLogChunk, MonitServerInfo, MonitStats } from "./monit/monit.types";
import {
  QueryInput,
  QueryOutput,
  CreateRunInput,
  AppendStepInput,
  FinishRunInput,
  TokenStats,
  OAuthStartResult,
  UsageResponse,
  HealthResponse,
} from "./qgrid/qgrid.types";
import {
  RequestLogStepListParams,
  RequestLogStepSaveParams,
} from "./request-log-step/request-log-step.types";
import { RequestLogListParams, RequestLogSaveParams } from "./request-log/request-log.types";
import {
  SettingListParams,
  SettingsResponse,
  SettingApplies,
  SupervisorKind,
} from "./setting/setting.types";
import {
  TokenSubsetKey,
  TokenSubsetMapping,
  SettingSubsetKey,
  SettingSubsetMapping,
  RequestLogStepSubsetKey,
  RequestLogStepSubsetMapping,
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
import { TokenListParams, TokenSaveParams, TokenCredentials } from "./token/token.types";

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

export namespace SettingService {
  export async function getSetting<T extends SettingSubsetKey>(
    subset: T,
    id: number,
  ): Promise<SettingSubsetMapping[T]> {
    return fetch({
      method: "GET",
      url: `/api/setting/findById?${qs.stringify({ subset, id })}`,
    });
  }

  export const getSettingQueryOptions = <T extends SettingSubsetKey>(subset: T, id: number) =>
    queryOptions({
      queryKey: ["Setting", "getSetting", subset, id],
      queryFn: () => getSetting(subset, id),
    });

  export const useSetting = <T extends SettingSubsetKey>(
    subset: T,
    id: number,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useQuery({
        ...getSettingQueryOptions(subset, id),
        ...options,
      }),
    );

  export async function getSettings<T extends SettingSubsetKey, LP extends SettingListParams>(
    subset: T,
    rawParams?: LP,
  ): Promise<ListResult<LP, SettingSubsetMapping[T]>> {
    return fetch({
      method: "GET",
      url: `/api/setting/findMany?${qs.stringify({ subset, rawParams })}`,
    });
  }

  export const getSettingsQueryOptions = <T extends SettingSubsetKey, LP extends SettingListParams>(
    subset: T,
    rawParams?: LP,
  ) =>
    queryOptions({
      queryKey: ["Setting", "getSettings", subset, rawParams],
      queryFn: () => getSettings(subset, rawParams),
    });

  export const useSettings = <T extends SettingSubsetKey, LP extends SettingListParams>(
    subset: T,
    rawParams?: LP,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useQuery({
        ...getSettingsQueryOptions(subset, rawParams),
        ...options,
      }),
    );

  export const getSettingsInfiniteQueryOptions = <
    T extends SettingSubsetKey,
    LP extends SettingListParams,
  >(
    subset: T,
    rawParams?: LP,
  ) =>
    infiniteQueryOptions({
      queryKey: ["Setting", "getSettings", "infinite", subset, rawParams],
      queryFn: ({ pageParam }) => getSettings(subset, { ...rawParams, page: pageParam }),
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

  export const useSettingsInfinite = <T extends SettingSubsetKey, LP extends SettingListParams>(
    subset: T,
    rawParams?: LP,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useInfiniteQuery({
        ...getSettingsInfiniteQueryOptions(subset, rawParams),
        ...options,
      }),
    );

  export async function getSettingList(): Promise<SettingsResponse> {
    return fetch({
      method: "GET",
      url: `/api/setting/listSettings`,
    });
  }

  export const getSettingListQueryOptions = () =>
    queryOptions({
      queryKey: ["Setting", "getSettingList"],
      queryFn: () => getSettingList(),
    });

  export const useSettingList = (options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...getSettingListQueryOptions(),
        ...options,
      }),
    );

  export async function updateSetting(
    key: string,
    value: string,
  ): Promise<{ applies: SettingApplies }> {
    return fetch({
      method: "POST",
      url: `/api/setting/updateSetting`,
      data: { key, value },
    });
  }

  export const useUpdateSettingMutation = () =>
    useMutation({
      mutationFn: (params: { key: string; value: string }) =>
        updateSetting(params.key, params.value),
    });

  export async function resetSetting(key: string): Promise<{ applies: SettingApplies }> {
    return fetch({
      method: "POST",
      url: `/api/setting/resetSetting`,
      data: { key },
    });
  }

  export const useResetSettingMutation = () =>
    useMutation({
      mutationFn: (params: { key: string }) => resetSetting(params.key),
    });

  export async function triggerExpiryReminder(): Promise<{ sent: number }> {
    return fetch({
      method: "POST",
      url: `/api/setting/triggerExpiryReminder`,
    });
  }

  export const useTriggerExpiryReminderMutation = () =>
    useMutation({
      mutationFn: (params: void) => triggerExpiryReminder(),
    });

  export async function restartServer(): Promise<{ supervisor: SupervisorKind }> {
    return fetch({
      method: "POST",
      url: `/api/setting/restartServer`,
    });
  }

  export const useRestartServerMutation = () =>
    useMutation({
      mutationFn: (params: void) => restartServer(),
    });
}

export namespace RequestLogStepService {
  export async function getRequestLogStep<T extends RequestLogStepSubsetKey>(
    subset: T,
    id: number,
  ): Promise<RequestLogStepSubsetMapping[T]> {
    return fetch({
      method: "GET",
      url: `/api/requestLogStep/findById?${qs.stringify({ subset, id })}`,
    });
  }

  export const getRequestLogStepQueryOptions = <T extends RequestLogStepSubsetKey>(
    subset: T,
    id: number,
  ) =>
    queryOptions({
      queryKey: ["RequestLogStep", "getRequestLogStep", subset, id],
      queryFn: () => getRequestLogStep(subset, id),
    });

  export const useRequestLogStep = <T extends RequestLogStepSubsetKey>(
    subset: T,
    id: number,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useQuery({
        ...getRequestLogStepQueryOptions(subset, id),
        ...options,
      }),
    );

  export async function getRequestLogSteps<
    T extends RequestLogStepSubsetKey,
    LP extends RequestLogStepListParams,
  >(subset: T, rawParams?: LP): Promise<ListResult<LP, RequestLogStepSubsetMapping[T]>> {
    return fetch({
      method: "GET",
      url: `/api/requestLogStep/findMany?${qs.stringify({ subset, rawParams })}`,
    });
  }

  export const getRequestLogStepsQueryOptions = <
    T extends RequestLogStepSubsetKey,
    LP extends RequestLogStepListParams,
  >(
    subset: T,
    rawParams?: LP,
  ) =>
    queryOptions({
      queryKey: ["RequestLogStep", "getRequestLogSteps", subset, rawParams],
      queryFn: () => getRequestLogSteps(subset, rawParams),
    });

  export const useRequestLogSteps = <
    T extends RequestLogStepSubsetKey,
    LP extends RequestLogStepListParams,
  >(
    subset: T,
    rawParams?: LP,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useQuery({
        ...getRequestLogStepsQueryOptions(subset, rawParams),
        ...options,
      }),
    );

  export const getRequestLogStepsInfiniteQueryOptions = <
    T extends RequestLogStepSubsetKey,
    LP extends RequestLogStepListParams,
  >(
    subset: T,
    rawParams?: LP,
  ) =>
    infiniteQueryOptions({
      queryKey: ["RequestLogStep", "getRequestLogSteps", "infinite", subset, rawParams],
      queryFn: ({ pageParam }) => getRequestLogSteps(subset, { ...rawParams, page: pageParam }),
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

  export const useRequestLogStepsInfinite = <
    T extends RequestLogStepSubsetKey,
    LP extends RequestLogStepListParams,
  >(
    subset: T,
    rawParams?: LP,
    options?: { enabled?: boolean },
  ) =>
    useRefreshable(
      useInfiniteQuery({
        ...getRequestLogStepsInfiniteQueryOptions(subset, rawParams),
        ...options,
      }),
    );

  export async function save(spa: RequestLogStepSaveParams[]): Promise<number[]> {
    return fetch({
      method: "POST",
      url: `/api/requestLogStep/save`,
      data: { spa },
    });
  }

  export const useSaveMutation = () =>
    useMutation({
      mutationFn: (params: { spa: RequestLogStepSaveParams[] }) => save(params.spa),
    });

  export async function del(ids: number[]): Promise<number> {
    return fetch({
      method: "POST",
      url: `/api/requestLogStep/del`,
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

  export async function responseTypeTs(id: number): Promise<{ typescript: string | null }> {
    return fetch({
      method: "GET",
      url: `/api/requestLog/responseTypeTs?${qs.stringify({ id })}`,
    });
  }

  export const responseTypeTsQueryOptions = (id: number) =>
    queryOptions({
      queryKey: ["RequestLog", "responseTypeTs", id],
      queryFn: () => responseTypeTs(id),
    });

  export const useResponseTypeTs = (id: number, options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...responseTypeTsQueryOptions(id),
        ...options,
      }),
    );

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
  export async function query(args: QueryInput): Promise<QueryOutput> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/query`,
      data: { args },
    });
  }

  export const useQueryMutation = () =>
    useMutation({
      mutationFn: (params: { args: QueryInput }) => query(params.args),
    });

  export async function prepareStream(args: QueryInput): Promise<{ streamId: string }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/prepareStream`,
      data: { args },
    });
  }

  export const usePrepareStreamMutation = () =>
    useMutation({
      mutationFn: (params: { args: QueryInput }) => prepareStream(params.args),
    });

  export function useQueryStream(
    params: { streamId: string },
    handlers: EventHandlers<
      {
        delta: {
          text: string;
        };
        toolCall: {
          toolCallId: string;
          toolName: string;
          input: string;
        };
        done: {
          text: string;
          model?: string;
          requestedModel?: string;
          modelFallbacks?: {
            trigger: "refusal";
            fromModel: string;
            toModel: string;
            category?: string;
            explanation?: string;
          }[];
          tokenName?: string;
          finishReason: "stop" | "tool-calls";
          usage: {
            input_tokens: number;
            output_tokens: number;
            reasoning_tokens: number;
            cache_creation_input_tokens: number;
            cache_creation_5m_input_tokens?: number;
            cache_creation_1h_input_tokens?: number;
            cache_read_input_tokens: number;
          };
          durationMs: number;
          ttftMs: number;
          costUsd: number;
          costSource: "provider" | "pricing_table" | "mixed";
          content:
            | {
                type: "text";
                text: string;
              }
            | {
                type: "tool-call";
                toolCallId: string;
                toolName: string;
                input: string;
              }
            | {
                type: "image";
                data: string;
                revisedPrompt?: string | null;
              }[];
          runContext?: {
            requestLogId?: number;
            threadCoord?: {
              workerId: number;
              threadId: string;
              epoch: number;
              systemHash: string;
            };
          };
        };
        error: {
          message: string;
        };
      } & { end?: () => void }
    >,
    options: SSEStreamOptions,
  ) {
    return useSSEStream<{
      delta: {
        text: string;
      };
      toolCall: {
        toolCallId: string;
        toolName: string;
        input: string;
      };
      done: {
        text: string;
        model?: string;
        requestedModel?: string;
        modelFallbacks?: {
          trigger: "refusal";
          fromModel: string;
          toModel: string;
          category?: string;
          explanation?: string;
        }[];
        tokenName?: string;
        finishReason: "stop" | "tool-calls";
        usage: {
          input_tokens: number;
          output_tokens: number;
          reasoning_tokens: number;
          cache_creation_input_tokens: number;
          cache_creation_5m_input_tokens?: number;
          cache_creation_1h_input_tokens?: number;
          cache_read_input_tokens: number;
        };
        durationMs: number;
        ttftMs: number;
        costUsd: number;
        costSource: "provider" | "pricing_table" | "mixed";
        content:
          | {
              type: "text";
              text: string;
            }
          | {
              type: "tool-call";
              toolCallId: string;
              toolName: string;
              input: string;
            }
          | {
              type: "image";
              data: string;
              revisedPrompt?: string | null;
            }[];
        runContext?: {
          requestLogId?: number;
          threadCoord?: {
            workerId: number;
            threadId: string;
            epoch: number;
            systemHash: string;
          };
        };
      };
      error: {
        message: string;
      };
    }>(`/api/qgrid/queryStream`, params, handlers, options);
  }

  export async function createRun(input: CreateRunInput): Promise<{ requestLogId: number }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/createRun`,
      data: { input },
    });
  }

  export const useCreateRunMutation = () =>
    useMutation({
      mutationFn: (params: { input: CreateRunInput }) => createRun(params.input),
    });

  export async function appendStep(input: AppendStepInput): Promise<{ stepId: number }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/appendStep`,
      data: { input },
    });
  }

  export const useAppendStepMutation = () =>
    useMutation({
      mutationFn: (params: { input: AppendStepInput }) => appendStep(params.input),
    });

  export async function finishRun(input: FinishRunInput): Promise<{ ok: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/finishRun`,
      data: { input },
    });
  }

  export const useFinishRunMutation = () =>
    useMutation({
      mutationFn: (params: { input: FinishRunInput }) => finishRun(params.input),
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

  export async function totalCost(params?: RequestLogListParams): Promise<{ usd: number }> {
    return fetch({
      method: "GET",
      url: `/api/qgrid/totalCost?${qs.stringify({ params })}`,
    });
  }

  export const totalCostQueryOptions = (params?: RequestLogListParams) =>
    queryOptions({
      queryKey: ["Qgrid", "totalCost", params],
      queryFn: () => totalCost(params),
    });

  export const useTotalCost = (params?: RequestLogListParams, options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...totalCostQueryOptions(params),
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

  export async function modelNames(): Promise<{ names: string[] }> {
    return fetch({
      method: "GET",
      url: `/api/qgrid/modelNames`,
    });
  }

  export const modelNamesQueryOptions = () =>
    queryOptions({
      queryKey: ["Qgrid", "modelNames"],
      queryFn: () => modelNames(),
    });

  export const useModelNames = (options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...modelNamesQueryOptions(),
        ...options,
      }),
    );

  export async function addToken(
    provider: string,
    credentials: TokenCredentials,
    name: string,
  ): Promise<{ added: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/addToken`,
      data: { provider, credentials, name },
    });
  }

  export const useAddTokenMutation = () =>
    useMutation({
      mutationFn: (params: { provider: string; credentials: TokenCredentials; name: string }) =>
        addToken(params.provider, params.credentials, params.name),
    });

  export async function updateToken(
    id: number,
    name?: string,
    quotaThreshold?: number | null,
    weight?: number,
  ): Promise<{ updated: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/updateToken`,
      data: { id, name, quotaThreshold, weight },
    });
  }

  export async function removeToken(id: number): Promise<{ removed: boolean }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/removeToken`,
      data: { id },
    });
  }

  export const useRemoveTokenMutation = () =>
    useMutation({
      mutationFn: (params: { id: number }) => removeToken(params.id),
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

  export async function oauthComplete(
    pastedCode: string,
  ): Promise<{ added: boolean; name: string }> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/oauthComplete`,
      data: { pastedCode },
    });
  }

  export const useOauthCompleteMutation = () =>
    useMutation({
      mutationFn: (params: { pastedCode: string }) => oauthComplete(params.pastedCode),
    });

  export async function oauthStartOpenAI(name: string): Promise<OAuthStartResult> {
    return fetch({
      method: "POST",
      url: `/api/qgrid/oauthStartOpenAI`,
      data: { name },
    });
  }

  export const useOauthStartOpenAIMutation = () =>
    useMutation({
      mutationFn: (params: { name: string }) => oauthStartOpenAI(params.name),
    });

  export async function usage(tokenId?: number): Promise<UsageResponse> {
    return fetch({
      method: "GET",
      url: `/api/qgrid/usage?${qs.stringify({ tokenId })}`,
    });
  }

  export const usageQueryOptions = (tokenId?: number) =>
    queryOptions({
      queryKey: ["Qgrid", "usage", tokenId],
      queryFn: () => usage(tokenId),
    });

  export const useUsage = (tokenId?: number, options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...usageQueryOptions(tokenId),
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

export namespace MonitService {
  export async function monitLogs(cursor?: number): Promise<MonitLogChunk> {
    return fetch({
      method: "GET",
      url: `/api/monit/monitLogs?${qs.stringify({ cursor })}`,
    });
  }

  export const monitLogsQueryOptions = (cursor?: number) =>
    queryOptions({
      queryKey: ["Monit", "monitLogs", cursor],
      queryFn: () => monitLogs(cursor),
    });

  export const useMonitLogs = (cursor?: number, options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...monitLogsQueryOptions(cursor),
        ...options,
      }),
    );

  export async function monitInfo(): Promise<MonitServerInfo> {
    return fetch({
      method: "GET",
      url: `/api/monit/monitInfo`,
    });
  }

  export const monitInfoQueryOptions = () =>
    queryOptions({
      queryKey: ["Monit", "monitInfo"],
      queryFn: () => monitInfo(),
    });

  export const useMonitInfo = (options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...monitInfoQueryOptions(),
        ...options,
      }),
    );

  export async function monitStats(): Promise<MonitStats> {
    return fetch({
      method: "GET",
      url: `/api/monit/monitStats`,
    });
  }

  export const monitStatsQueryOptions = () =>
    queryOptions({
      queryKey: ["Monit", "monitStats"],
      queryFn: () => monitStats(),
    });

  export const useMonitStats = (options?: { enabled?: boolean }) =>
    useRefreshable(
      useQuery({
        ...monitStatsQueryOptions(),
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

// AsyncIdConfig: RequestLogStep
export const RequestLogStepAsyncIdConfig: AsyncIdConfig<
  RequestLogStepSubsetKey,
  RequestLogStepSubsetMapping,
  RequestLogStepListParams
> = {
  placeholderKey: "entity.RequestLogStep",
  useList: RequestLogStepService.useRequestLogSteps,
  useListInfinite: RequestLogStepService.useRequestLogStepsInfinite,
};

// AsyncIdConfig: Setting
export const SettingAsyncIdConfig: AsyncIdConfig<
  SettingSubsetKey,
  SettingSubsetMapping,
  SettingListParams
> = {
  placeholderKey: "entity.Setting",
  useList: SettingService.useSettings,
  useListInfinite: SettingService.useSettingsInfinite,
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
