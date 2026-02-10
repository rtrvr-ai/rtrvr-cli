export const DEFAULT_CLOUD_BASE_URL = 'https://api.rtrvr.ai';
export const DEFAULT_MCP_BASE_URL = 'https://mcp.rtrvr.ai';
export const DEFAULT_CONTROL_BASE_URL = 'https://cli.rtrvr.ai';

export const DEFAULT_TIMEOUT_MS = 9 * 60 * 1000;

export const TOOL_NAMES = {
  PLANNER: 'planner',
  ACT: 'act_on_tab',
  EXTRACT: 'extract_from_tab',
  CRAWL: 'crawl_and_extract_from_tab',
  SCRAPE: 'scrape',
  GET_PAGE_DATA: 'get_page_data',
  REPLAY_WORKFLOW: 'replay_workflow',
  LIST_DEVICES: 'list_devices',
  GET_CURRENT_CREDITS: 'get_current_credits',
  CLOUD_AGENT: 'cloud_agent',
  CLOUD_SCRAPE: 'cloud_scrape',
} as const;

export const TOOL_NAME_ALIASES = {
  act: TOOL_NAMES.ACT,
  extract: TOOL_NAMES.EXTRACT,
  crawl: TOOL_NAMES.CRAWL,
  getPageData: TOOL_NAMES.GET_PAGE_DATA,
  listDevices: TOOL_NAMES.LIST_DEVICES,
  getCurrentCredits: TOOL_NAMES.GET_CURRENT_CREDITS,
} as const;
