/**
 * ABOUTME: Shared JSONL parsing module for agent plugins.
 * Extracts JSONL parsing logic that is common across agents (Claude, Qwen, etc.)
 * so that multiple plugins can reuse the same parsing infrastructure.
 *
 * Two-layer parsing:
 * - Layer 1: parseJsonlLine() extracts top-level fields into JsonlMessage
 * - Layer 2: parseJsonlLineToDisplayEvents() converts JSONL into AgentDisplayEvent[]
 */

import type { AgentDisplayEvent } from './output-formatting.js';

/**
 * Represents a parsed JSONL message from agent CLI output.
 * Agent CLIs (Claude, Qwen, etc.) emit various event types as JSON objects, one per line.
 */
export interface JsonlMessage {
  /** The type of message (e.g., 'assistant', 'user', 'result', 'system') */
  type?: string;
  /** Message content for text messages */
  message?: string;
  /** Tool use information if applicable */
  tool?: {
    name?: string;
    input?: Record<string, unknown>;
  };
  /** Result data for completion messages */
  result?: unknown;
  /** Cost information if provided */
  cost?: {
    inputTokens?: number;
    outputTokens?: number;
    totalUSD?: number;
  };
  /** Session ID for conversation tracking */
  sessionId?: string;
  /** Raw parsed JSON for custom handling */
  raw: Record<string, unknown>;
}

/**
 * Result of parsing a JSONL line.
 * Success contains the parsed message, failure contains the raw text.
 */
export type JsonlParseResult =
  | { success: true; message: JsonlMessage }
  | { success: false; raw: string; error: string };

/**
 * Parse a single line of JSONL output from an agent CLI.
 * Attempts to parse as JSON, falls back to raw text on failure.
 *
 * This is agent-agnostic — it extracts common fields (type, message, tool, cost,
 * sessionId, result) and preserves everything else in the `raw` field.
 *
 * @param line A single line of output (may include newline characters)
 * @returns Parse result with either the parsed message or raw text
 */
export function parseJsonlLine(line: string): JsonlParseResult {
  const trimmed = line.trim();

  // Skip empty lines
  if (!trimmed) {
    return { success: false, raw: line, error: 'Empty line' };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    // Build the structured message from parsed JSON
    const message: JsonlMessage = {
      raw: parsed,
    };

    // Extract common fields if present
    if (typeof parsed.type === 'string') {
      message.type = parsed.type;
    }
    if (typeof parsed.message === 'string') {
      message.message = parsed.message;
    }
    if (typeof parsed.sessionId === 'string') {
      message.sessionId = parsed.sessionId;
    }
    if (parsed.result !== undefined) {
      message.result = parsed.result;
    }

    // Extract tool information if present
    if (parsed.tool && typeof parsed.tool === 'object') {
      const toolObj = parsed.tool as Record<string, unknown>;
      message.tool = {
        name: typeof toolObj.name === 'string' ? toolObj.name : undefined,
        input:
          toolObj.input && typeof toolObj.input === 'object'
            ? (toolObj.input as Record<string, unknown>)
            : undefined,
      };
    }

    // Extract cost information if present
    if (parsed.cost && typeof parsed.cost === 'object') {
      const costObj = parsed.cost as Record<string, unknown>;
      message.cost = {
        inputTokens:
          typeof costObj.inputTokens === 'number'
            ? costObj.inputTokens
            : undefined,
        outputTokens:
          typeof costObj.outputTokens === 'number'
            ? costObj.outputTokens
            : undefined,
        totalUSD:
          typeof costObj.totalUSD === 'number' ? costObj.totalUSD : undefined,
      };
    }

    return { success: true, message };
  } catch (err) {
    // JSON parsing failed - return as raw text
    return {
      success: false,
      raw: line,
      error: err instanceof Error ? err.message : 'Parse error',
    };
  }
}

/**
 * Parse a complete JSONL output string from an agent CLI.
 * Handles multi-line output, parsing each line independently.
 * Lines that fail to parse are returned as raw text in the fallback array.
 *
 * @param output Complete output string (may contain multiple lines)
 * @returns Object with parsed messages and any raw fallback lines
 */
export function parseJsonlOutput(output: string): {
  messages: JsonlMessage[];
  fallback: string[];
} {
  const messages: JsonlMessage[] = [];
  const fallback: string[] = [];

  const lines = output.split('\n');

  for (const line of lines) {
    const result = parseJsonlLine(line);
    if (result.success) {
      messages.push(result.message);
    } else if (result.raw.trim()) {
      // Only add non-empty lines to fallback
      fallback.push(result.raw);
    }
  }

  return { messages, fallback };
}

/**
 * Create a streaming JSONL parser that accumulates partial lines.
 * Use this for processing streaming output where data chunks may
 * split across line boundaries.
 *
 * @returns Parser object with push() method and getState() to retrieve results
 */
export function createStreamingJsonlParser(): {
  push: (chunk: string) => JsonlParseResult[];
  flush: () => JsonlParseResult[];
  getState: () => { messages: JsonlMessage[]; fallback: string[] };
} {
  let buffer = '';
  const messages: JsonlMessage[] = [];
  const fallback: string[] = [];

  return {
    /**
     * Push a chunk of data to the parser.
     * Returns any complete lines that were parsed.
     */
    push(chunk: string): JsonlParseResult[] {
      buffer += chunk;
      const results: JsonlParseResult[] = [];

      // Process complete lines (ending with newline)
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        const result = parseJsonlLine(line);
        results.push(result);

        if (result.success) {
          messages.push(result.message);
        } else if (result.raw.trim()) {
          fallback.push(result.raw);
        }
      }

      return results;
    },

    /**
     * Flush any remaining buffered content.
     * Call this when the stream ends to process any trailing content.
     */
    flush(): JsonlParseResult[] {
      if (!buffer.trim()) {
        buffer = '';
        return [];
      }

      const result = parseJsonlLine(buffer);
      buffer = '';

      if (result.success) {
        messages.push(result.message);
      } else if (result.raw.trim()) {
        fallback.push(result.raw);
      }

      return [result];
    },

    /**
     * Get the current accumulated state.
     */
    getState(): { messages: JsonlMessage[]; fallback: string[] } {
      return { messages, fallback };
    },
  };
}

/**
 * Parse a single JSONL line into standardized display events.
 * Returns AgentDisplayEvent[] — the shared processAgentEvents decides what to show.
 *
 * Handles the stream-json format used by Claude Code, Qwen CLI, and compatible agents:
 * - "assistant": AI responses with content[] containing text and tool_use blocks
 * - "user": Tool results (contains file contents, command output)
 * - "system": Hooks, init data
 * - "result": Final result summary
 * - "error": Error messages
 */
export function parseJsonlLineToDisplayEvents(jsonLine: string): AgentDisplayEvent[] {
  if (!jsonLine || jsonLine.length === 0) return [];

  try {
    const event = JSON.parse(jsonLine) as Record<string, unknown>;
    const events: AgentDisplayEvent[] = [];

    // Parse assistant messages (text and tool use)
    if (event.type === 'assistant' && event.message) {
      const message = event.message as { content?: Array<Record<string, unknown>> };
      if (message.content && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            events.push({ type: 'text', content: block.text });
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            events.push({
              type: 'tool_use',
              name: block.name,
              input: block.input as Record<string, unknown>,
            });
          }
        }
      }
    }

    // Parse user/tool_result events - check for errors in tool results
    if (event.type === 'user') {
      const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
      if (message?.content && Array.isArray(message.content)) {
        for (const block of message.content) {
          // Surface tool result errors
          if (block.type === 'tool_result' && block.is_error === true) {
            const errorContent = typeof block.content === 'string'
              ? block.content
              : 'tool execution failed';
            events.push({ type: 'error', message: errorContent });
          }
        }
      }
      // Always include tool_result marker (shared logic will skip for display)
      events.push({ type: 'tool_result' });
    }

    // Parse system events
    if (event.type === 'system') {
      events.push({ type: 'system', subtype: event.subtype as string });
    }

    // Parse error events
    if (event.type === 'error' || event.error) {
      const errorMsg = typeof event.error === 'string'
        ? event.error
        : (event.error as { message?: string })?.message ?? 'Unknown error';
      events.push({ type: 'error', message: errorMsg });
    }

    return events;
  } catch {
    // Not valid JSON - skip
    return [];
  }
}

/**
 * Parse multi-line JSONL output into display events.
 * Splits on newlines and parses each line independently.
 */
export function parseJsonlOutputToDisplayEvents(data: string): AgentDisplayEvent[] {
  const allEvents: AgentDisplayEvent[] = [];
  for (const line of data.split('\n')) {
    const events = parseJsonlLineToDisplayEvents(line.trim());
    allEvents.push(...events);
  }
  return allEvents;
}
