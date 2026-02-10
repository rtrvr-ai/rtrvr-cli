import {
  CliCapabilitiesResponse,
  CliProfileResponse,
  ClientOptions,
  ExtensionPlannerRequest,
  RtrvrClient,
  ScrapeRequest,
  ToolRequest,
  UnifiedScrapeRequest,
  UnifiedScrapeResponse,
  UnifiedRunRequest,
  UnifiedRunResponse,
} from '@rtrvr-ai/core';

export * from '@rtrvr-ai/core';

export interface RtrvrSdk {
  run: (request: UnifiedRunRequest) => Promise<UnifiedRunResponse>;
  agent: {
    run: (request: UnifiedRunRequest) => Promise<UnifiedRunResponse>;
    cloud: (request: UnifiedRunRequest) => Promise<unknown>;
  };
  scrape: {
    run: (request: ScrapeRequest) => Promise<unknown>;
    route: (request: UnifiedScrapeRequest) => Promise<UnifiedScrapeResponse>;
  };
  extension: {
    run: (request: ExtensionPlannerRequest) => Promise<unknown>;
  };
  tools: {
    run: (request: ToolRequest) => Promise<unknown>;
    act: (params: Record<string, unknown>, deviceId?: string) => Promise<unknown>;
    extract: (params: Record<string, unknown>, deviceId?: string) => Promise<unknown>;
    crawl: (params: Record<string, unknown>, deviceId?: string) => Promise<unknown>;
    planner: (params: Record<string, unknown>, deviceId?: string) => Promise<unknown>;
  };
  devices: {
    list: () => Promise<unknown>;
  };
  credits: {
    get: () => Promise<unknown>;
  };
  profile: {
    get: () => Promise<CliProfileResponse>;
    capabilities: () => Promise<CliCapabilitiesResponse>;
  };
  raw: RtrvrClient;
}

export function createRtrvrClient(options: ClientOptions): RtrvrSdk {
  const raw = new RtrvrClient(options);

  return {
    run: (request) => raw.run(request),
    agent: {
      run: (request) => raw.agent(request),
      cloud: (request) => raw.agentRun({
        input: request.input,
        urls: request.urls,
        schema: request.schema,
        files: request.files,
        dataInputs: request.dataInputs,
        settings: request.settings,
        tools: request.tools,
        options: request.options,
        response: request.response,
        webhooks: request.webhooks,
        trajectoryId: request.trajectoryId,
        phase: request.phase,
        recordingContext: request.recordingContext,
        authToken: request.authToken,
      }),
    },
    scrape: {
      run: (request) => raw.scrapeRun(request),
      route: (request) => raw.scrape(request),
    },
    extension: {
      run: (request) => raw.extensionPlannerRun(request),
    },
    tools: {
      run: (request) => raw.toolRun(request),
      act: (params, deviceId) => raw.toolRun({ tool: 'act_on_tab', params, deviceId }),
      extract: (params, deviceId) => raw.toolRun({ tool: 'extract_from_tab', params, deviceId }),
      crawl: (params, deviceId) => raw.toolRun({ tool: 'crawl_and_extract_from_tab', params, deviceId }),
      planner: (params, deviceId) => raw.toolRun({ tool: 'planner', params, deviceId }),
    },
    devices: {
      list: () => raw.listDevices(),
    },
    credits: {
      get: () => raw.getCurrentCredits(),
    },
    profile: {
      get: () => raw.profileGet(),
      capabilities: () => raw.capabilitiesGet(),
    },
    raw,
  };
}
