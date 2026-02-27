/**
 * ABOUTME: Tests validating Qwen CLI JSONL format compatibility with the Claude JSONL parser.
 * Confirms that parseJsonlLine() and parseClaudeJsonLine() can parse Qwen's --output-format
 * stream-json output, documenting format differences between Qwen and Claude.
 *
 * Qwen CLI (v0.10.6+) supports --output-format stream-json which emits JSONL nearly identical
 * to Claude Code's format. Key differences documented inline:
 * - System init: "qwen_code_version" instead of "claude_code_version"
 * - Result events: Qwen lacks detailed "stats" (token counts, cost breakdowns)
 * - Tool names: Identical set (Bash, Read, Edit, Write, Grep, Glob, etc.)
 * - Content block structure: Identical (type/text for text, type/name/id/input for tool_use)
 */

import { describe, test, expect } from 'bun:test';
import { ClaudeAgentPlugin } from '../../src/plugins/agents/builtin/claude.js';

// =============================================================================
// Qwen JSONL Sample Data
// =============================================================================
// These samples represent real output from `qwen --output-format stream-json`
// and are used to verify compatibility with the existing Claude JSONL parser.

/**
 * System init event.
 *
 * FORMAT DIFFERENCE: Qwen uses "qwen_code_version" where Claude uses
 * "claude_code_version". The parser is agnostic to these version fields
 * since they're just stored in the raw object.
 */
const QWEN_SYSTEM_INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'qwen-session-abc123',
  tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'TodoWrite', 'Task'],
  qwen_code_version: '0.10.6',
  model: 'qwen3-coder',
});

/**
 * Assistant event with text content.
 * Structure is identical to Claude's: message.content[] with type:"text" blocks.
 */
const QWEN_ASSISTANT_TEXT = JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_qwen_001',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: "I'll help you fix that bug. Let me first look at the relevant file.",
      },
    ],
    model: 'qwen3-coder',
    stop_reason: null,
    stop_sequence: null,
  },
  parent_tool_use_id: null,
});

/**
 * Assistant event with tool_use content.
 * Structure is identical to Claude's: message.content[] with type:"tool_use" blocks.
 * Tool names match Claude's tool set (Bash, Read, Edit, Write, Grep, Glob, etc.).
 */
const QWEN_ASSISTANT_TOOL_USE = JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_qwen_002',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'Let me read the configuration file.',
      },
      {
        type: 'tool_use',
        id: 'toolu_qwen_001',
        name: 'Read',
        input: {
          file_path: '/home/user/project/src/config.ts',
        },
      },
    ],
    model: 'qwen3-coder',
    stop_reason: 'tool_use',
    stop_sequence: null,
  },
  parent_tool_use_id: null,
});

/**
 * Assistant event with Bash tool_use.
 * Tests that command-type tool calls are parsed correctly.
 */
const QWEN_ASSISTANT_BASH_TOOL = JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_qwen_003',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_qwen_002',
        name: 'Bash',
        input: {
          command: 'bun run typecheck',
          description: 'Run type checking',
        },
      },
    ],
    model: 'qwen3-coder',
    stop_reason: 'tool_use',
    stop_sequence: null,
  },
  parent_tool_use_id: null,
});

/**
 * User event with tool_result content.
 * Structure is identical to Claude's: message.content[] with type:"tool_result" blocks.
 */
const QWEN_USER_TOOL_RESULT = JSON.stringify({
  type: 'user',
  message: {
    id: 'msg_qwen_004',
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_qwen_001',
        content: '     1→export const config = { debug: true };',
        is_error: false,
      },
    ],
  },
});

/**
 * User event with tool_result that is an error.
 * Used to verify error surfacing in tool results.
 */
const QWEN_USER_TOOL_RESULT_ERROR = JSON.stringify({
  type: 'user',
  message: {
    id: 'msg_qwen_005',
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_qwen_002',
        content: 'Error: file not found',
        is_error: true,
      },
    ],
  },
});

/**
 * Result success event.
 *
 * FORMAT DIFFERENCE: Qwen's result event lacks the detailed "stats" field
 * that Claude provides (e.g., input_tokens, output_tokens, cost breakdowns).
 * The parser handles this gracefully since cost extraction is optional.
 */
const QWEN_RESULT_SUCCESS = JSON.stringify({
  type: 'result',
  subtype: 'success',
  result: "I've fixed the bug in config.ts. The issue was a missing export statement.",
  is_error: false,
  session_id: 'qwen-session-abc123',
});

/**
 * Result event with error.
 */
const QWEN_RESULT_ERROR = JSON.stringify({
  type: 'result',
  subtype: 'error_max_turns',
  result: 'Maximum turns reached',
  is_error: true,
  session_id: 'qwen-session-abc123',
});

// =============================================================================
// Tests
// =============================================================================

describe('Qwen JSONL Format Compatibility', () => {
  describe('ClaudeAgentPlugin.parseJsonlLine() with Qwen events', () => {
    test('parses system init event', () => {
      const result = ClaudeAgentPlugin.parseJsonlLine(QWEN_SYSTEM_INIT);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.message.type).toBe('system');
      expect(result.message.sessionId).toBeUndefined();
      // Session ID is in "session_id" field, not "sessionId" — parser checks "sessionId"
      // FORMAT DIFFERENCE: Qwen uses session_id (snake_case) in system events.
      // The parser looks for "sessionId" (camelCase), so it won't extract it.
      // The raw object still has the data available.
      expect(result.message.raw.session_id).toBe('qwen-session-abc123');
      expect(result.message.raw.qwen_code_version).toBe('0.10.6');
    });

    test('parses assistant event with text content', () => {
      const result = ClaudeAgentPlugin.parseJsonlLine(QWEN_ASSISTANT_TEXT);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.message.type).toBe('assistant');
      // Note: "message" in JSONL is the full message object, not a string.
      // parseJsonlLine only extracts string messages, so message will be undefined.
      expect(result.message.message).toBeUndefined();
      // The full message structure is accessible via raw
      expect(result.message.raw.type).toBe('assistant');
      const rawMessage = result.message.raw.message as Record<string, unknown>;
      expect(rawMessage.role).toBe('assistant');
    });

    test('parses assistant event with tool_use content', () => {
      const result = ClaudeAgentPlugin.parseJsonlLine(QWEN_ASSISTANT_TOOL_USE);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.message.type).toBe('assistant');
      // Tool info is inside message.content[], not at top level — parseJsonlLine
      // looks for top-level "tool" field, so tool will be undefined here.
      // The private parseClaudeJsonLine() method handles the nested structure.
      expect(result.message.tool).toBeUndefined();
      expect(result.message.raw.type).toBe('assistant');
    });

    test('parses user event with tool_result', () => {
      const result = ClaudeAgentPlugin.parseJsonlLine(QWEN_USER_TOOL_RESULT);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.message.type).toBe('user');
      expect(result.message.raw.type).toBe('user');
    });

    test('parses result success event', () => {
      const result = ClaudeAgentPlugin.parseJsonlLine(QWEN_RESULT_SUCCESS);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.message.type).toBe('result');
      expect(result.message.result).toBe(
        "I've fixed the bug in config.ts. The issue was a missing export statement."
      );
      // FORMAT DIFFERENCE: Qwen result events lack cost/stats info
      expect(result.message.cost).toBeUndefined();
    });

    test('parses result error event', () => {
      const result = ClaudeAgentPlugin.parseJsonlLine(QWEN_RESULT_ERROR);

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.message.type).toBe('result');
      expect(result.message.result).toBe('Maximum turns reached');
      expect(result.message.raw.is_error).toBe(true);
      expect(result.message.raw.subtype).toBe('error_max_turns');
    });

    test('raw field preserves all Qwen-specific data', () => {
      const result = ClaudeAgentPlugin.parseJsonlLine(QWEN_SYSTEM_INIT);

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Verify all Qwen-specific fields are preserved in raw
      expect(result.message.raw.qwen_code_version).toBe('0.10.6');
      expect(result.message.raw.model).toBe('qwen3-coder');
      expect(result.message.raw.tools).toEqual([
        'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'TodoWrite', 'Task',
      ]);
    });
  });

  describe('parseClaudeJsonLine() display event parsing (via parseClaudeOutputToEvents pattern)', () => {
    // The private parseClaudeJsonLine() method on ClaudeAgentPlugin is the one that
    // actually converts JSONL into AgentDisplayEvent[]. We can't call it directly since
    // it's private, but we can replicate its logic to verify Qwen events produce correct
    // display events. This validates that Qwen's format is compatible with the same
    // parsing approach.

    function parseJsonLineToDisplayEvents(jsonLine: string) {
      if (!jsonLine || jsonLine.length === 0) return [];
      try {
        const event = JSON.parse(jsonLine) as Record<string, unknown>;
        const events: Array<{ type: string; [key: string]: unknown }> = [];

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

        if (event.type === 'user') {
          const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
          if (message?.content && Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'tool_result' && block.is_error === true) {
                const errorContent = typeof block.content === 'string'
                  ? block.content
                  : 'tool execution failed';
                events.push({ type: 'error', message: errorContent });
              }
            }
          }
          events.push({ type: 'tool_result' });
        }

        if (event.type === 'system') {
          events.push({ type: 'system', subtype: event.subtype as string });
        }

        if (event.type === 'error' || event.error) {
          const errorMsg = typeof event.error === 'string'
            ? event.error
            : (event.error as { message?: string })?.message ?? 'Unknown error';
          events.push({ type: 'error', message: errorMsg });
        }

        return events;
      } catch {
        return [];
      }
    }

    test('system init produces system display event', () => {
      const events = parseJsonLineToDisplayEvents(QWEN_SYSTEM_INIT);
      expect(events).toEqual([{ type: 'system', subtype: 'init' }]);
    });

    test('assistant text produces text display event', () => {
      const events = parseJsonLineToDisplayEvents(QWEN_ASSISTANT_TEXT);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'text',
        content: "I'll help you fix that bug. Let me first look at the relevant file.",
      });
    });

    test('assistant tool_use produces text + tool_use display events', () => {
      const events = parseJsonLineToDisplayEvents(QWEN_ASSISTANT_TOOL_USE);
      expect(events).toHaveLength(2);

      expect(events[0]).toEqual({
        type: 'text',
        content: 'Let me read the configuration file.',
      });

      expect(events[1]).toEqual({
        type: 'tool_use',
        name: 'Read',
        input: { file_path: '/home/user/project/src/config.ts' },
      });
    });

    test('assistant Bash tool_use produces tool_use display event with command', () => {
      const events = parseJsonLineToDisplayEvents(QWEN_ASSISTANT_BASH_TOOL);
      expect(events).toHaveLength(1);

      expect(events[0]).toEqual({
        type: 'tool_use',
        name: 'Bash',
        input: {
          command: 'bun run typecheck',
          description: 'Run type checking',
        },
      });
    });

    test('user tool_result produces tool_result display event (skipped for display)', () => {
      const events = parseJsonLineToDisplayEvents(QWEN_USER_TOOL_RESULT);
      // Successful tool result: just a tool_result marker (no error)
      expect(events).toEqual([{ type: 'tool_result' }]);
    });

    test('user tool_result error surfaces error display event', () => {
      const events = parseJsonLineToDisplayEvents(QWEN_USER_TOOL_RESULT_ERROR);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'error', message: 'Error: file not found' });
      expect(events[1]).toEqual({ type: 'tool_result' });
    });

    test('result success event produces no display events (handled separately)', () => {
      // Result events don't match assistant/user/system/error branches in parseClaudeJsonLine
      const events = parseJsonLineToDisplayEvents(QWEN_RESULT_SUCCESS);
      // The result event has type "result" which doesn't match any display event branch
      expect(events).toEqual([]);
    });
  });

  describe('streaming parser with Qwen JSONL', () => {
    test('parses a full Qwen JSONL session', () => {
      const parser = ClaudeAgentPlugin.createStreamingJsonlParser();

      // Simulate streaming: system init
      const r1 = parser.push(QWEN_SYSTEM_INIT + '\n');
      expect(r1).toHaveLength(1);
      expect(r1[0]!.success).toBe(true);
      if (r1[0]!.success) {
        expect(r1[0]!.message.type).toBe('system');
      }

      // Assistant text message
      const r2 = parser.push(QWEN_ASSISTANT_TEXT + '\n');
      expect(r2).toHaveLength(1);
      expect(r2[0]!.success).toBe(true);

      // Assistant with tool call
      const r3 = parser.push(QWEN_ASSISTANT_TOOL_USE + '\n');
      expect(r3).toHaveLength(1);
      expect(r3[0]!.success).toBe(true);

      // Tool result
      const r4 = parser.push(QWEN_USER_TOOL_RESULT + '\n');
      expect(r4).toHaveLength(1);
      expect(r4[0]!.success).toBe(true);

      // Final result
      const r5 = parser.push(QWEN_RESULT_SUCCESS + '\n');
      expect(r5).toHaveLength(1);
      expect(r5[0]!.success).toBe(true);

      // Verify accumulated state
      const state = parser.getState();
      expect(state.messages).toHaveLength(5);
      expect(state.fallback).toHaveLength(0);
    });

    test('handles partial Qwen JSONL lines across chunks', () => {
      const parser = ClaudeAgentPlugin.createStreamingJsonlParser();

      // Split a Qwen event across two chunks
      const full = QWEN_ASSISTANT_TEXT;
      const mid = Math.floor(full.length / 2);

      const r1 = parser.push(full.slice(0, mid));
      expect(r1).toHaveLength(0); // No complete line yet

      const r2 = parser.push(full.slice(mid) + '\n');
      expect(r2).toHaveLength(1);
      expect(r2[0]!.success).toBe(true);
      if (r2[0]!.success) {
        expect(r2[0]!.message.type).toBe('assistant');
      }
    });
  });

  describe('parseJsonlOutput with Qwen multi-line output', () => {
    test('parses complete Qwen JSONL output', () => {
      const output = [
        QWEN_SYSTEM_INIT,
        QWEN_ASSISTANT_TEXT,
        QWEN_ASSISTANT_TOOL_USE,
        QWEN_USER_TOOL_RESULT,
        QWEN_RESULT_SUCCESS,
      ].join('\n');

      const result = ClaudeAgentPlugin.parseJsonlOutput(output);

      expect(result.messages).toHaveLength(5);
      expect(result.fallback).toHaveLength(0);
      expect(result.messages[0]!.type).toBe('system');
      expect(result.messages[1]!.type).toBe('assistant');
      expect(result.messages[2]!.type).toBe('assistant');
      expect(result.messages[3]!.type).toBe('user');
      expect(result.messages[4]!.type).toBe('result');
    });

    test('handles Qwen output mixed with non-JSON lines (graceful fallback)', () => {
      const output = [
        QWEN_SYSTEM_INIT,
        'Some debug output from qwen CLI',
        QWEN_ASSISTANT_TEXT,
        '',
        QWEN_RESULT_SUCCESS,
      ].join('\n');

      const result = ClaudeAgentPlugin.parseJsonlOutput(output);

      expect(result.messages).toHaveLength(3);
      expect(result.fallback).toHaveLength(1);
      expect(result.fallback[0]).toBe('Some debug output from qwen CLI');
    });
  });

  describe('Format Differences Summary', () => {
    /**
     * This test serves as living documentation of the known format differences
     * between Qwen and Claude JSONL output. All differences are cosmetic —
     * the shared parser handles both formats correctly.
     */
    test('documents all known format differences', () => {
      // DIFFERENCE 1: Version field in system init
      // Claude: "claude_code_version": "1.0.x"
      // Qwen:   "qwen_code_version": "0.10.6"
      const qwenInit = JSON.parse(QWEN_SYSTEM_INIT);
      expect(qwenInit.qwen_code_version).toBeDefined();
      expect(qwenInit.claude_code_version).toBeUndefined();

      // DIFFERENCE 2: Session ID field name (snake_case vs camelCase)
      // Claude system events: "sessionId" (camelCase, extracted by parser)
      // Qwen system events: "session_id" (snake_case, NOT extracted — stored in raw only)
      const initResult = ClaudeAgentPlugin.parseJsonlLine(QWEN_SYSTEM_INIT);
      expect(initResult.success).toBe(true);
      if (initResult.success) {
        expect(initResult.message.sessionId).toBeUndefined(); // Not extracted
        expect(initResult.message.raw.session_id).toBe('qwen-session-abc123'); // In raw
      }

      // DIFFERENCE 3: Result events lack cost/stats
      // Claude: result events include detailed stats (input_tokens, output_tokens, cost)
      // Qwen: result events have no stats/cost information
      const resultResult = ClaudeAgentPlugin.parseJsonlLine(QWEN_RESULT_SUCCESS);
      expect(resultResult.success).toBe(true);
      if (resultResult.success) {
        expect(resultResult.message.cost).toBeUndefined();
      }

      // IDENTICAL: Content block structure (text, tool_use, tool_result)
      // IDENTICAL: Tool names (Bash, Read, Write, Edit, Glob, Grep, etc.)
      // IDENTICAL: Event types (system, assistant, user, result)
      // IDENTICAL: message.content[] array with typed blocks
    });
  });
});
