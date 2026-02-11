import {
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_CONTROL_BASE_URL,
  DEFAULT_MCP_BASE_URL,
  TOOL_NAME_ALIASES,
  TOOL_NAMES,
} from './constants.js';
import { isNoDeviceError, isSupportedAuthToken, RtrvrError } from './errors.js';
import { HttpClient } from './http.js';
import {
  AgentRequest,
  CliCapabilitiesResponse,
  CliProfileResponse,
  ClientOptions,
  CloudFile,
  DeviceListResult,
  ExtensionPlannerRequest,
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

    return this.http.requestJson<unknown>({
      url: `${this.cloudBaseUrl}/agent`,
      method: 'POST',
      body: request,
    });
  }

  async scrapeRun(request: ScrapeRequest): Promise<unknown> {
    this.assertCloudApiKey('Cloud /scrape');

    if (!request.urls || request.urls.length === 0) {
      throw new RtrvrError('`urls` is required for scrape runs.');
    }

    return this.http.requestJson<unknown>({
      url: `${this.cloudBaseUrl}/scrape`,
      method: 'POST',
      body: request,
    });
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
        devices = await this.listDevices();
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
    const devices = await this.listDevices();
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
    return this.toolRunWithMetadata({
      tool: TOOL_NAMES.PLANNER,
      params: {
        user_input: request.input,
        tab_urls: request.urls,
        schema: request.schema,
        file_urls: request.fileUrls,
        ...(request.params ?? {}),
      },
      deviceId: request.deviceId,
    });
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
    });

    if (!response.success) {
      throw new RtrvrError(response.error?.message ?? `Tool '${tool}' failed`, {
        details: response,
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

  async listDevices(): Promise<DeviceListResult> {
    const data = await this.toolRun({
      tool: TOOL_NAMES.LIST_DEVICES,
      params: {},
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
        devices = await this.listDevices();
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
    const devices = await this.listDevices();
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

    const routed = await this.toolRunWithMetadata({
      tool: TOOL_NAMES.SCRAPE,
      params,
      deviceId: request.deviceId,
    });
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
    ...(request.trajectoryId ? { trajectoryId: request.trajectoryId } : {}),
    ...(request.phase !== undefined ? { phase: request.phase } : {}),
    ...(request.authToken ? { authToken: request.authToken } : {}),
    ...(request.options ? { options: request.options } : {}),
  };

  return {
    input: request.input,
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
