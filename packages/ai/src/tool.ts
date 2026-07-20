/**
 * Provider-agnostic tool-use loop for the KEEL agent (CLAUDE.md Law 7: the
 * agent reaches data ONLY through the same authorized domain contracts as every
 * other surface). This module is PURE: it knows nothing about Supabase, procs,
 * or HTTP. The edge function supplies an `executeTool` callback that runs each
 * tool call through `authorize()` + the proc dispatcher; this module only
 * sequences the model↔tool conversation and caps it.
 *
 * Law 1: tools return KEEL's precomputed numbers; the model never derives them.
 * Law 5: a tool RESULT is data-tier — the loop never lets a tool result become
 * a new instruction; it is fed back verbatim as a tool message and the system
 * prompt tells the model to treat tool output strictly as data.
 */

/** A JSON-Schema object describing a tool's arguments. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** One callable tool exposed to the model. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema (type:"object") for the arguments. */
  readonly parameters: JsonSchema;
}

/** A tool invocation the model asked for. */
export interface ToolCall {
  /** Provider-assigned id, echoed back with the result. */
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** The result of running one tool call, fed back to the model. */
export interface ToolResultMessage {
  readonly toolCallId: string;
  /** JSON-encoded content the model reads. Always a string on the wire. */
  readonly content: string;
}

/** Token usage for one provider turn (either count may be unknown). */
export interface ChatUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * An image the user attached. It is DATA-TIER (Law 5): a photo can contain text
 * that reads like an instruction, so the prompt tells the model to treat it as
 * information only, never as a command. base64-encoded; no data: prefix.
 */
export interface ImageInput {
  /** e.g. 'image/jpeg' | 'image/png' | 'image/webp'. */
  readonly mediaType: string;
  /** Raw base64 (no `data:...;base64,` prefix). */
  readonly dataBase64: string;
}

/**
 * Neutral conversation transcript. Each provider serializes this to its own
 * wire format, so the loop stays provider-agnostic.
 */
export type TranscriptEntry =
  | { readonly role: 'user'; readonly text: string; readonly image?: ImageInput }
  | { readonly role: 'assistant_text'; readonly text: string }
  | { readonly role: 'assistant_tool_calls'; readonly calls: readonly ToolCall[] }
  | { readonly role: 'tool_result'; readonly results: readonly ToolResultMessage[] };

/** One model turn: either it wants tools, or it produced a final message. */
export type AgentTurn =
  | {
      readonly kind: 'tool_calls';
      readonly calls: readonly ToolCall[];
      readonly modelVersion: string;
      readonly usage: ChatUsage;
    }
  | {
      readonly kind: 'message';
      readonly text: string;
      readonly modelVersion: string;
      readonly usage: ChatUsage;
    };

export interface ConverseInput {
  readonly system: string;
  readonly transcript: readonly TranscriptEntry[];
  /** Empty array = no tools offered (used to force a final answer). */
  readonly tools: readonly ToolDefinition[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/** A model provider that supports one round of tool-use. */
export interface AgentProvider {
  converse(input: ConverseInput): Promise<AgentTurn>;
}

export interface RunAgentInput {
  readonly provider: AgentProvider;
  readonly system: string;
  readonly tools: readonly ToolDefinition[];
  readonly userMessage: string;
  /** Optional image the user attached with the question (data-tier, Law 5). */
  readonly image?: ImageInput;
  /**
   * Runs one tool call and returns its JSON-encoded result string. MUST NOT
   * throw for authz/validation failures — return an error payload instead so
   * the model can react (e.g. tell the user it lacks access). Reserve throwing
   * for genuinely unexpected faults, which abort the run.
   */
  readonly executeTool: (call: ToolCall) => Promise<string>;
  /** Hard cap on model↔tool round-trips before a final answer is forced. */
  readonly maxSteps: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface ExecutedToolCall {
  readonly call: ToolCall;
  readonly result: string;
}

export interface AgentRunResult {
  readonly finalText: string;
  readonly steps: number;
  readonly toolCalls: readonly ExecutedToolCall[];
  readonly modelVersion: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly stoppedReason: 'final' | 'max_steps';
}

const addUsage = (
  acc: { inputTokens: number; outputTokens: number },
  usage: ChatUsage,
): { inputTokens: number; outputTokens: number } => ({
  inputTokens: acc.inputTokens + (usage.inputTokens ?? 0),
  outputTokens: acc.outputTokens + (usage.outputTokens ?? 0),
});

/**
 * Drive the tool-use loop to a final text answer.
 *
 * The loop is bounded by `maxSteps`. If the model is still calling tools when
 * the cap is hit, one final turn is issued with NO tools offered, forcing a
 * text answer. All tool results are collected for provenance ("what the agent
 * did"), and token usage is summed across every turn.
 */
export const runAgent = async (input: RunAgentInput): Promise<AgentRunResult> => {
  if (input.maxSteps < 1) {
    throw new Error('runAgent requires maxSteps >= 1');
  }
  const transcript: TranscriptEntry[] = [
    { role: 'user', text: input.userMessage, ...(input.image ? { image: input.image } : {}) },
  ];
  const executed: ExecutedToolCall[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let modelVersion = '';

  // Build a converse input without emitting `undefined` for absent optional
  // fields (exactOptionalPropertyTypes).
  const converseInput = (tools: readonly ToolDefinition[]): ConverseInput => ({
    system: input.system,
    transcript,
    tools,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  });

  for (let step = 0; step < input.maxSteps; step += 1) {
    const turn = await input.provider.converse(converseInput(input.tools));
    usage = addUsage(usage, turn.usage);
    modelVersion = turn.modelVersion;

    if (turn.kind === 'message') {
      return {
        finalText: turn.text,
        steps: step + 1,
        toolCalls: executed,
        modelVersion,
        usage,
        stoppedReason: 'final',
      };
    }

    // Model asked for tools — record the request, run them, feed results back.
    transcript.push({ role: 'assistant_tool_calls', calls: turn.calls });
    const results: ToolResultMessage[] = [];
    for (const call of turn.calls) {
      const result = await input.executeTool(call);
      executed.push({ call, result });
      results.push({ toolCallId: call.id, content: result });
    }
    transcript.push({ role: 'tool_result', results });
  }

  // Cap reached while still calling tools: force a final answer with no tools.
  const forced = await input.provider.converse(converseInput([]));
  usage = addUsage(usage, forced.usage);
  modelVersion = forced.modelVersion;
  const finalText =
    forced.kind === 'message'
      ? forced.text
      : 'I gathered the information but ran out of steps before finishing. Please ask again or narrow the question.';
  return {
    finalText,
    steps: input.maxSteps + 1,
    toolCalls: executed,
    modelVersion,
    usage,
    stoppedReason: 'max_steps',
  };
};
