/**
 * KEEL MCP protocol core — a stateless MCP server over Streamable HTTP
 * (JSON-RPC 2.0 in, JSON out). Pure: no Deno, no Supabase, no network, so it
 * runs unchanged under vitest and the Edge runtime.
 *
 * Why hand-rolled instead of the MCP SDK: KEEL only needs the tools
 * capability, answers every request with one JSON body (no SSE stream, no
 * server-initiated messages), and keeps no session state. That subset is
 * ~200 lines and keeps the function's dependency surface at zero. If KEEL
 * later needs resources, prompts, elicitation or streaming, swap this module
 * for the SDK's web-standard transport — the tool catalog does not change.
 *
 * Laws: tools are the SAME authorized catalog the in-app agent uses (Law 7);
 * every tool result is data-tier (Law 5) and carries as-of + scope (Law 11).
 */

/** Protocol revisions this server can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** JSON-RPC 2.0 error codes used by MCP. */
export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

type JsonRpcId = string | number;

export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** One tool as advertised in `tools/list`. */
export interface McpTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: McpToolAnnotations;
}

/** What `tools/call` returns (MCP CallToolResult, text-only subset). */
export interface McpToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface McpServerInfo {
  readonly name: string;
  readonly title: string;
  readonly version: string;
}

/**
 * Everything request-specific is injected: the caller has already verified
 * the bearer token and resolved the household + granted capabilities, so
 * `listTools` only returns tools this caller may use and `callTool` re-checks.
 */
export interface McpHandlerDeps {
  readonly serverInfo: McpServerInfo;
  readonly instructions: string;
  readonly listTools: () => readonly McpTool[];
  /** Returns null when the tool is not in this caller's catalog. */
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult | null>;
}

/** Transport-level outcome the HTTP layer turns into a Response. */
export type McpHttpOutcome =
  | { readonly status: 200; readonly body: Record<string, unknown> }
  | { readonly status: 202 }
  | { readonly status: 400; readonly body: Record<string, unknown> };

const rpcError = (id: JsonRpcId | null, code: number, message: string): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

const rpcResult = (id: JsonRpcId, result: Record<string, unknown>): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  result,
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isValidId = (v: unknown): v is JsonRpcId =>
  (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v));

/** Pick the protocol version to answer `initialize` with (spec: echo if supported, else our latest). */
export const negotiateProtocolVersion = (requested: unknown): string =>
  typeof requested === 'string' &&
  (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;

/**
 * Validate the `MCP-Protocol-Version` header sent on post-initialize
 * requests. Absent is allowed (spec: assume 2025-03-26); unknown is a 400.
 */
export const isAcceptableProtocolHeader = (header: string | null): boolean =>
  header === null ||
  header.length === 0 ||
  (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(header);

/**
 * Handle one POSTed JSON-RPC message. JSON-RPC batches were removed from MCP
 * in 2025-06-18, so an array body is rejected as an invalid request.
 */
export const handleMcpMessage = async (
  message: unknown,
  deps: McpHandlerDeps,
): Promise<McpHttpOutcome> => {
  if (!isRecord(message) || message['jsonrpc'] !== '2.0') {
    return { status: 400, body: rpcError(null, RPC_ERROR.invalidRequest, 'Invalid JSON-RPC message.') };
  }

  const method = message['method'];
  const hasId = 'id' in message;

  // A response or notification from the client: acknowledge, nothing to say.
  if (typeof method !== 'string') {
    return hasId && ('result' in message || 'error' in message)
      ? { status: 202 }
      : { status: 400, body: rpcError(null, RPC_ERROR.invalidRequest, 'Missing method.') };
  }
  if (!hasId) return { status: 202 }; // notifications/initialized, notifications/cancelled, …

  const id = message['id'];
  if (!isValidId(id)) {
    return { status: 400, body: rpcError(null, RPC_ERROR.invalidRequest, 'Invalid request id.') };
  }
  const params = isRecord(message['params']) ? message['params'] : {};

  switch (method) {
    case 'initialize':
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiateProtocolVersion(params['protocolVersion']),
          capabilities: { tools: { listChanged: false } },
          serverInfo: deps.serverInfo,
          instructions: deps.instructions,
        }),
      };

    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };

    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: deps.listTools() }) };

    case 'tools/call': {
      const name = params['name'];
      const rawArgs = params['arguments'];
      if (typeof name !== 'string' || (rawArgs !== undefined && !isRecord(rawArgs))) {
        return { status: 200, body: rpcError(id, RPC_ERROR.invalidParams, 'tools/call needs a name and object arguments.') };
      }
      let result: McpToolResult | null;
      try {
        result = await deps.callTool(name, rawArgs ?? {});
      } catch {
        // Never leak internals (Law 12); the tool layer already logs.
        return { status: 200, body: rpcError(id, RPC_ERROR.internalError, 'Tool execution failed.') };
      }
      if (result === null) {
        return { status: 200, body: rpcError(id, RPC_ERROR.invalidParams, `Unknown tool: ${name}`) };
      }
      return { status: 200, body: rpcResult(id, result as unknown as Record<string, unknown>) };
    }

    default:
      return { status: 200, body: rpcError(id, RPC_ERROR.methodNotFound, `Method not found: ${method}`) };
  }
};
