import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { RunMode } from '@rtrvr-ai/sdk';

export type AuthStorageMode = 'auto' | 'keychain' | 'config';

export interface CliConfig {
  // Config-file auth storage is explicitly enabled when authStorage=config.
  apiKey?: string;
  defaultTarget: RunMode;
  preferExtensionByDefault: boolean;
  cloudBaseUrl: string;
  mcpBaseUrl: string;
  authStorage: AuthStorageMode;
  controlBaseUrl: string;
  oauthPollIntervalMs: number;
  oauthTimeoutMs: number;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  telemetryOptIn: boolean;
}

const DEFAULT_CONFIG: CliConfig = {
  defaultTarget: 'auto',
  preferExtensionByDefault: false,
  cloudBaseUrl: 'https://api.rtrvr.ai',
  mcpBaseUrl: 'https://mcp.rtrvr.ai',
  authStorage: 'auto',
  controlBaseUrl: 'https://cli.rtrvr.ai',
  oauthPollIntervalMs: 2_000,
  oauthTimeoutMs: 180_000,
  retryMaxAttempts: 1,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 4_000,
  telemetryOptIn: false,
};

function readEnvUrl(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  return raw.trim();
}

function applyEnvOverrides(config: CliConfig): CliConfig {
  const cloudBaseUrl = readEnvUrl('RTRVR_CLOUD_BASE_URL');
  const mcpBaseUrl = readEnvUrl('RTRVR_MCP_BASE_URL');
  const controlBaseUrl = readEnvUrl('RTRVR_CONTROL_BASE_URL');

  return {
    ...config,
    cloudBaseUrl: cloudBaseUrl ?? config.cloudBaseUrl,
    mcpBaseUrl: mcpBaseUrl ?? config.mcpBaseUrl,
    controlBaseUrl: controlBaseUrl ?? config.controlBaseUrl,
  };
}

export function getConfigDir(): string {
  const explicit = process.env.RTRVR_CONFIG_DIR;
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }

  return path.join(os.homedir(), '.config', 'rtrvr');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function getSkillsDir(): string {
  return path.join(getConfigDir(), 'skills');
}

export async function loadConfig(): Promise<CliConfig> {
  const configPath = getConfigPath();

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    const merged = {
      ...DEFAULT_CONFIG,
      ...parsed,
      authStorage: normalizeAuthStorage(parsed.authStorage),
      controlBaseUrl: typeof parsed.controlBaseUrl === 'string' && parsed.controlBaseUrl.trim().length > 0
        ? parsed.controlBaseUrl
        : DEFAULT_CONFIG.controlBaseUrl,
      oauthPollIntervalMs: typeof parsed.oauthPollIntervalMs === 'number' && parsed.oauthPollIntervalMs > 0
        ? parsed.oauthPollIntervalMs
        : DEFAULT_CONFIG.oauthPollIntervalMs,
      oauthTimeoutMs: typeof parsed.oauthTimeoutMs === 'number' && parsed.oauthTimeoutMs > 0
        ? parsed.oauthTimeoutMs
        : DEFAULT_CONFIG.oauthTimeoutMs,
      retryMaxAttempts: typeof parsed.retryMaxAttempts === 'number' && parsed.retryMaxAttempts >= 1
        ? Math.floor(parsed.retryMaxAttempts)
        : DEFAULT_CONFIG.retryMaxAttempts,
      retryBaseDelayMs: typeof parsed.retryBaseDelayMs === 'number' && parsed.retryBaseDelayMs > 0
        ? Math.floor(parsed.retryBaseDelayMs)
        : DEFAULT_CONFIG.retryBaseDelayMs,
      retryMaxDelayMs: typeof parsed.retryMaxDelayMs === 'number' && parsed.retryMaxDelayMs > 0
        ? Math.floor(parsed.retryMaxDelayMs)
        : DEFAULT_CONFIG.retryMaxDelayMs,
    };
    return applyEnvOverrides(merged);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return applyEnvOverrides({ ...DEFAULT_CONFIG });
    }

    throw error;
  }
}

export async function saveConfig(config: CliConfig): Promise<void> {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export async function clearAuthFromConfig(): Promise<CliConfig> {
  const config = await loadConfig();
  delete config.apiKey;
  await saveConfig(config);
  return config;
}

export function maskApiKey(apiKey: string): string {
  if (apiKey.length < 12) {
    return `${apiKey.slice(0, 3)}***`;
  }

  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}

export function ensureValidMode(value: string): RunMode {
  if (value === 'auto' || value === 'cloud' || value === 'extension') {
    return value;
  }

  throw new Error(`Invalid mode '${value}'. Expected auto, cloud, or extension.`);
}

export function ensureValidAuthStorage(value: string): AuthStorageMode {
  if (value === 'auto' || value === 'keychain' || value === 'config') {
    return value;
  }

  throw new Error(`Invalid auth storage '${value}'. Expected auto, keychain, or config.`);
}

function normalizeAuthStorage(value: unknown): AuthStorageMode {
  if (value === 'auto' || value === 'keychain' || value === 'config') {
    return value;
  }

  return DEFAULT_CONFIG.authStorage;
}
