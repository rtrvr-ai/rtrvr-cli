export type McpClientType = 'claude' | 'cursor' | 'generic';
export type McpAuthMode = 'api-key' | 'oauth';

export interface McpProfileOptions {
  baseUrl: string;
  apiKey?: string;
  deviceId?: string;
  authMode?: McpAuthMode;
}

export function buildMcpUrl(options: McpProfileOptions): string {
  const url = new URL(options.baseUrl);
  const authMode = options.authMode ?? 'api-key';

  if (authMode === 'api-key') {
    if (!options.apiKey) {
      throw new Error('API key is required for MCP api-key mode.');
    }
    url.searchParams.set('apiKey', options.apiKey);
  }

  if (options.deviceId) {
    url.searchParams.set('deviceId', options.deviceId);
  }

  return url.toString();
}

export function buildMcpProfile(clientType: McpClientType, options: McpProfileOptions): Record<string, unknown> {
  const authMode = options.authMode ?? 'api-key';
  const url = buildMcpUrl(options);

  if (clientType === 'claude') {
    return {
      mcpServers: {
        rtrvr: {
          transport: 'http',
          url,
          ...(authMode === 'oauth' ? {
            notes: 'OAuth will be negotiated by the MCP client.',
          } : {}),
        },
      },
    };
  }

  if (clientType === 'cursor') {
    return {
      mcp: {
        servers: {
          rtrvr: {
            url,
          },
        },
      },
    };
  }

  return {
    endpoint: url,
    ...(authMode === 'api-key' && options.apiKey ? {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
      },
    } : {}),
    notes: [
      authMode === 'oauth'
        ? 'OAuth-capable MCP clients can use this endpoint directly and perform interactive auth.'
        : 'For API-key mode, keep this URL server-side and do not expose it in browser code.',
    ],
  };
}
