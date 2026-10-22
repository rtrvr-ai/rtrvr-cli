import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_CONTROL_BASE_URL,
  DEFAULT_MCP_BASE_URL,
  TOOL_NAME_ALIASES,
  TOOL_NAMES,
  DEFAULT_TIMEOUT_MS,
} from './constants.js';
import { isNoDeviceError, isSupportedAuthToken, RtrvrError, serverErrorFromPayload } from './errors.js';
import { HttpClient } from './http.js';
import { createDeadline } from './deadline.js';
import { streamExecutionEvents, record, type StreamExecutionEvent } from './events.js';
import {
  AgentRequest,
  CliCapabilitiesResponse,
  CliProfileResponse,
  ClientOptions,
  CloudFile,
  DeviceListResult,
  ExtensionPlannerRequest,
  ExecutionControls,
  RunMode,
  ScrapeRequest,
  ToolRequest,
  UnifiedRunRequest,
  UnifiedRunResponse,
  UnifiedScrapeRequest,
  UnifiedScrapeResponse,
} from './types.js';

interface DirectApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    message?: string;
    code?: string;
    fields?: unknown;
    details?: unknown;
  };
  metadata?: {
    requestId?: string;
    tool?: string;
    requestedTool?: string;
    aliasUsed?: boolean;
    attempt?: number;
  };
}

export class RtrvrClient {
  private readonly http: HttpClient;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cloudBaseUrl: string;
  private readonly mcpBaseUrl: string;
  private readonly controlBaseUrl: string;
  private readonly defaultTarget: RunMode;
  private readonly preferExtensionByDefault: boolean;
  private readonly authToken: string;

  constructor(options: ClientOptions) {
    if (!options.apiKey || !isSupportedAuthToken(options.apiKey)) {
      throw new RtrvrError('A valid rtrvr auth token is required (rtrvr_... or mcp_at_...).');
    }
    this.authToken = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;

    this.http = new HttpClient({
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      retryPolicy: options.retryPolicy,
      defaultHeaders: options.defaultHeaders,
      fetchImpl: options.fetchImpl,
    });

    this.cloudBaseUrl = trimTrailingSlash(options.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL);
    this.mcpBaseUrl = trimTrailingSlash(options.mcpBaseUrl ?? DEFAULT_MCP_BASE_URL);
    this.controlBaseUrl = trimTrailingSlash(options.controlBaseUrl ?? DEFAULT_CONTROL_BASE_URL);
    this.defaultTarget = options.defaultTarget ?? 'auto';
    this.preferExtensionByDefault = options.preferExtensionByDefault ?? false;
  }

  async agentRun(request: AgentRequest): Promise<unknown> {
    this.assertCloudApiKey('Cloud /agent');

    if (!request.input?.trim()) {
      throw new RtrvrError('`input` is required for agent runs.');
    }

    return this.cloudRun('agent', request);
  }

  async scrapeRun(request: ScrapeRequest): Promise<unknown> {
    this.assertCloudApiKey('Cloud /scrape');
    if (!request.urls || request.urls.length === 0) throw new RtrvrError('`urls` is required for scrape runs.');
    return this.cloudRun('scrape', request);
  }

  private async cloudRun(kind: 'agent' | 'scrape', request: AgentRequest | ScrapeRequest): Promise<unknown> {
    const { signal, onEvent, includeEventOutput, target: _target, preferExtension: _preferExtension,
      requireLocalSession: _requireLocalSession, deviceId: _deviceId, ...wire } = request as (AgentRequest | ScrapeRequest) & {
        target?: RunMode; preferExtension?: boolean; requireLocalSession?: boolean; deviceId?: string;
      };
    const trajectoryId = request.trajectoryId ?? randomUUID();
    const deadline = createDeadline(this.timeoutMs, signal);
    let progressAbort = new AbortController();
    let executionId = trajectoryId;
    const onAbort = () => progressAbort.abort(deadline.signal.reason);
    deadline.signal.addEventListener('abort', onAbort, { once: true });
    let follower: Promise<{ terminal?: StreamExecutionEvent; error?: unknown }> | undefined;
    const follow = (): Promise<{ terminal?: StreamExecutionEvent; error?: unknown }> => follower ??= streamExecutionEvents({
      baseUrl: this.mcpBaseUrl, token: this.authToken, trajectoryId: executionId,
      phase: 'phase' in request ? request.phase : 1,
      includeOutput: includeEventOutput ?? true, signal: progressAbort.signal, timeoutMs: deadline.remaining(), fetchImpl: this.fetchImpl,
      onEvent: onEvent ?? (() => undefined),
    }).then(terminal => ({ terminal }), error => ({ error }));
    let posted = false;
    let partialResult: unknown;
    try {
      deadline.signal.throwIfAborted();
      // Legacy clouds can stream progress while their advisory preference is ignored.
      if (onEvent) follow();
      let status = 200;
      posted = true;
      const admitted = await this.http.requestJson<unknown>({
        url: `${this.cloudBaseUrl}/${kind}`, method: 'POST',
        headers: { 'Idempotency-Key': trajectoryId, Prefer: 'respond-async' },
        body: { ...wire, trajectoryId, ...(onEvent ? { options: { ...record(wire.options), ui: { ...record(record(wire.options).ui), emitEvents: true } } } : {}) },
        signal: deadline.signal, timeoutMs: deadline.remaining(),
        onResponse: response => { status = response.status; },
      });
      if (status !== 202) return admitted;
      partialResult = admitted;
      const handle = record(admitted);
      const id = handle.trajectoryId ?? handle.runId;
      if (typeof id !== 'string' || !id) throw new RtrvrError('Async admission did not return a run id.', { code: 'ASYNC_RUN_ID_MISSING', details: admitted });
      if (id !== executionId) {
        progressAbort.abort();
        if (follower) await follower;
        progressAbort = new AbortController();
        follower = undefined;
        executionId = id;
      }
      deadline.signal.throwIfAborted();
      const completed = await follow();
      if (completed.error) throw completed.error;
      partialResult = record(completed.terminal?.data).data ?? completed.terminal?.data ?? admitted;
      // The relay deliberately clips output. Read the full authorized response after its terminal event.
      const statusUrl = typeof handle.statusUrl === 'string' ? handle.statusUrl : `/${kind}/${encodeURIComponent(executionId)}`;
      const resultUrl = new URL(statusUrl, `${this.cloudBaseUrl}/`);
      if (resultUrl.origin !== new URL(this.cloudBaseUrl).origin) throw new RtrvrError('Async statusUrl must use the cloud origin.', { code: 'INVALID_ASYNC_STATUS_URL' });
      resultUrl.pathname = resultUrl.pathname.endsWith('/response') ? resultUrl.pathname : `${resultUrl.pathname}/response`;
      return await this.http.requestJson<unknown>({ url: resultUrl.toString(), method: 'GET', signal: deadline.signal, timeoutMs: deadline.remaining() });
    } catch (error) {
      if (signal?.aborted && posted) {
        // Cancellation has its own physical wall-clock envelope after the run wait is aborted.
        try { await this.http.requestJson({ url: `${this.cloudBaseUrl}/${kind === 'agent' ? 'agent' : 'scrape'}/cancel`, method: 'POST', body: { trajectoryId: executionId }, timeoutMs: 10_000 }); }
        catch (cancelError) { throw new RtrvrError('Cancellation was not acknowledged within its wait budget.', { code: 'CANCEL_UNCONFIRMED', cause: cancelError, details: { trajectoryId: executionId, partialResult: { cancelRequested: true } } }); }
      }
      const failure = deadline.signal.aborted ? deadline.signal.reason : error;
      if (partialResult !== undefined) throw new RtrvrError(failure instanceof Error ? failure.message : 'Run follow failed.', {
        code: failure instanceof RtrvrError ? failure.code : 'RUN_FOLLOW_FAILED',
        status: failure instanceof RtrvrError ? failure.status : undefined,
        fields: failure instanceof RtrvrError ? failure.fields : undefined,
        requestId: failure instanceof RtrvrError ? failure.requestId : undefined,
        details: { trajectoryId: executionId, partialResult: failure instanceof RtrvrError ? record(failure.details).partialResult ?? partialResult : partialResult, failure: failure instanceof RtrvrError ? failure.details : undefined }, cause: failure,
      });
      throw failure;
    } finally {
      progressAbort.abort();
      if (follower) await follower;
      deadline.signal.removeEventListener('abort', onAbort);
      deadline.dispose();
    }
  }

  async scrape(request: UnifiedScrapeRequest): Promise<UnifiedScrapeResponse> {
    if (!request.urls || request.urls.length === 0) {
      throw new RtrvrError('`urls` is required for scrape runs.');
    }

    const requestedMode = request.target ?? this.defaultTarget;

    if (requestedMode === 'cloud') {
      const data = await this.scrapeRun(request);
      const responseMeta = extractResponseMeta(data);
      return {
        metadata: {
          selectedMode: 'cloud',
          requestedMode,
          fallbackApplied: false,
          requestId: responseMeta.requestId,
          attempt: responseMeta.attempt,
        },
        data,
      };
    }

    if (requestedMode === 'extension') {
      const routed = await this.extensionScrapeRun(request);
      return {
        metadata: {
          selectedMode: routed.selectedMode,
          requestedMode,
          fallbackApplied: routed.selectedMode !== 'extension',
          fallbackReason: routed.fallbackReason,
          deviceId: request.deviceId,
          requestId: routed.requestId,
          attempt: routed.attempt,
        },
        data: routed.data,
      };
    }

    const requireLocalSession = request.requireLocalSession ?? false;
    const explicitDeviceSelection = hasRequestedDevice(request.deviceId);

    if (requireLocalSession || explicitDeviceSelection) {
      let devices: DeviceListResult | undefined;
      if (!explicitDeviceSelection) {
        devices = await this.listDevices(request.signal);
        if (!devices.online) {
          throw new RtrvrError(
            'No online extension devices found, but this scrape requires local browser session.',
            { details: devices },
          );
        }
      }

      const routed = await this.extensionScrapeRun(request);
      if (routed.selectedMode !== 'extension') {
        throw new RtrvrError(
          'Extension scrape adapter is unavailable and local browser session is required.',
          { details: routed },
        );
      }

      return {
        metadata: {
          selectedMode: 'extension',
          requestedMode,
          fallbackApplied: false,
          deviceId: request.deviceId ?? devices?.devices[0]?.deviceId,
          requestId: routed.requestId,
          attempt: routed.attempt,
        },
        data: routed.data,
      };
    }

    // Auto mode: check for online extension devices, use if available, fall back to cloud
    const devices = await this.listDevices(request.signal);
    if (devices.online) {
      try {
        const routed = await this.extensionScrapeRun(request);
        return {
          metadata: {
            selectedMode: routed.selectedMode,
            requestedMode,
            fallbackApplied: routed.selectedMode !== 'extension',
            fallbackReason: routed.fallbackReason,
            deviceId: request.deviceId ?? devices.devices[0]?.deviceId,
            requestId: routed.requestId,
            attempt: routed.attempt,
          },
          data: routed.data,
        };
      } catch (error) {
        if (!isNoDeviceError(error)) {
          throw error;
        }
        // Extension device became unavailable, fall through to cloud
      }
    }

    const data = await this.scrapeRun(request);
    const responseMeta = extractResponseMeta(data);
    return {
      metadata: {
        selectedMode: 'cloud',
        requestedMode,
        fallbackApplied: devices.online,
        fallbackReason: devices.online
          ? 'Extension device became unavailable during execution. Routed to cloud /scrape.'
          : undefined,
        requestId: responseMeta.requestId,
        attempt: responseMeta.attempt,
      },
      data,
    };
  }

  async extensionPlannerRun(request: ExtensionPlannerRequest): Promise<unknown> {
    const result = await this.extensionPlannerRunWithMetadata(request);
    return result.data;
  }

  private async extensionPlannerRunWithMetadata(request: ExtensionPlannerRequest): Promise<ToolRunWithMetadata> {
    return this.observeMcpRun(request, request.params?.trajectoryId, request.params?.phase, () => this.toolRunWithMetadata({
      tool: TOOL_NAMES.PLANNER,
      params: { user_input: request.input, tab_urls: request.urls, schema: request.schema, file_urls: request.fileUrls,
        ...(request.params ?? {}), ...(request.clientSurface ? { client_surface: request.clientSurface } : {}) },
      deviceId: request.deviceId, signal: request.signal,
    }));
  }

  private async observeMcpRun<T>(request: ExecutionControls, trajectoryId: unknown, phase: unknown, execute: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const progress = request.onEvent && typeof trajectoryId === 'string'
      ? streamExecutionEvents({ baseUrl: this.mcpBaseUrl, token: this.authToken,
        trajectoryId, phase: typeof phase === 'number' ? phase : 1,
        includeOutput: request.includeEventOutput ?? true, signal: controller.signal, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, onEvent: request.onEvent,
      }).catch(() => undefined) : undefined;
    try { return await execute(); }
    finally { controller.abort(); await progress; }
  }

  async toolRun(request: ToolRequest): Promise<unknown> {
    const result = await this.toolRunWithMetadata(request);
    return result.data;
  }

  private async toolRunWithMetadata(request: ToolRequest): Promise<ToolRunWithMetadata> {
    const tool = normalizeToolName(request.tool);
    const payload: Record<string, unknown> = {
      tool,
      params: request.params ?? {},
    };
    if (request.deviceId) {
      payload.deviceId = request.deviceId;
    }

    const response = await this.http.requestJson<DirectApiResponse<unknown>>({
      url: this.mcpBaseUrl,
      method: 'POST',
      body: payload,
      signal: request.signal,
    });

    if (!response.success) {
      throw serverErrorFromPayload(response, {
        requestId: response.metadata?.requestId, fallbackMessage: `Tool '${tool}' failed`,
      });
    }

    const metadata = normalizeResponseMeta(response.metadata);

    return {
      data: response.data,
      requestId: metadata.requestId,
      attempt: metadata.attempt,
      tool: metadata.tool,
      requestedTool: metadata.requestedTool,
      aliasUsed: metadata.aliasUsed,
    };
  }

  async listDevices(signal?: AbortSignal): Promise<DeviceListResult> {
    const data = await this.toolRun({
      tool: TOOL_NAMES.LIST_DEVICES,
      params: {},
      signal,
    });

    const normalized = normalizeDeviceList(data);
    return normalized;
  }

  async getCurrentCredits(): Promise<unknown> {
    return this.toolRun({
      tool: TOOL_NAMES.GET_CURRENT_CREDITS,
      params: {},
    });
  }

  async profileGet(): Promise<CliProfileResponse> {
    this.assertCloudApiKey('CLI /cli/profile');

    return this.http.requestJson<CliProfileResponse>({
      url: `${this.controlBaseUrl}/cli/profile`,
      method: 'GET',
    });
  }

  async capabilitiesGet(): Promise<CliCapabilitiesResponse> {
    this.assertCloudApiKey('CLI /cli/capabilities');

    return this.http.requestJson<CliCapabilitiesResponse>({
      url: `${this.controlBaseUrl}/cli/capabilities`,
      method: 'GET',
    });
  }

  async run(request: UnifiedRunRequest): Promise<UnifiedRunResponse> {
    if (!request.input?.trim()) {
      throw new RtrvrError('`input` is required.');
    }

    const requestedMode = request.target ?? this.defaultTarget;

    if (requestedMode === 'cloud') {
      const data = await this.agentRun(toAgentRequest(request));
      const responseMeta = extractResponseMeta(data);
      return {
        metadata: {
          selectedMode: 'cloud',
          requestedMode,
          fallbackApplied: false,
          requestId: responseMeta.requestId,
          attempt: responseMeta.attempt,
        },
        data,
      };
    }

    if (requestedMode === 'extension') {
      const routed = await this.extensionPlannerRunWithMetadata(toExtensionPlannerRequest(request));
      return {
        metadata: {
          selectedMode: 'extension',
          requestedMode,
          fallbackApplied: false,
          deviceId: request.deviceId,
          requestId: routed.requestId,
          attempt: routed.attempt,
        },
        data: routed.data,
      };
    }

    const requireLocalSession = request.requireLocalSession ?? false;
    const explicitDeviceSelection = hasRequestedDevice(request.deviceId);

    if (requireLocalSession || explicitDeviceSelection) {
      let devices: DeviceListResult | undefined;
      if (!explicitDeviceSelection) {
        devices = await this.listDevices(request.signal);
        if (!devices.online) {
          throw new RtrvrError(
            'No online extension devices found, but this run requires local browser session.',
            { details: devices },
          );
        }
      }

      const routed = await this.extensionPlannerRunWithMetadata(toExtensionPlannerRequest(request));
      return {
        metadata: {
          selectedMode: 'extension',
          requestedMode,
          fallbackApplied: false,
          deviceId: request.deviceId ?? devices?.devices[0]?.deviceId,
          requestId: routed.requestId,
          attempt: routed.attempt,
        },
        data: routed.data,
      };
    }

    // Auto mode: check for online extension devices, use if available, fall back to cloud
    const devices = await this.listDevices(request.signal);
    if (devices.online) {
      try {
        const routed = await this.extensionPlannerRunWithMetadata(toExtensionPlannerRequest(request));
        return {
          metadata: {
            selectedMode: 'extension',
            requestedMode,
            fallbackApplied: false,
            deviceId: request.deviceId ?? devices.devices[0]?.deviceId,
            requestId: routed.requestId,
            attempt: routed.attempt,
          },
          data: routed.data,
        };
      } catch (error) {
        if (!isNoDeviceError(error)) {
          throw error;
        }
        // Extension device became unavailable, fall through to cloud
      }
    }

    const data = await this.agentRun(toAgentRequest(request));
    const responseMeta = extractResponseMeta(data);
    return {
      metadata: {
        selectedMode: 'cloud',
        requestedMode,
        fallbackApplied: devices.online,
        fallbackReason: devices.online
          ? 'Extension device became unavailable during execution. Routed to cloud /agent.'
          : undefined,
        requestId: responseMeta.requestId,
        attempt: responseMeta.attempt,
      },
      data,
    };
  }

  async agent(request: UnifiedRunRequest): Promise<UnifiedRunResponse> {
    return this.run(request);
  }

  private async extensionScrapeRun(request: UnifiedScrapeRequest): Promise<ExtensionScrapeRouteResult> {
    const params: Record<string, unknown> = {
      urls: request.urls,
      settings: request.settings,
      options: request.options,
      response: request.response,
      webhooks: request.webhooks,
      trajectoryId: request.trajectoryId,
      authToken: request.authToken,
      target: request.target,
      preferExtension: request.preferExtension,
      requireLocalSession: request.requireLocalSession,
    };

    const routed = await this.observeMcpRun(request, request.trajectoryId, 1, () => this.toolRunWithMetadata({
      tool: TOOL_NAMES.SCRAPE,
      params,
      deviceId: request.deviceId,
      signal: request.signal,
    }));
    if (routed.tool === TOOL_NAMES.CLOUD_SCRAPE) {
      return {
        data: routed.data,
        selectedMode: 'cloud',
        fallbackReason: 'Scrape request resolved to cloud_scrape.',
        requestId: routed.requestId,
        attempt: routed.attempt,
      };
    }
    return {
      data: routed.data,
      selectedMode: 'extension',
      requestId: routed.requestId,
      attempt: routed.attempt,
    };
  }

  private assertCloudApiKey(operation: string): void {
    if (this.authToken.startsWith('rtrvr_')) {
      return;
    }

    throw new RtrvrError(
      `${operation} requires an rtrvr_ API key. mcp_at_ tokens are only supported for MCP/OAuth endpoints.`,
    );
  }
}

interface ExtensionScrapeRouteResult {
  data: unknown;
  selectedMode: 'extension' | 'cloud';
  fallbackReason?: string;
  requestId?: string;
  attempt?: number;
}

interface ToolRunWithMetadata {
  data: unknown;
  requestId?: string;
  attempt?: number;
  tool?: string;
  requestedTool?: string;
  aliasUsed?: boolean;
}

function normalizeDeviceList(data: unknown): DeviceListResult {
  if (!data || typeof data !== 'object') {
    return {
      online: false,
      deviceCount: 0,
      devices: [],
    };
  }

  const asRecord = data as Record<string, unknown>;
  const devices = Array.isArray(asRecord.devices) ? asRecord.devices : [];

  return {
    online: Boolean(asRecord.online),
    deviceCount: typeof asRecord.deviceCount === 'number' ? asRecord.deviceCount : devices.length,
    devices: devices
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        deviceId: typeof item.deviceId === 'string' ? item.deviceId : 'unknown',
        deviceName: typeof item.deviceName === 'string' ? item.deviceName : undefined,
        lastSeen: typeof item.lastSeen === 'string' ? item.lastSeen : undefined,
        hasFcmToken: typeof item.hasFcmToken === 'boolean' ? item.hasFcmToken : undefined,
      })),
  };
}

function toAgentRequest(request: UnifiedRunRequest): AgentRequest {
  const files = request.files ?? fileUrlsToCloudFiles(request.fileUrls);
  const options = ensureCloudAgentOptions(request.options);

  return {
    input: request.input,
    signal: request.signal,
    onEvent: request.onEvent,
    includeEventOutput: request.includeEventOutput,
    clientSurface: request.clientSurface,
    urls: request.urls,
    schema: request.schema,
    files,
    dataInputs: request.dataInputs,
    settings: request.settings,
    tools: request.tools,
    options,
    response: request.response,
    webhooks: request.webhooks,
    trajectoryId: request.trajectoryId,
    phase: request.phase,
    recordingContext: request.recordingContext,
    authToken: request.authToken,
  };
}

function ensureCloudAgentOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  const normalizedOptions = (options && typeof options === 'object' && !Array.isArray(options))
    ? { ...options }
    : {};
  const ui = (normalizedOptions.ui && typeof normalizedOptions.ui === 'object' && !Array.isArray(normalizedOptions.ui))
    ? { ...(normalizedOptions.ui as Record<string, unknown>) }
    : {};

  if (typeof ui.emitEvents !== 'boolean') {
    delete ui.emitEvents;
  }

  normalizedOptions.ui = ui;
  return normalizedOptions;
}

function toExtensionPlannerRequest(request: UnifiedRunRequest): ExtensionPlannerRequest {
  const explicitFileUrls = request.fileUrls ?? [];
  const derivedFileUrls = request.files
    ?.map((file) => file.uri)
    .filter((uri): uri is string => Boolean(uri));

  const params = {
    ...(request.extensionParams ?? {}),
    ...(request.clientSurface ? { client_surface: request.clientSurface } : {}),
    ...(request.trajectoryId ? { trajectoryId: request.trajectoryId } : {}),
    ...(request.phase !== undefined ? { phase: request.phase } : {}),
    ...(request.authToken ? { authToken: request.authToken } : {}),
    ...(request.options ? { options: request.options } : {}),
  };

  return {
    input: request.input,
    signal: request.signal,
    onEvent: request.onEvent,
    includeEventOutput: request.includeEventOutput,
    urls: request.urls,
    schema: request.schema,
    fileUrls: explicitFileUrls.length > 0 ? explicitFileUrls : derivedFileUrls,
    deviceId: request.deviceId,
    params: Object.keys(params).length > 0 ? params : undefined,
  };
}

function fileUrlsToCloudFiles(fileUrls: string[] | undefined): CloudFile[] | undefined {
  if (!fileUrls || fileUrls.length === 0) {
    return undefined;
  }

  return fileUrls.map((uri) => ({
    displayName: fileNameFromUri(uri),
    uri,
    mimeType: guessMimeType(uri),
  }));
}

function fileNameFromUri(uri: string): string {
  try {
    const url = new URL(uri);
    const segments = url.pathname.split('/').filter(Boolean);
    return decodeURIComponent(segments[segments.length - 1] ?? 'file');
  } catch {
    return 'file';
  }
}

function guessMimeType(uri: string): string {
  const lower = uri.toLowerCase();

  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';

  return 'application/octet-stream';
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function normalizeToolName(tool: string): string {
  return (TOOL_NAME_ALIASES as Record<string, string>)[tool] ?? tool;
}

function hasRequestedDevice(deviceId: string | undefined): boolean {
  return typeof deviceId === 'string' && deviceId.trim().length > 0;
}

function extractResponseMeta(value: unknown): { requestId?: string; attempt?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const root = value as Record<string, unknown>;
  const metadata = normalizeResponseMeta(root.metadata);
  if (metadata.requestId || metadata.attempt !== undefined) {
    return metadata;
  }

  return {
    requestId: typeof root.requestId === 'string' ? root.requestId : undefined,
    attempt: typeof root.attempt === 'number' ? root.attempt : undefined,
  };
}

function normalizeResponseMeta(value: unknown): {
  requestId?: string;
  attempt?: number;
  tool?: string;
  requestedTool?: string;
  aliasUsed?: boolean;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const metadata = value as Record<string, unknown>;
  return {
    requestId: typeof metadata.requestId === 'string' ? metadata.requestId : undefined,
    attempt: typeof metadata.attempt === 'number' ? metadata.attempt : undefined,
    tool: typeof metadata.tool === 'string' ? metadata.tool : undefined,
    requestedTool: typeof metadata.requestedTool === 'string' ? metadata.requestedTool : undefined,
    aliasUsed: typeof metadata.aliasUsed === 'boolean' ? metadata.aliasUsed : undefined,
  };
}
