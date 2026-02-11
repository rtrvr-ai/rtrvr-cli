#!/usr/bin/env node

import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { Command } from 'commander';
import {
  createRtrvrClient,
  isSupportedAuthToken,
  type RunMode,
  type UnifiedRunRequest,
  type UnifiedScrapeRequest,
} from '@rtrvr-ai/sdk';

import { buildMcpProfile, buildMcpUrl, type McpAuthMode, type McpClientType } from './utils/mcp.js';
import {
  clearAuthFromConfig,
  ensureValidAuthStorage,
  ensureValidMode,
  loadConfig,
  maskApiKey,
  saveConfig,
  type AuthStorageMode,
  type CliConfig,
} from './utils/config.js';
import { printError, printHuman, printJson, printKeyValue, printLine } from './utils/output.js';
import { maybeReadJsonFile, parseJsonText, parseKeyValuePairs } from './utils/parsers.js';
import {
  addSkillFromFile,
  buildRunRequestFromSkill,
  getBuiltinSkillTemplate,
  installBuiltinSkillTemplate,
  listBuiltinSkillTemplates,
  listSkills,
  loadSkillByName,
  removeSkillByName,
  renderSkillAsMarkdown,
  validateSkillToolCompatibility,
} from './utils/skills.js';
import {
  clearSecureApiKey,
  detectSecureStoreBackend,
  getSecureApiKey,
  setSecureApiKey,
  type SecureStoreBackend,
} from './utils/secrets.js';
import { pollCliOAuth, startCliOAuth } from './utils/oauth.js';
import { streamExecutionEvents, type StreamExecutionEvent } from './utils/events.js';

type CliSdk = ReturnType<typeof createRtrvrClient>;
type AuthSource = 'env' | 'keychain' | 'secret-service' | 'config' | 'none';

interface CommonRunOptions {
  input?: string;
  inputFile?: string;
  url?: string[];
  target?: string;
  cloud?: boolean;
  extension?: boolean;
  deviceId?: string;
  fileUrl?: string[];
  schemaFile?: string;
  settingsJson?: string;
  toolsJson?: string;
  optionsJson?: string;
  responseJson?: string;
  webhooksJson?: string;
  authToken?: string;
  preferExtension?: boolean;
  requireLocalSession?: boolean;
  stream?: boolean;
  streamOutput?: boolean;
  json?: boolean;
}

interface ScrapeOptions {
  url?: string[];
  target?: string;
  cloud?: boolean;
  extension?: boolean;
  deviceId?: string;
  settingsJson?: string;
  optionsJson?: string;
  responseJson?: string;
  webhooksJson?: string;
  authToken?: string;
  preferExtension?: boolean;
  requireLocalSession?: boolean;
  stream?: boolean;
  streamOutput?: boolean;
  json?: boolean;
}

type StreamableUnifiedScrapeRequest = UnifiedScrapeRequest & {
  options?: Record<string, unknown>;
};

interface ToolOptions {
  param?: string[];
  paramsJson?: string;
  deviceId?: string;
  json?: boolean;
}

interface AuthLoginOptions {
  apiKey?: string;
  target?: string;
  cloud?: boolean;
  extension?: boolean;
  strictAuth?: boolean;
  preferExtension?: boolean;
  cloudBaseUrl?: string;
  mcpBaseUrl?: string;
  controlBaseUrl?: string;
  storage?: string;
  open?: boolean;
  oauth?: boolean;
  browser?: boolean;
  json?: boolean;
}

interface AuthGoogleCommandOptions {
  open?: boolean;
  browser?: boolean;
  json?: boolean;
}

interface ResolvedAuth {
  token?: string;
  source: AuthSource;
}

interface CliGoogleAuthStatus {
  linked?: boolean;
  source?: string;
  usableFor?: Record<string, boolean>;
  scopes?: string[];
  reason?: string;
  connectUrl?: string;
  checkedAt?: string;
}

interface SkillsApplyOptions {
  url?: string[];
  target?: string;
  cloud?: boolean;
  extension?: boolean;
  skipCapabilityCheck?: boolean;
  json?: boolean;
}

const TOOL_SHORTCUTS = {
  planner: 'planner',
  act: 'act_on_tab',
  extract: 'extract_from_tab',
  crawl: 'crawl_and_extract_from_tab',
} as const;

const program = new Command();

program
  .name('rtrvr')
  .description('RTRVR CLI: unified cloud + extension runtime for humans and agents.')
  .version('0.2.0');

registerAuthCommands(program);
registerExecutionCommands(program);
registerConfigCommands(program);
registerProfileCommands(program);
registerMcpCommands(program);
registerDoctorCommand(program);
registerSkillsCommands(program);

const raw = program.command('raw').description('Raw/low-level MCP tool commands.');
registerRawCommands(raw);

program.parseAsync(process.argv).catch((error) => {
  printError(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function registerAuthCommands(root: Command): void {
  const auth = root.command('auth').description('Authentication and credential management.');

  addAuthLoginOptions(auth.command('login').description('Login via OAuth bootstrap or API key/token.'))
    .action(async (options: AuthLoginOptions) => {
      await handleAuthLogin(options);
    });

  auth
    .command('logout')
    .description('Clear saved credentials from secure store and config fallback.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      const config = await loadConfig();
      await clearSavedAuth(config);
      emitOutput({ success: true }, options.json);
    });

  auth
    .command('status')
    .description('Show auth status, credential source, and credits when available.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      await handleAuthStatus(options.json);
    });

  auth
    .command('token')
    .description('Print raw auth token for agent automation pipelines.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      const config = await loadConfig();
      const resolved = await resolveAuthToken(config, true);
      const token = resolved.token as string;
      if (options.json) {
        printJson({ token, source: resolved.source });
      } else {
        printLine(token);
      }
    });

  const google = auth.command('google').description('Google OAuth status helpers for CLI/API mode.');
  google
    .command('status')
    .description('Show whether Google Drive/Sheets OAuth is linked for this API key.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      await handleGoogleAuthStatus(options.json);
    });

  google
    .command('login')
    .description('Open Cloud settings to connect Google OAuth for Sheets/Docs/Slides tools.')
    .option('--open', 'Open Google OAuth connect URL in browser (default in interactive terminal).')
    .option('--no-browser', 'Do not open browser automatically.')
    .option('--json', 'Output JSON')
    .action(async (options: AuthGoogleCommandOptions) => {
      await handleGoogleAuthLogin(options);
    });

}

function registerExecutionCommands(root: Command): void {
  root
    .command('run')
    .description('Unified run with auto-routing between cloud /agent and extension planner.')
    .argument('[input...]', 'Natural language task input')
    .option('--input <text>', 'Input text (use "-" to read from stdin)')
    .option('--input-file <path>', 'Read input text from file')
    .option('-u, --url <url...>', 'Starting URL(s)')
    .option('--target <target>', 'auto|cloud|extension (preferred)')
    .option('--cloud', 'Shortcut for --target cloud')
    .option('--extension', 'Shortcut for --target extension')
    .option('--device-id <id>', 'Target extension device ID')
    .option('--file-url <url...>', 'File URL(s) for context')
    .option('--schema-file <path>', 'Path to JSON schema file')
    .option('--settings-json <json>', 'Agent settings JSON')
    .option('--tools-json <json>', 'Tools config JSON')
    .option('--options-json <json>', 'Execution options JSON')
    .option('--response-json <json>', 'Response config JSON')
    .option('--webhooks-json <json>', 'Webhooks JSON array')
    .option('--auth-token <token>', 'Optional Google OAuth access token for Drive/Sheets/Docs/Slides tools')
    .option('--prefer-extension', 'Prefer extension routing when available')
    .option('--require-local-session', 'Require extension/local session or fail')
    .option('--no-stream', 'Disable SSE progress streaming (enabled by default)')
    .option('--no-stream-output', 'Hide tool output payloads in streamed progress events')
    .option('--json', 'Output JSON')
    .action(async (inputParts: string[] | undefined, options: CommonRunOptions) => {
      const inputText = await resolveInputText(inputParts ?? [], options);
      const request = await buildRunRequest(inputText, options);
      const { config, client, auth } = await loadAuthedClient();
      const token = auth.token as string;
      const requestedMode = request.target ?? config.defaultTarget;
      if (requestedMode === 'cloud') {
        assertCloudTokenForCloudEndpoints(token, '`rtrvr run` (cloud mode)');
      }

      const streamMode = options.stream ? resolveStreamModeForRequest(request, config) : undefined;
      if (options.stream && streamMode === 'cloud') {
        assertCloudTokenForCloudEndpoints(token, '`rtrvr run --stream` (cloud mode)');
      }

      const result = options.stream
        ? await executeWithEventStream({
          baseUrl: config.mcpBaseUrl,
          token,
          includeOutput: Boolean(options.streamOutput),
          jsonMode: options.json,
          requestLabel: 'run',
          ...prepareStreamRequest(request),
          execute: () => client.run(request),
        })
        : await client.run(request);
      emitOutput(result, options.json);
    });

  root
    .command('agent')
    .description('Unified agent run with auto-routing between cloud /agent and extension planner.')
    .argument('[input...]', 'Natural language task input')
    .option('--input <text>', 'Input text (use "-" to read from stdin)')
    .option('--input-file <path>', 'Read input text from file')
    .option('-u, --url <url...>', 'Starting URL(s)')
    .option('--target <target>', 'auto|cloud|extension (preferred)')
    .option('--cloud', 'Shortcut for --target cloud')
    .option('--extension', 'Shortcut for --target extension')
    .option('--device-id <id>', 'Target extension device ID')
    .option('--file-url <url...>', 'File URL(s) for context')
    .option('--schema-file <path>', 'Path to JSON schema file')
    .option('--settings-json <json>', 'Agent settings JSON')
    .option('--tools-json <json>', 'Tools config JSON')
    .option('--options-json <json>', 'Execution options JSON')
    .option('--response-json <json>', 'Response config JSON')
    .option('--webhooks-json <json>', 'Webhooks JSON array')
    .option('--auth-token <token>', 'Optional Google OAuth access token for Drive/Sheets/Docs/Slides tools')
    .option('--prefer-extension', 'Prefer extension routing when available')
    .option('--require-local-session', 'Require extension/local session or fail')
    .option('--no-stream', 'Disable SSE progress streaming (enabled by default)')
    .option('--no-stream-output', 'Hide tool output payloads in streamed progress events')
    .option('--json', 'Output JSON')
    .action(async (inputParts: string[] | undefined, options: CommonRunOptions) => {
      const inputText = await resolveInputText(inputParts ?? [], options);
      const request = await buildRunRequest(inputText, options);
      const { config, client, auth } = await loadAuthedClient();
      const token = auth.token as string;
      const requestedMode = request.target ?? config.defaultTarget;
      if (requestedMode === 'cloud') {
        assertCloudTokenForCloudEndpoints(token, '`rtrvr agent` (cloud mode)');
      }

      const streamMode = options.stream ? resolveStreamModeForRequest(request, config) : undefined;
      if (options.stream && streamMode === 'cloud') {
        assertCloudTokenForCloudEndpoints(token, '`rtrvr agent --stream` (cloud mode)');
      }

      const result = options.stream
        ? await executeWithEventStream({
          baseUrl: config.mcpBaseUrl,
          token,
          includeOutput: Boolean(options.streamOutput),
          jsonMode: options.json,
          requestLabel: 'agent',
          ...prepareStreamRequest(request),
          execute: () => client.agent.run(request),
        })
        : await client.agent.run(request);

      emitOutput(result, options.json);
    });

  root
    .command('scrape')
    .description('Scrape one or more URLs with cloud/extension routing support.')
    .option('-u, --url <url...>', 'URL(s) to scrape')
    .option('--target <target>', 'auto|cloud|extension (preferred)')
    .option('--cloud', 'Shortcut for --target cloud')
    .option('--extension', 'Shortcut for --target extension')
    .option('--device-id <id>', 'Target extension device ID')
    .option('--settings-json <json>', 'Scrape settings JSON')
    .option('--options-json <json>', 'Execution options JSON')
    .option('--response-json <json>', 'Response config JSON')
    .option('--webhooks-json <json>', 'Webhooks JSON array')
    .option('--auth-token <token>', 'Optional Google OAuth access token for authenticated scraping contexts')
    .option('--prefer-extension', 'Prefer extension path in auto mode')
    .option('--require-local-session', 'Require extension/local session or fail')
    .option('--no-stream', 'Disable SSE progress streaming (enabled by default)')
    .option('--no-stream-output', 'Hide tool output payloads in streamed progress events')
    .option('--json', 'Output JSON')
    .action(async (options: ScrapeOptions) => {
      if (!options.url || options.url.length === 0) {
        throw new Error('At least one --url is required for scrape.');
      }

      const { config, client, auth } = await loadAuthedClient();
      const target = resolveTargetSelection(options.target, options.cloud, options.extension);
      const requestedMode = target ?? config.defaultTarget;
      if (requestedMode === 'cloud') {
        assertCloudTokenForCloudEndpoints(auth.token as string, '`rtrvr scrape` (cloud mode)');
      }
      const request: StreamableUnifiedScrapeRequest = {
        urls: options.url,
        target,
        deviceId: options.deviceId,
        settings: parseJsonText(options.settingsJson, '--settings-json'),
        options: parseJsonText(options.optionsJson, '--options-json'),
        response: parseJsonText(options.responseJson, '--response-json') as
          | { inlineOutputMaxBytes?: number }
          | undefined,
        webhooks: parseWebhooks(options.webhooksJson),
        authToken: options.authToken?.trim() || undefined,
        preferExtension: options.preferExtension,
        requireLocalSession: options.requireLocalSession,
      };

      const streamMode = options.stream ? resolveStreamModeForScrapeRequest(request, config) : undefined;
      if (options.stream && streamMode === 'cloud') {
        assertCloudTokenForCloudEndpoints(auth.token as string, '`rtrvr scrape --stream` (cloud mode)');
      }

      const result = options.stream
        ? await executeWithEventStream({
          baseUrl: config.mcpBaseUrl,
          token: auth.token as string,
          includeOutput: Boolean(options.streamOutput),
          jsonMode: options.json,
          requestLabel: 'scrape',
          ...prepareScrapeStreamRequest(request),
          execute: () => client.scrape.route(request),
        })
        : await client.scrape.route(request);
      emitOutput(result, options.json);
    });

  root
    .command('extension')
    .description('Run extension planner directly through /mcp.')
    .argument('<input...>', 'Natural language task input')
    .option('-u, --url <url...>', 'Starting URL(s)')
    .option('--file-url <url...>', 'File URL(s)')
    .option('--schema-file <path>', 'Path to schema JSON file')
    .option('--device-id <id>', 'Target extension device ID')
    .option('--json', 'Output JSON')
    .action(async (inputParts: string[], options: CommonRunOptions) => {
      const { client } = await loadAuthedClient();
      const schema = await maybeReadJsonFile(options.schemaFile);

      const result = await client.extension.run({
        input: inputParts.join(' '),
        urls: options.url,
        schema,
        fileUrls: options.fileUrl,
        deviceId: options.deviceId,
      });
      const responseMeta = extractResponseMeta(result);

      emitOutput(
        {
          metadata: {
            selectedMode: 'extension',
            requestedMode: 'extension',
            fallbackApplied: false,
            deviceId: options.deviceId,
            requestId: responseMeta.requestId,
            attempt: responseMeta.attempt,
          },
          data: result,
        },
        options.json,
      );
    });

  const devices = root.command('devices').description('Device management for extension routing.');
  devices
    .command('list')
    .description('List currently available extension devices.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      const { client } = await loadAuthedClient();
      const result = await client.devices.list();
      emitOutput(result, options.json);
    });
}

function registerRawCommands(root: Command): void {
  root
    .command('tool')
    .description('Call a specific /mcp tool directly.')
    .argument('<tool>', 'Tool name')
    .option('--param <key=value...>', 'Tool param key=value pairs')
    .option('--params-json <json>', 'Tool params JSON object')
    .option('--device-id <id>', 'Target extension device ID')
    .option('--json', 'Output JSON')
    .action(async (tool: string, options: ToolOptions) => {
      const { client } = await loadAuthedClient();
      const paramsJson = parseJsonText(options.paramsJson, '--params-json') ?? {};
      const paramsFromPairs = parseKeyValuePairs(options.param);

      const result = await client.tools.run({
        tool,
        params: {
          ...paramsJson,
          ...paramsFromPairs,
        },
        deviceId: options.deviceId,
      });

      emitOutput(result, options.json);
    });

  for (const [shortcut, canonical] of Object.entries(TOOL_SHORTCUTS) as Array<[keyof typeof TOOL_SHORTCUTS, string]>) {
    root
      .command(shortcut)
      .description(`Run raw ${canonical} tool through /mcp.`)
      .argument('<input...>', 'Tool user_input text')
      .option('-u, --url <url...>', 'tab_urls for the tool')
      .option('--schema-file <path>', 'Optional schema JSON file')
      .option('--file-url <url...>', 'Optional file_urls')
      .option('--device-id <id>', 'Target extension device ID')
      .option('--param <key=value...>', 'Additional params key=value')
      .option('--json', 'Output JSON')
      .action(async (inputParts: string[], options: CommonRunOptions & { param?: string[] }) => {
        const { client } = await loadAuthedClient();
        const schema = await maybeReadJsonFile(options.schemaFile);
        const extra = parseKeyValuePairs(options.param);

        const result = await client.tools.run({
          tool: canonical,
          params: {
            user_input: inputParts.join(' '),
            tab_urls: options.url,
            schema,
            file_urls: options.fileUrl,
            ...extra,
          },
          deviceId: options.deviceId,
        });

        emitOutput(result, options.json);
      });
  }
}

function registerConfigCommands(root: Command): void {
  const configCommand = root.command('config').description('General CLI config operations.');

  configCommand
    .command('get')
    .description('Get all config or a specific key.')
    .argument('[key]', 'Config key')
    .option('--json', 'Output JSON')
    .action(async (key: string | undefined, options: { json?: boolean }) => {
      const config = await loadConfig();
      const record = config as unknown as Record<string, unknown>;

      const payload = key
        ? { [key]: key === 'defaultTarget' ? config.defaultTarget : record[key] }
        : {
          ...config,
          defaultTarget: config.defaultTarget,
          apiKey: config.apiKey ? maskApiKey(config.apiKey) : undefined,
        };

      emitOutput(payload, options.json);
    });

  configCommand
    .command('set')
    .description('Set a config key.')
    .argument('<key>', 'Config key')
    .argument('<value>', 'Config value')
    .option('--json', 'Output JSON')
    .action(async (key: string, value: string, options: { json?: boolean }) => {
      const config = await loadConfig();
      const record = config as unknown as Record<string, unknown>;

      if (key === 'defaultTarget') {
        config.defaultTarget = ensureValidMode(value);
      } else if (key === 'preferExtensionByDefault' || key === 'telemetryOptIn') {
        record[key] = value === 'true';
      } else if (key === 'cloudBaseUrl' || key === 'mcpBaseUrl' || key === 'controlBaseUrl') {
        record[key] = value;
      } else if (key === 'authStorage') {
        config.authStorage = ensureValidAuthStorage(value);
      } else if (
        key === 'oauthPollIntervalMs'
        || key === 'oauthTimeoutMs'
        || key === 'retryMaxAttempts'
        || key === 'retryBaseDelayMs'
        || key === 'retryMaxDelayMs'
      ) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`${key} must be a positive number.`);
        }
        if (key === 'retryMaxAttempts') {
          record[key] = Math.max(1, Math.floor(parsed));
        } else {
          record[key] = Math.floor(parsed);
        }
      } else if (key === 'apiKey') {
        if (!isSupportedAuthToken(value)) {
          throw new Error('apiKey must start with rtrvr_ or mcp_at_.');
        }
        await persistAuthToken(config, value);
        emitOutput({ success: true, key, value: maskApiKey(value) }, options.json);
        return;
      } else {
        throw new Error(`Unsupported config key '${key}'.`);
      }

      await saveConfig(config);
      const outputValue = key === 'defaultTarget' ? config.defaultTarget : record[key];
      emitOutput({ success: true, key, value: outputValue }, options.json);
    });
}

function registerProfileCommands(root: Command): void {
  const profile = root.command('profile').description('Identity and capability profile.');
  profile
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      await handleProfileGet(options.json);
    });

  profile
    .command('get')
    .description('Get profile data from cloud endpoint.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      await handleProfileGet(options.json);
    });

  profile
    .command('capabilities')
    .description('Get capability map from cloud endpoint.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      await handleCapabilitiesGet(options.json);
    });

  root
    .command('capabilities')
    .description('Alias for `rtrvr profile capabilities`.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      await handleCapabilitiesGet(options.json);
    });
}

function registerMcpCommands(root: Command): void {
  const mcp = root.command('mcp').description('MCP endpoint helpers.');

  mcp
    .command('url')
    .description('Print MCP URL for api-key or OAuth mode.')
    .option('--device-id <id>', 'Optional device ID')
    .option('--oauth', 'Emit OAuth-style URL (no apiKey query param)')
    .option('--json', 'Output JSON')
    .action(async (options: { deviceId?: string; oauth?: boolean; json?: boolean }) => {
      const config = await loadConfig();
      const authMode: McpAuthMode = options.oauth ? 'oauth' : 'api-key';

      let apiKey: string | undefined;
      if (authMode === 'api-key') {
        const resolved = await resolveAuthToken(config, true);
        apiKey = resolved.token;
        if (apiKey && apiKey.startsWith('mcp_at_')) {
          throw new Error('mcp_at_ token cannot be used as apiKey query param. Use --oauth.');
        }
      }

      const url = buildMcpUrl({
        baseUrl: config.mcpBaseUrl,
        apiKey,
        deviceId: options.deviceId,
        authMode,
      });

      emitOutput({ url, authMode }, options.json);
    });

  mcp
    .command('init')
    .description('Generate MCP profile snippets for common clients.')
    .option('--client <type>', 'claude|cursor|generic', 'generic')
    .option('--device-id <id>', 'Optional device ID')
    .option('--oauth', 'Generate OAuth-mode snippet')
    .option('--json', 'Output JSON')
    .action(async (options: { client: string; deviceId?: string; oauth?: boolean; json?: boolean }) => {
      const config = await loadConfig();
      if (!isMcpClientType(options.client)) {
        throw new Error(`Invalid --client '${options.client}'. Use claude, cursor, or generic.`);
      }

      const authMode: McpAuthMode = options.oauth ? 'oauth' : 'api-key';
      let apiKey: string | undefined;
      if (authMode === 'api-key') {
        const resolved = await resolveAuthToken(config, true);
        apiKey = resolved.token;
        if (apiKey && apiKey.startsWith('mcp_at_')) {
          throw new Error('mcp_at_ token cannot be used as apiKey query param. Use --oauth.');
        }
      }

      const profile = buildMcpProfile(options.client, {
        baseUrl: config.mcpBaseUrl,
        apiKey,
        deviceId: options.deviceId,
        authMode,
      });
      emitOutput(profile, options.json ?? true);
    });
}

function registerDoctorCommand(root: Command): void {
  root
    .command('doctor')
    .description('Run connectivity, auth, and capability diagnostics.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      const config = await loadConfig();
      const result: Record<string, unknown> = {
        config: {
          cloudBaseUrl: config.cloudBaseUrl,
          mcpBaseUrl: config.mcpBaseUrl,
          controlBaseUrl: config.controlBaseUrl,
          defaultTarget: config.defaultTarget,
          preferExtensionByDefault: config.preferExtensionByDefault,
          authStorage: config.authStorage,
          retryMaxAttempts: config.retryMaxAttempts,
          retryBaseDelayMs: config.retryBaseDelayMs,
          retryMaxDelayMs: config.retryMaxDelayMs,
        },
      };

      const resolved = await resolveAuthToken(config, false);
      result.auth = {
        authenticated: Boolean(resolved.token),
        source: resolved.source,
        token: resolved.token ? maskApiKey(resolved.token) : undefined,
      };

      result.cloudHealth = await probeJson(`${config.cloudBaseUrl.replace(/\/$/, '')}/health`);
      result.mcp = await probeHead(config.mcpBaseUrl);

      if (resolved.token) {
        const client = buildClient(config, resolved.token);
        const [devices, credits, profile, capabilities] = await Promise.all([
          client.devices.list().catch((error: unknown) => ({ error: toErrorMessage(error) })),
          client.credits.get().catch((error: unknown) => ({ error: toErrorMessage(error) })),
          client.profile.get().catch((error: unknown) => ({ error: toErrorMessage(error) })),
          client.profile.capabilities().catch((error: unknown) => ({ error: toErrorMessage(error) })),
        ]);

        result.devices = devices;
        result.credits = credits;
        result.profile = profile;
        result.capabilities = capabilities;
      }

      emitOutput(result, options.json);
    });
}

function registerSkillsCommands(root: Command): void {
  const skills = root.command('skills').description('Manage local reusable RTRVR skills.');

  skills
    .command('list')
    .description('List installed local skills.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      emitOutput(await listSkills(), options.json);
    });

  skills
    .command('show')
    .description('Show an installed skill by name.')
    .argument('<name>', 'Skill name')
    .option('--json', 'Output JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      emitOutput(await loadSkillByName(name), options.json);
    });

  skills
    .command('export')
    .description('Export a skill as JSON or markdown.')
    .argument('<name>', 'Skill name')
    .option('--format <format>', 'json|markdown', 'json')
    .option('--json', 'Output JSON wrapper')
    .action(async (name: string, options: { format: string; json?: boolean }) => {
      const skill = await loadSkillByName(name);
      const format = options.format.toLowerCase();
      if (format !== 'json' && format !== 'markdown') {
        throw new Error(`Invalid --format '${options.format}'. Use json or markdown.`);
      }

      if (format === 'markdown') {
        if (options.json) {
          emitOutput({ format: 'markdown', content: renderSkillAsMarkdown(skill) }, true);
          return;
        }
        printLine(renderSkillAsMarkdown(skill));
        return;
      }

      emitOutput(skill, options.json ?? true);
    });

  skills
    .command('validate')
    .description('Validate a skill against available MCP capabilities.')
    .argument('<name>', 'Skill name')
    .option('--json', 'Output JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      const skill = await loadSkillByName(name);
      const capabilities = await getCapabilitiesSnapshot();
      const supportedTools = extractSupportedToolNames(capabilities.data);
      const compatibility = validateSkillToolCompatibility(skill, supportedTools);

      emitOutput(
        {
          skill: skill.name,
          schemaVersion: skill.schemaVersion,
          source: capabilities.source,
          degraded: capabilities.degraded,
          supportedToolCount: supportedTools.length,
          valid: compatibility.valid,
          missingTools: compatibility.missingTools,
        },
        options.json,
      );
    });

  skills
    .command('remove')
    .description('Remove an installed skill by name.')
    .argument('<name>', 'Skill name')
    .option('--json', 'Output JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      const removed = await removeSkillByName(name);
      emitOutput({ success: removed, removed }, options.json);
    });

  skills
    .command('add')
    .description('Add a skill from markdown or JSON file.')
    .argument('<path>', 'Path to .md or .json skill file')
    .option('--json', 'Output JSON')
    .action(async (skillPath: string, options: { json?: boolean }) => {
      await fs.access(skillPath);
      const skill = await addSkillFromFile(skillPath);
      emitOutput({ success: true, skill }, options.json);
    });

  skills
    .command('templates')
    .description('List built-in skill templates.')
    .option('--json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      const templates = listBuiltinSkillTemplates().map((template) => ({
        id: template.id,
        schemaVersion: template.schemaVersion,
        name: template.name,
        description: template.description,
        defaultTarget: template.defaultTarget,
        requiresLocalSession: template.requiresLocalSession,
        mcpTools: template.mcpTools,
      }));
      emitOutput(templates, options.json);
    });

  skills
    .command('print-template')
    .description('Print a built-in skill template in markdown format.')
    .argument('<id>', 'Template ID')
    .option('--json', 'Output JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      const template = getBuiltinSkillTemplate(id);
      if (options.json) {
        emitOutput(template, true);
        return;
      }
      printLine(renderSkillAsMarkdown(template));
    });

  skills
    .command('install-template')
    .description('Install a built-in template into local skills.')
    .argument('<id>', 'Template ID')
    .option('--name <name>', 'Override installed skill name')
    .option('--json', 'Output JSON')
    .action(async (id: string, options: { name?: string; json?: boolean }) => {
      const skill = await installBuiltinSkillTemplate(id, options.name);
      emitOutput({ success: true, skill }, options.json);
    });

  skills
    .command('apply')
    .description('Apply a skill template and execute via unified run.')
    .argument('<name>', 'Skill name')
    .argument('<input...>', 'User task input')
    .option('-u, --url <url...>', 'Starting URL(s)')
    .option('--target <target>', 'Override target: auto|cloud|extension')
    .option('--cloud', 'Shortcut for --target cloud')
    .option('--extension', 'Shortcut for --target extension')
    .option('--skip-capability-check', 'Skip skill tool preflight checks')
    .option('--json', 'Output JSON')
    .action(async (name: string, inputParts: string[], options: SkillsApplyOptions) => {
      const { client } = await loadAuthedClient();
      const skill = await loadSkillByName(name);

      if (!options.skipCapabilityCheck) {
        const capabilities = await getCapabilitiesSnapshot();
        const supportedTools = extractSupportedToolNames(capabilities.data);
        const compatibility = validateSkillToolCompatibility(skill, supportedTools);
        if (!compatibility.valid) {
          throw new Error(
            `Skill '${skill.name}' requires unavailable tools: ${compatibility.missingTools.join(', ')}. `
            + 'Run `rtrvr skills validate <name>` for details.',
          );
        }
      }

      const request = buildRunRequestFromSkill(skill, inputParts.join(' '), options.url);
      const target = resolveTargetSelection(options.target, options.cloud, options.extension);
      if (target) {
        request.target = target;
      }
      emitOutput(await client.run(request), options.json);
    });
}

function addAuthLoginOptions(command: Command): Command {
  return command
    .option('--api-key <key>', 'RTRVR API key/token (rtrvr_... or mcp_at_...)')
    .option('--target <target>', 'Default run target: auto|cloud|extension (preferred)')
    .option('--cloud', 'Shortcut for --target cloud')
    .option('--extension', 'Shortcut for --target extension')
    .option('--prefer-extension', 'Prefer extension in auto mode')
    .option('--cloud-base-url <url>', 'Override cloud API base URL')
    .option('--mcp-base-url <url>', 'Override MCP base URL')
    .option('--control-base-url <url>', 'Override CLI control-plane base URL (/cli/* endpoints)')
    .option('--storage <mode>', 'Credential storage: auto|keychain|config')
    .option('--open', 'Open API key page before fallback prompt')
    .option('--oauth', 'Force OAuth bootstrap login flow first')
    .option('--strict-auth', 'Fail login if OAuth is unavailable (no fallback)')
    .option('--no-browser', 'Do not open browser for OAuth/API key pages')
    .option('--json', 'Output JSON');
}

async function handleAuthLogin(options: AuthLoginOptions): Promise<void> {
  const config = await loadConfig();
  applyAuthConfigOverrides(config, options);

  let token = options.apiKey?.trim() || process.env.RTRVR_AUTH_TOKEN?.trim() || process.env.RTRVR_API_KEY?.trim();
  let loginMethod: 'api-key' | 'oauth' | 'prompt' = token ? 'api-key' : 'prompt';
  let oauthDetails: Record<string, unknown> | undefined;
  let oauthAttempted = false;
  let oauthUnavailable: string | undefined;
  let fallbackUsed = false;
  const strictAuth = Boolean(options.strictAuth);

  if (!token) {
    const shouldTryOAuth = Boolean(options.oauth) || (isInteractiveTerminal() && options.browser !== false);
    if (shouldTryOAuth) {
      oauthAttempted = true;
      try {
        const oauthResult = await executeOAuthLogin(config, options.browser !== false);
        token = oauthResult.token;
        loginMethod = 'oauth';
        oauthDetails = oauthResult.details;
      } catch (error) {
        oauthUnavailable = toErrorMessage(error);
        if (strictAuth) {
          throw new Error(`OAuth login failed in strict mode: ${oauthUnavailable}`);
        }
        if (!isInteractiveTerminal()) {
          throw error;
        }
        printLine(`OAuth login unavailable: ${oauthUnavailable}`);
      }
    }
  }

  if (!token) {
    if (options.open && options.browser !== false) {
      tryOpenInBrowser('https://rtrvr.ai/cloud?view=api-keys');
    }
    token = await promptForTokenIfMissing();
    if (token) {
      loginMethod = 'prompt';
      fallbackUsed = oauthAttempted;
    }
  }

  if (!token) {
    throw new Error('No auth token provided. Use --api-key, set RTRVR_API_KEY, or run interactive OAuth login.');
  }

  if (!isSupportedAuthToken(token)) {
    throw new Error('Invalid auth token. Expected prefix rtrvr_... or mcp_at_....');
  }

  const storageOverride = options.storage ? ensureValidAuthStorage(options.storage) : undefined;
  const stored = await persistAuthToken(config, token, storageOverride);

  if (options.json) {
    printJson({
      success: true,
      token: maskApiKey(token),
      method: loginMethod,
      oauthAttempted,
      oauthUnavailable,
      fallbackUsed,
      strictAuth,
      storage: stored.storage,
      backend: stored.backend,
      defaultTarget: config.defaultTarget,
      preferExtensionByDefault: config.preferExtensionByDefault,
      cloudBaseUrl: config.cloudBaseUrl,
      mcpBaseUrl: config.mcpBaseUrl,
      controlBaseUrl: config.controlBaseUrl,
      oauth: oauthDetails,
    });
    return;
  }

  printLine('RTRVR authentication saved.');
  printKeyValue('Token', maskApiKey(token));
  printKeyValue('Method', loginMethod);
  printKeyValue('OAuth attempted', String(oauthAttempted));
  printKeyValue('Fallback used', String(fallbackUsed));
  if (oauthUnavailable) {
    printKeyValue('OAuth warning', oauthUnavailable);
  }
  printKeyValue('Storage', stored.storage);
  printKeyValue('Default target', config.defaultTarget);
  printKeyValue('Prefer extension', String(config.preferExtensionByDefault));
  printKeyValue('Cloud base URL', config.cloudBaseUrl);
  printKeyValue('MCP base URL', config.mcpBaseUrl);
  printKeyValue('Control base URL', config.controlBaseUrl);
}

async function handleAuthStatus(jsonMode?: boolean): Promise<void> {
  const config = await loadConfig();
  const resolved = await resolveAuthToken(config, false);
  const secureBackend = await detectSecureStoreBackend();

  let credits: unknown;
  if (resolved.token) {
    const client = buildClient(config, resolved.token);
    try {
      credits = await client.credits.get();
    } catch (error) {
      credits = {
        warning: 'Unable to fetch credits.',
        error: toErrorMessage(error),
      };
    }
  }

  emitOutput(
    {
      authenticated: Boolean(resolved.token),
      source: resolved.source,
      token: resolved.token ? maskApiKey(resolved.token) : undefined,
      secureStoreBackend: secureBackend,
      authStorageMode: config.authStorage,
      defaultTarget: config.defaultTarget,
      preferExtensionByDefault: config.preferExtensionByDefault,
      cloudBaseUrl: config.cloudBaseUrl,
      mcpBaseUrl: config.mcpBaseUrl,
      controlBaseUrl: config.controlBaseUrl,
      retryMaxAttempts: config.retryMaxAttempts,
      retryBaseDelayMs: config.retryBaseDelayMs,
      retryMaxDelayMs: config.retryMaxDelayMs,
      credits,
    },
    jsonMode,
  );
}

async function handleGoogleAuthStatus(jsonMode?: boolean): Promise<void> {
  const { config, auth } = await loadAuthedClient();
  const token = auth.token as string;
  assertCloudTokenForCloudEndpoints(token, '`rtrvr auth google status`');

  const status = await fetchCliGoogleAuthStatus(config, token);
  emitOutput(status, jsonMode);
}

async function handleGoogleAuthLogin(options: AuthGoogleCommandOptions): Promise<void> {
  const { config, auth } = await loadAuthedClient();
  const token = auth.token as string;
  assertCloudTokenForCloudEndpoints(token, '`rtrvr auth google login`');

  const status = await fetchCliGoogleAuthStatus(config, token);
  const connectUrl = status.connectUrl || 'https://rtrvr.ai/cloud?view=settings';
  const shouldOpenBrowser = options.browser !== false && (Boolean(options.open) || isInteractiveTerminal());

  if (shouldOpenBrowser) {
    tryOpenInBrowser(connectUrl);
  }

  const payload = {
    ...status,
    connectUrl,
    openedBrowser: shouldOpenBrowser,
  };

  if (options.json) {
    printJson(payload);
    return;
  }

  printKeyValue('Google linked', String(Boolean(status.linked)));
  printKeyValue('Source', status.source || 'none');
  if (status.usableFor?.sheets !== undefined) {
    printKeyValue('Sheets enabled', String(Boolean(status.usableFor.sheets)));
  }
  if (status.usableFor?.docs !== undefined) {
    printKeyValue('Docs enabled', String(Boolean(status.usableFor.docs)));
  }
  if (status.usableFor?.slides !== undefined) {
    printKeyValue('Slides enabled', String(Boolean(status.usableFor.slides)));
  }
  if (status.reason) {
    printKeyValue('Reason', status.reason);
  }
  printKeyValue('Connect URL', connectUrl);
  if (shouldOpenBrowser) {
    printLine('Opened browser for Google OAuth linking.');
  } else {
    printLine('Open the URL above to connect Google OAuth.');
  }
}

async function fetchCliGoogleAuthStatus(config: CliConfig, token: string): Promise<CliGoogleAuthStatus> {
  const authBase = config.controlBaseUrl.replace(/\/$/, '');
  const response = await fetch(`${authBase}/cli/google-auth/status`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  const text = await response.text();
  const payload = safeJson(text);
  const record = ensureRecord(payload);

  if (!response.ok) {
    const message = typeof record.error === 'string'
      ? record.error
      : (typeof ensureRecord(record.error).message === 'string'
        ? String(ensureRecord(record.error).message)
        : `HTTP ${response.status}`);
    throw new Error(message);
  }

  const usableForRaw = ensureRecord(record.usableFor);
  const usableFor: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(usableForRaw)) {
    if (typeof value === 'boolean') {
      usableFor[key] = value;
    }
  }

  return {
    linked: typeof record.linked === 'boolean' ? record.linked : undefined,
    source: typeof record.source === 'string' ? record.source : undefined,
    usableFor,
    scopes: Array.isArray(record.scopes) ? record.scopes.filter((value): value is string => typeof value === 'string') : undefined,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    connectUrl: typeof record.connectUrl === 'string' ? record.connectUrl : undefined,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : undefined,
  };
}

async function handleProfileGet(jsonMode?: boolean): Promise<void> {
  const { client } = await loadAuthedClient();
  const result = await client.profile.get();
  emitOutput(
    {
      source: 'cloud',
      degraded: false,
      checkedAt: new Date().toISOString(),
      data: result,
    },
    jsonMode,
  );
}

async function handleCapabilitiesGet(jsonMode?: boolean): Promise<void> {
  const snapshot = await getCapabilitiesSnapshot();
  emitOutput(snapshot, jsonMode);
}

function applyAuthConfigOverrides(config: CliConfig, options: AuthLoginOptions): void {
  const target = resolveTargetSelection(options.target, options.cloud, options.extension);
  if (target) {
    config.defaultTarget = target;
  }
  if (options.preferExtension) {
    config.preferExtensionByDefault = true;
  }
  if (options.cloudBaseUrl) {
    config.cloudBaseUrl = options.cloudBaseUrl;
  }
  if (options.mcpBaseUrl) {
    config.mcpBaseUrl = options.mcpBaseUrl;
  }
  if (options.controlBaseUrl) {
    config.controlBaseUrl = options.controlBaseUrl;
  }
  if (options.storage) {
    config.authStorage = ensureValidAuthStorage(options.storage);
  }
}

async function executeOAuthLogin(
  config: CliConfig,
  openBrowser: boolean,
): Promise<{ token: string; details: Record<string, unknown> }> {
  const start = await startCliOAuth(config.controlBaseUrl);
  const verificationUrl = start.verificationUrl ?? 'https://rtrvr.ai/cloud?view=api-keys';

  if (openBrowser) {
    tryOpenInBrowser(verificationUrl);
  }

  if (isInteractiveTerminal()) {
    printLine('Complete sign-in in your browser to continue CLI login.');
    printKeyValue('Verification URL', verificationUrl);
    if (start.userCode) {
      printKeyValue('User code', start.userCode);
    }
  }

  const polled = await pollCliOAuth(config.controlBaseUrl, start, {
    intervalMs: config.oauthPollIntervalMs,
    timeoutMs: config.oauthTimeoutMs,
  });

  if (polled.status !== 'approved') {
    throw new Error(`OAuth login failed with status '${polled.status}'.`);
  }

  const token = polled.apiKey ?? polled.token;
  if (!token || !isSupportedAuthToken(token)) {
    throw new Error('OAuth login returned an unsupported token.');
  }

  return {
    token,
    details: {
      sessionId: start.sessionId,
      status: polled.status,
      profile: polled.profile,
      expiresAt: start.expiresAt,
    },
  };
}

async function persistAuthToken(
  config: CliConfig,
  token: string,
  storageOverride?: AuthStorageMode,
): Promise<{ storage: AuthStorageMode | 'keychain'; backend: SecureStoreBackend }> {
  const requestedStorage = storageOverride ?? config.authStorage;

  if (requestedStorage !== 'config') {
    try {
      const secure = await setSecureApiKey(token);
      if (secure.stored) {
        delete config.apiKey;
        config.authStorage = requestedStorage;
        await saveConfig(config);
        return { storage: 'keychain', backend: secure.backend };
      }
    } catch (error) {
      if (requestedStorage === 'keychain') {
        throw new Error(`Failed to persist token in keychain: ${toErrorMessage(error)}`);
      }
    }
  }

  config.apiKey = token;
  config.authStorage = 'config';
  await saveConfig(config);
  return { storage: 'config', backend: 'none' };
}

async function migrateConfigTokenToSecureStore(config: CliConfig, token: string): Promise<ResolvedAuth | undefined> {
  try {
    const secure = await setSecureApiKey(token);
    if (!secure.stored) {
      return undefined;
    }

    delete config.apiKey;
    await saveConfig(config);

    return {
      token,
      source: secure.backend === 'secret-service' ? 'secret-service' : 'keychain',
    };
  } catch {
    return undefined;
  }
}

async function clearSavedAuth(config: CliConfig): Promise<void> {
  await clearSecureApiKey();
  await clearAuthFromConfig();
  config.apiKey = undefined;
}

async function resolveAuthToken(config: CliConfig, required: boolean): Promise<ResolvedAuth> {
  const envToken = process.env.RTRVR_AUTH_TOKEN?.trim() || process.env.RTRVR_API_KEY?.trim();
  if (envToken) {
    if (!isSupportedAuthToken(envToken)) {
      throw new Error('RTRVR_AUTH_TOKEN/RTRVR_API_KEY is invalid. Expected rtrvr_... or mcp_at_....');
    }
    return { token: envToken, source: 'env' };
  }

  if (config.authStorage !== 'config') {
    const secure = await getSecureApiKey();
    if (secure.value) {
      if (!isSupportedAuthToken(secure.value)) {
        throw new Error('Secure-store token is invalid. Clear credentials and login again.');
      }
      return {
        token: secure.value,
        source: secure.backend === 'secret-service' ? 'secret-service' : 'keychain',
      };
    }
  }

  if (config.apiKey) {
    if (!isSupportedAuthToken(config.apiKey)) {
      throw new Error('Configured token is invalid. Expected rtrvr_... or mcp_at_....');
    }

    if (config.authStorage !== 'config') {
      const migrated = await migrateConfigTokenToSecureStore(config, config.apiKey);
      if (migrated) {
        return migrated;
      }
    }

    return { token: config.apiKey, source: 'config' };
  }

  if (required) {
    throw new Error('No auth token configured. Run `rtrvr auth login` first.');
  }

  return { source: 'none' };
}

async function loadAuthedClient(): Promise<{ config: CliConfig; client: CliSdk; auth: ResolvedAuth }> {
  const config = await loadConfig();
  const auth = await resolveAuthToken(config, true);
  const client = buildClient(config, auth.token as string);
  return { config, client, auth };
}

function buildClient(config: CliConfig, token: string): CliSdk {
  return createRtrvrClient({
    apiKey: token,
    cloudBaseUrl: config.cloudBaseUrl,
    mcpBaseUrl: config.mcpBaseUrl,
    controlBaseUrl: config.controlBaseUrl,
    retryPolicy: {
      maxAttempts: config.retryMaxAttempts,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
    },
    defaultTarget: config.defaultTarget,
    preferExtensionByDefault: config.preferExtensionByDefault,
  });
}

function assertCloudTokenForCloudEndpoints(token: string, context: string): void {
  if (token.startsWith('rtrvr_')) {
    return;
  }

  throw new Error(
    `${context} requires an rtrvr_ API key. mcp_at_ tokens are supported for MCP/OAuth endpoints only.`,
  );
}

function resolveStreamModeForRequest(request: UnifiedRunRequest, config: CliConfig): 'cloud' | 'extension' {
  const requestedMode = request.target ?? config.defaultTarget;
  if (requestedMode === 'cloud') {
    return 'cloud';
  }
  // Auto mode checks for extension devices at runtime
  return 'extension';
}

function resolveStreamModeForScrapeRequest(request: UnifiedScrapeRequest, config: CliConfig): 'cloud' | 'extension' {
  const requestedMode = request.target ?? config.defaultTarget;
  if (requestedMode === 'cloud') {
    return 'cloud';
  }
  // Auto mode checks for extension devices at runtime
  return 'extension';
}

function prepareStreamRequest(request: UnifiedRunRequest): { trajectoryId: string; phase: number } {
  const trajectoryId = request.trajectoryId?.trim() || randomUUID();
  const phase = Number.isFinite(request.phase) && (request.phase as number) > 0
    ? Math.floor(request.phase as number)
    : 1;

  request.trajectoryId = trajectoryId;
  request.phase = phase;

  const optionsRecord = ensureRecord(request.options);
  const uiRecord = ensureRecord(optionsRecord.ui);
  request.options = {
    ...optionsRecord,
    ui: {
      ...uiRecord,
      emitEvents: true,
    },
  };

  return { trajectoryId, phase };
}

function prepareScrapeStreamRequest(request: StreamableUnifiedScrapeRequest): { trajectoryId: string; phase: number } {
  const trajectoryId = request.trajectoryId?.trim() || randomUUID();
  request.trajectoryId = trajectoryId;

  const optionsRecord = ensureRecord(request.options);
  const uiRecord = ensureRecord(optionsRecord.ui);
  request.options = {
    ...optionsRecord,
    ui: {
      ...uiRecord,
      emitEvents: true,
    },
  };

  return { trajectoryId, phase: 1 };
}

async function executeWithEventStream<T>(args: {
  baseUrl: string;
  token: string;
  trajectoryId: string;
  phase: number;
  includeOutput: boolean;
  jsonMode?: boolean;
  requestLabel: string;
  execute: () => Promise<T>;
}): Promise<T> {
  const streamAbortController = new AbortController();
  let streamWarning: string | undefined;

  const streamPromise = streamExecutionEvents({
    baseUrl: args.baseUrl,
    token: args.token,
    trajectoryId: args.trajectoryId,
    phase: args.phase,
    includeOutput: args.includeOutput,
    signal: streamAbortController.signal,
    onEvent: (event) => {
      const rendered = renderStreamEvent(event, args.includeOutput);
      if (!rendered) {
        return;
      }

      if (args.jsonMode) {
        process.stderr.write(
          `${JSON.stringify({ stream: { event: event.event, id: event.id, data: event.data } })}\n`,
        );
      } else {
        printLine(`[stream] ${rendered}`);
      }
    },
  }).catch((error: unknown) => {
    if (streamAbortController.signal.aborted) {
      return;
    }
    streamWarning = toErrorMessage(error);
  });

  try {
    return await args.execute();
  } finally {
    streamAbortController.abort();
    await streamPromise;
    if (streamWarning) {
      printError(
        `Progress stream for ${args.requestLabel} was unavailable (${streamWarning}). Final response is still valid.`,
      );
    }
  }
}

function renderStreamEvent(event: StreamExecutionEvent, includeOutput: boolean): string | undefined {
  const root = ensureRecord(event.data);
  const payload = ensureRecord(root.data);

  if (event.event === 'ready') {
    return `connected to execution ${String(root.trajectoryId || '')}`.trim();
  }

  if (event.event === 'execution_status') {
    const status = typeof root.status === 'string' ? root.status : undefined;
    return status ? `status: ${status}` : undefined;
  }

  if (event.event === 'done') {
    const status = typeof root.status === 'string' ? root.status : 'unknown';
    return `execution finished (${status})`;
  }

  if (event.event === 'error') {
    const message = typeof root.message === 'string'
      ? root.message
      : (typeof payload.error === 'string' ? payload.error : 'stream error');
    return `error: ${message}`;
  }

  if (event.event === 'planner_step') {
    const thought = typeof payload.thought === 'string' ? payload.thought : '';
    const toolCall = ensureRecord(payload.toolCall);
    const toolName = typeof toolCall.name === 'string' ? toolCall.name : undefined;
    if (toolName && thought) return `planner selected ${toolName}: ${thought}`;
    if (toolName) return `planner selected ${toolName}`;
    if (thought) return `planner: ${thought}`;
    return 'planner step';
  }

  if (event.event === 'tool_start') {
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'tool';
    return `${toolName} started`;
  }

  if (event.event === 'tool_progress') {
    const message = typeof payload.message === 'string' && payload.message.trim()
      ? payload.message
      : (typeof payload.thought === 'string' && payload.thought.trim()
        ? payload.thought
        : undefined);
    const outputRef = ensureRecord(payload.outputRef);
    const outputRefUrl = includeOutput ? readRefUrl(outputRef) : undefined;
    const outputPreview = includeOutput ? previewStreamOutput(payload.output) : undefined;

    if (message) {
      if (outputRefUrl) {
        return `${message} | outputRef=${outputRefUrl}`;
      }
      if (outputPreview) {
        return `${message} | output=${outputPreview}`;
      }
      return message;
    }

    const stepId = typeof payload.stepId === 'string' ? payload.stepId : 'step';
    if (outputRefUrl) {
      return `${stepId} in progress | outputRef=${outputRefUrl}`;
    }
    if (outputPreview) {
      return `${stepId} in progress | output=${outputPreview}`;
    }
    return `${stepId} in progress`;
  }

  if (event.event === 'tool_complete') {
    const toolName = typeof payload.toolName === 'string'
      ? payload.toolName
      : (typeof payload.stepId === 'string' ? payload.stepId : 'tool');
    const status = typeof payload.status === 'string' ? payload.status : 'completed';
    const error = typeof payload.error === 'string' ? ` (${payload.error})` : '';
    const base = `${toolName} ${status}${error}`;
    if (!includeOutput) {
      return base;
    }

    const details: string[] = [];
    const outputRef = ensureRecord(payload.outputRef);
    const outputRefUrl = readRefUrl(outputRef);
    if (outputRefUrl) {
      details.push(`outputRef=${outputRefUrl}`);
    } else if (payload.output !== undefined) {
      const outputPreview = previewStreamOutput(payload.output);
      if (outputPreview) {
        details.push(`output=${outputPreview}`);
      }
    }

    const resultRef = ensureRecord(payload.resultRef);
    const resultRefUrl = readRefUrl(resultRef);
    if (resultRefUrl) {
      details.push(`resultRef=${resultRefUrl}`);
    } else if (payload.result !== undefined) {
      const resultPreview = previewStreamOutput(payload.result);
      if (resultPreview) {
        details.push(`result=${resultPreview}`);
      }
    }

    const artifactSummary = summarizeToolArtifacts(payload);
    if (artifactSummary) {
      details.push(artifactSummary);
    }

    return details.length > 0 ? `${base} | ${details.join(' | ')}` : base;
  }

  if (event.event === 'credits_update') {
    const used = payload.creditsUsed;
    const left = payload.creditsLeft;
    if (typeof used === 'number' && typeof left === 'number') {
      return `credits: used ${used}, left ${left}`;
    }
    if (typeof used === 'number') {
      return `credits used: ${used}`;
    }
    return 'credits updated';
  }

  if (event.event === 'workflow_complete') {
    const status = typeof payload.status === 'string' ? payload.status : 'completed';
    const base = `workflow complete (${status})`;
    if (!includeOutput) {
      return base;
    }

    const details: string[] = [];

    const outputRef = ensureRecord(payload.outputRef);
    const outputRefUrl = readRefUrl(outputRef);
    if (outputRefUrl) {
      details.push(`outputRef=${outputRefUrl}`);
    } else if (payload.output !== undefined) {
      const outputPreview = previewStreamOutput(payload.output);
      if (outputPreview) {
        details.push(`output=${outputPreview}`);
      }
    }

    const resultRef = ensureRecord(payload.resultRef);
    const resultRefUrl = readRefUrl(resultRef);
    if (resultRefUrl) {
      details.push(`resultRef=${resultRefUrl}`);
    } else if (payload.result !== undefined) {
      const resultPreview = previewStreamOutput(payload.result);
      if (resultPreview) {
        details.push(`result=${resultPreview}`);
      }
    }

    const artifactSummary = summarizeToolArtifacts(payload);
    if (artifactSummary) {
      details.push(artifactSummary);
    }

    return details.length > 0 ? `${base} | ${details.join(' | ')}` : base;
  }

  return undefined;
}

function previewStreamOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) {
    return undefined;
  }

  if (typeof output === 'string') {
    return output.length > 180 ? `${output.slice(0, 180)}...` : output;
  }

  try {
    const serialized = JSON.stringify(output);
    if (!serialized) {
      return undefined;
    }
    return serialized.length > 180 ? `${serialized.slice(0, 180)}...` : serialized;
  } catch {
    return '[unserializable output]';
  }
}

function readRefUrl(reference: Record<string, unknown>): string | undefined {
  const downloadUrl = typeof reference.downloadUrl === 'string' ? reference.downloadUrl.trim() : '';
  if (downloadUrl) {
    return downloadUrl;
  }
  const path = typeof reference.path === 'string' ? reference.path.trim() : '';
  return path || undefined;
}

function summarizeToolArtifacts(payload: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const sheets = Array.isArray(payload.schemaHeaderSheetInfo) ? payload.schemaHeaderSheetInfo : [];
  if (sheets.length > 0) {
    parts.push(`sheets=${sheets.length}`);
  }

  const generated = ensureRecord(payload.generatedContentRef);
  const docs = Array.isArray(generated.docs) ? generated.docs.length : 0;
  const slides = Array.isArray(generated.slides) ? generated.slides.length : 0;
  const webpages = Array.isArray(generated.webpages) ? generated.webpages.length : 0;
  const pdfs = Array.isArray(generated.pdfs) ? generated.pdfs.length : 0;

  if (docs > 0) parts.push(`docs=${docs}`);
  if (slides > 0) parts.push(`slides=${slides}`);
  if (webpages > 0) parts.push(`webpages=${webpages}`);
  if (pdfs > 0) parts.push(`pdfs=${pdfs}`);

  return parts.length > 0 ? `artifacts(${parts.join(', ')})` : undefined;
}

async function buildRunRequest(inputText: string, options: CommonRunOptions): Promise<UnifiedRunRequest> {
  const target = resolveTargetSelection(options.target, options.cloud, options.extension);
  return {
    input: inputText,
    urls: options.url,
    target,
    deviceId: options.deviceId,
    fileUrls: options.fileUrl,
    schema: await maybeReadJsonFile(options.schemaFile),
    settings: parseJsonText(options.settingsJson, '--settings-json'),
    tools: parseJsonText(options.toolsJson, '--tools-json'),
    options: parseJsonText(options.optionsJson, '--options-json'),
    response: parseJsonText(options.responseJson, '--response-json') as
      | { verbosity?: 'final' | 'steps' | 'debug'; inlineOutputMaxBytes?: number }
      | undefined,
    webhooks: parseWebhooks(options.webhooksJson),
    authToken: options.authToken?.trim() || undefined,
    preferExtension: options.preferExtension,
    requireLocalSession: options.requireLocalSession,
  };
}

async function resolveInputText(inputParts: string[], options: Pick<CommonRunOptions, 'input' | 'inputFile'>): Promise<string> {
  const argInput = inputParts.join(' ').trim();
  const inlineInput = options.input?.trim();
  const inputFile = options.inputFile?.trim();
  const inlineIsStdin = inlineInput === '-';

  const explicitSourceCount = [argInput.length > 0, Boolean(inputFile), Boolean(inlineInput && !inlineIsStdin)]
    .filter(Boolean)
    .length;

  if (explicitSourceCount > 1) {
    throw new Error('Provide only one input source: positional <input...>, --input, or --input-file.');
  }

  if (inputFile) {
    return readInputFile(inputFile);
  }

  if (inlineInput && !inlineIsStdin) {
    return inlineInput;
  }

  if (inlineIsStdin) {
    return readInputFromStdin('stdin was requested with --input -, but no data was provided.');
  }

  if (argInput.length > 0) {
    return argInput;
  }

  if (!process.stdin.isTTY) {
    return readInputFromStdin('Expected input from stdin, but received an empty stream.');
  }

  throw new Error('Missing input. Provide <input...>, --input, --input-file, or pipe data via stdin.');
}

async function readInputFile(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Input file '${filePath}' is empty.`);
  }
  return trimmed;
}

async function readInputFromStdin(emptyError: string): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const text = chunks.join('').trim();
  if (!text) {
    throw new Error(emptyError);
  }
  return text;
}

async function getCapabilitiesSnapshot(): Promise<{
  source: 'cloud';
  degraded: boolean;
  checkedAt: string;
  data: unknown;
}> {
  const { client } = await loadAuthedClient();
  const checkedAt = new Date().toISOString();
  const result = await client.profile.capabilities();
  return {
    source: 'cloud',
    degraded: false,
    checkedAt,
    data: result,
  };
}

function extractSupportedToolNames(value: unknown): string[] {
  const result = new Set<string>();
  const root = ensureRecord(value);

  const rawTools = root.tools;
  if (Array.isArray(rawTools)) {
    for (const tool of rawTools) {
      if (typeof tool === 'string' && tool.trim().length > 0) {
        result.add(tool.trim());
      }
    }
  } else {
    const toolsRecord = ensureRecord(rawTools);

    const raw = toolsRecord.raw;
    if (Array.isArray(raw)) {
      for (const tool of raw) {
        if (typeof tool === 'string' && tool.trim().length > 0) {
          result.add(tool.trim());
        }
      }
    }

    const cloudTools = toolsRecord.cloudTools;
    if (Array.isArray(cloudTools)) {
      for (const tool of cloudTools) {
        if (typeof tool === 'string' && tool.trim().length > 0) {
          result.add(tool.trim());
        }
      }
    }

    for (const [toolName, enabled] of Object.entries(toolsRecord)) {
      if (typeof enabled === 'boolean' && enabled) {
        result.add(toolName);
      }
    }
  }

  return Array.from(result);
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractResponseMeta(value: unknown): { requestId?: string; attempt?: number } {
  const root = ensureRecord(value);
  const metadata = ensureRecord(root.metadata);

  const requestId = typeof metadata.requestId === 'string'
    ? metadata.requestId
    : (typeof root.requestId === 'string' ? root.requestId : undefined);
  const attempt = typeof metadata.attempt === 'number'
    ? metadata.attempt
    : (typeof root.attempt === 'number' ? root.attempt : undefined);

  return { requestId, attempt };
}

function emitOutput(payload: unknown, jsonMode?: boolean): void {
  if (jsonMode) {
    printJson(payload);
  } else {
    printHuman(payload);
  }
}

function resolveTargetSelection(
  target?: string,
  cloudFlag?: boolean,
  extensionFlag?: boolean,
): RunMode | undefined {
  if (cloudFlag && extensionFlag) {
    throw new Error('Conflicting target flags --cloud and --extension. Use one.');
  }

  const flagTarget = cloudFlag ? 'cloud' : (extensionFlag ? 'extension' : undefined);
  if (flagTarget && target && flagTarget !== target) {
    throw new Error(
      `Conflicting target selection: flag '${flagTarget}' does not match '${target}' from --target.`,
    );
  }

  if (!target && !flagTarget) {
    return undefined;
  }

  return ensureValidMode(flagTarget ?? target ?? 'auto');
}

function parseWebhooks(inputValue: string | undefined): UnifiedRunRequest['webhooks'] {
  if (!inputValue) {
    return undefined;
  }
  const parsed = parseJsonUnknown(inputValue, '--webhooks-json');
  if (!Array.isArray(parsed)) {
    throw new Error('--webhooks-json must be a JSON array.');
  }
  return parsed as UnifiedRunRequest['webhooks'];
}

function parseJsonUnknown(raw: string, flagName: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse ${flagName} as JSON: ${toErrorMessage(error)}`);
  }
}

async function probeJson(url: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: safeJson(text),
    };
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
    };
  }
}

async function probeHead(url: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return {
      ok: response.ok,
      status: response.status,
      oauthSupported: response.headers.get('x-oauth-supported') ?? undefined,
      mcpVersion: response.headers.get('x-mcp-version') ?? undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
    };
  }
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isMcpClientType(value: string): value is McpClientType {
  return value === 'claude' || value === 'cursor' || value === 'generic';
}

async function promptForTokenIfMissing(): Promise<string | undefined> {
  if (!isInteractiveTerminal()) {
    return undefined;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const entered = await rl.question('Paste RTRVR auth token (rtrvr_... or mcp_at_...): ');
    const trimmed = entered.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } finally {
    rl.close();
  }
}

function tryOpenInBrowser(url: string): void {
  const platform = process.platform;
  if (platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
