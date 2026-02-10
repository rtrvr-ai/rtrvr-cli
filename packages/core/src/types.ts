export type RunMode = 'auto' | 'cloud' | 'extension';

export interface CloudFile {
  displayName: string;
  uri: string;
  mimeType: string;
}

export interface WebhookAuthBearer {
  type: 'bearer';
  token: string;
}

export interface WebhookAuthBasic {
  type: 'basic';
  username: string;
  password: string;
}

export type WebhookAuth = WebhookAuthBearer | WebhookAuthBasic;

export interface WebhookSubscription {
  url: string;
  events?: string[];
  auth?: WebhookAuth;
  secret?: string;
}

export interface AgentRequest {
  input: string;
  urls?: string[];
  schema?: Record<string, unknown>;
  files?: CloudFile[];
  dataInputs?: unknown[];
  settings?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  options?: Record<string, unknown>;
  response?: {
    verbosity?: 'final' | 'steps' | 'debug';
    inlineOutputMaxBytes?: number;
  };
  webhooks?: WebhookSubscription[];
  trajectoryId?: string;
  phase?: number;
  recordingContext?: string;
  authToken?: string;
}

export interface ScrapeRequest {
  urls: string[];
  settings?: Record<string, unknown>;
  options?: Record<string, unknown>;
  response?: {
    inlineOutputMaxBytes?: number;
  };
  webhooks?: WebhookSubscription[];
  trajectoryId?: string;
  authToken?: string;
}

export interface UnifiedScrapeRequest extends ScrapeRequest {
  target?: RunMode;
  preferExtension?: boolean;
  requireLocalSession?: boolean;
  deviceId?: string;
}

export interface ExtensionPlannerRequest {
  input: string;
  urls?: string[];
  schema?: Record<string, unknown>;
  fileUrls?: string[];
  deviceId?: string;
  params?: Record<string, unknown>;
}

export interface ToolRequest {
  tool: string;
  params?: Record<string, unknown>;
  deviceId?: string;
}

export interface UnifiedRunRequest {
  input: string;
  urls?: string[];
  schema?: Record<string, unknown>;
  files?: CloudFile[];
  fileUrls?: string[];
  dataInputs?: unknown[];
  settings?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  options?: Record<string, unknown>;
  response?: {
    verbosity?: 'final' | 'steps' | 'debug';
    inlineOutputMaxBytes?: number;
  };
  webhooks?: WebhookSubscription[];
  trajectoryId?: string;
  phase?: number;
  recordingContext?: string;
  authToken?: string;

  target?: RunMode;
  preferExtension?: boolean;
  requireLocalSession?: boolean;
  deviceId?: string;
  extensionTool?: string;
  extensionParams?: Record<string, unknown>;
}

export interface RunMetadata {
  selectedMode: Exclude<RunMode, 'auto'>;
  requestedMode: RunMode;
  fallbackApplied: boolean;
  fallbackReason?: string;
  deviceId?: string;
  requestId?: string;
  attempt?: number;
}

export interface UnifiedRunResponse<T = unknown> {
  metadata: RunMetadata;
  data: T;
}

export type UnifiedScrapeResponse<T = unknown> = UnifiedRunResponse<T>;

export interface DeviceInfo {
  deviceId: string;
  deviceName?: string;
  lastSeen?: string;
  hasFcmToken?: boolean;
}

export interface DeviceListResult {
  online: boolean;
  deviceCount: number;
  devices: DeviceInfo[];
}

export interface ClientOptions {
  apiKey: string;
  cloudBaseUrl?: string;
  mcpBaseUrl?: string;
  controlBaseUrl?: string;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  defaultTarget?: RunMode;
  preferExtensionByDefault?: boolean;
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface RetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retriableStatusCodes?: number[];
}

export interface CliProfileResponse {
  [key: string]: unknown;
}

export interface CliCapabilitiesResponse {
  [key: string]: unknown;
}
