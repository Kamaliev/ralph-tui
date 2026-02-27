/**
 * ABOUTME: Claude Code agent plugin for the claude CLI.
 * Integrates with Anthropic's Claude Code CLI for AI-assisted coding.
 * Supports: print mode execution, model selection, file context, timeout, graceful interruption,
 * and JSONL output parsing for subagent tracing.
 */

import { spawn } from 'node:child_process';
import { BaseAgentPlugin, findCommandPath, quoteForWindowsShell } from '../base.js';
import { processAgentEvents, processAgentEventsToSegments } from '../output-formatting.js';
import {
  parseJsonlLine,
  parseJsonlOutput,
  createStreamingJsonlParser,
  parseJsonlOutputToDisplayEvents,
  type JsonlMessage,
  type JsonlParseResult,
} from '../jsonl-parser.js';
import type {
  AgentPluginMeta,
  AgentPluginFactory,
  AgentFileContext,
  AgentExecuteOptions,
  AgentSetupQuestion,
  AgentDetectResult,
  AgentExecutionHandle,
} from '../types.js';

// Re-export shared types with backward-compatible aliases.
// Other modules import ClaudeJsonlMessage from this file — keep it working.
export type { JsonlParseResult } from '../jsonl-parser.js';
export type ClaudeJsonlMessage = JsonlMessage;

/**
 * Claude Code agent plugin implementation.
 * Uses the `claude` CLI to execute AI coding tasks.
 *
 * Key features:
 * - Auto-detects claude binary using `which`
 * - Executes in print mode (-p) for non-interactive use
 * - Supports --dangerously-skip-permissions for autonomous operation
 * - Configurable model selection via --model flag
 * - Timeout handling with graceful SIGINT before SIGTERM
 * - Streaming stdout/stderr capture
 */
export class ClaudeAgentPlugin extends BaseAgentPlugin {
  readonly meta: AgentPluginMeta = {
    id: 'claude',
    name: 'Claude Code',
    description: 'Anthropic Claude Code CLI for AI-assisted coding',
    version: '1.0.0',
    author: 'Anthropic',
    defaultCommand: 'claude',
    supportsStreaming: true,
    supportsInterrupt: true,
    supportsFileContext: true,
    supportsSubagentTracing: true,
    structuredOutputFormat: 'jsonl',
    skillsPaths: {
      personal: '~/.claude/skills',
      repo: '.claude/skills',
    },
    // NOTE: Claude CLI does not have a --cwd flag. It detects the project
    // based on where .claude/ directories exist and respects spawn's cwd
    // when there's no conflicting project detection.
  };

  /** Print mode: text, json, or stream-json */
  private printMode: 'text' | 'json' | 'stream' = 'text';

  /** Model to use (e.g., 'sonnet', 'opus', 'haiku') */
  private model?: string;

  /** Skip permission prompts for autonomous operation */
  private skipPermissions = true;

  /** Timeout in milliseconds (0 = no timeout) */
  protected override defaultTimeout = 0;

  override async initialize(config: Record<string, unknown>): Promise<void> {
    await super.initialize(config);

    if (
      typeof config.printMode === 'string' &&
      ['text', 'json', 'stream'].includes(config.printMode)
    ) {
      this.printMode = config.printMode as 'text' | 'json' | 'stream';
    }

    if (typeof config.model === 'string' && config.model.length > 0) {
      this.model = config.model;
    }

    if (typeof config.skipPermissions === 'boolean') {
      this.skipPermissions = config.skipPermissions;
    }

    if (typeof config.timeout === 'number' && config.timeout > 0) {
      this.defaultTimeout = config.timeout;
    }
  }

  /**
   * Detect claude CLI availability.
   * Uses platform-appropriate command (where on Windows, which on Unix).
   */
  override async detect(): Promise<AgentDetectResult> {
    const command = this.commandPath ?? this.meta.defaultCommand;

    // First, try to find the binary in PATH
    const findResult = await findCommandPath(command);

    if (!findResult.found) {
      return {
        available: false,
        error: `Claude CLI not found in PATH. Install with: npm install -g @anthropic-ai/claude-code`,
      };
    }

    // Store the resolved path for execute() to use
    this.commandPath = findResult.path;

    // Verify the binary works by running --version
    const versionResult = await this.runVersion(findResult.path);

    if (!versionResult.success) {
      return {
        available: false,
        executablePath: findResult.path,
        error: versionResult.error,
      };
    }

    return {
      available: true,
      version: versionResult.version,
      executablePath: findResult.path,
    };
  }

  override getSandboxRequirements() {
    return {
      authPaths: ['~/.claude', '~/.anthropic'],
      // Include both symlink location and actual binary location
      // Claude CLI installs as: ~/.local/bin/claude -> ~/.local/share/claude/versions/X.Y.Z
      binaryPaths: ['/usr/local/bin', '~/.local/bin', '~/.local/share/claude'],
      runtimePaths: ['~/.bun', '~/.nvm'],
      requiresNetwork: true,
    };
  }

  /**
   * Run --version to verify binary and extract version number
   */
  private runVersion(
    command: string
  ): Promise<{ success: boolean; version?: string; error?: string }> {
    return new Promise((resolve) => {
      const useShell = process.platform === 'win32';
      const proc = spawn(useShell ? quoteForWindowsShell(command) : command, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        resolve({
          success: false,
          error: `Failed to execute: ${error.message}`,
        });
      });

      proc.on('close', (code) => {
        if (code === 0) {
          // Extract version from output (e.g., "claude 1.0.5")
          const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);
          resolve({
            success: true,
            version: versionMatch?.[1],
          });
        } else {
          resolve({
            success: false,
            error: stderr || `Exited with code ${code}`,
          });
        }
      });

      // Timeout after 15 seconds
      setTimeout(() => {
        proc.kill();
        resolve({ success: false, error: 'Timeout waiting for --version' });
      }, 15000);
    });
  }

  override getSetupQuestions(): AgentSetupQuestion[] {
    const baseQuestions = super.getSetupQuestions();
    return [
      ...baseQuestions,
      {
        id: 'printMode',
        prompt: 'Output mode:',
        type: 'select',
        choices: [
          {
            value: 'text',
            label: 'Text',
            description: 'Plain text output (default)',
          },
          { value: 'json', label: 'JSON', description: 'Structured JSON output' },
          {
            value: 'stream',
            label: 'Stream',
            description: 'Streaming JSON for real-time feedback',
          },
        ],
        default: 'text',
        required: false,
        help: 'How Claude should output its responses',
      },
      {
        id: 'model',
        prompt: 'Model to use:',
        type: 'select',
        choices: [
          { value: '', label: 'Default', description: 'Use configured default model' },
          { value: 'sonnet', label: 'Sonnet', description: 'Claude Sonnet - balanced' },
          { value: 'opus', label: 'Opus', description: 'Claude Opus - most capable' },
          { value: 'haiku', label: 'Haiku', description: 'Claude Haiku - fastest' },
        ],
        default: '',
        required: false,
        help: 'Claude model variant to use for this agent',
      },
      {
        id: 'skipPermissions',
        prompt: 'Skip permission prompts?',
        type: 'boolean',
        default: true,
        required: false,
        help: 'Enable --dangerously-skip-permissions for autonomous operation',
      },
    ];
  }

  protected buildArgs(
    _prompt: string,
    files?: AgentFileContext[],
    options?: AgentExecuteOptions
  ): string[] {
    const args: string[] = [];

    // Add print mode flag for non-interactive output
    args.push('--print');

    // Add output format for structured JSONL streaming
    // Always use stream-json when we want structured output (subagentTracing or json/stream modes)
    // Note: 'json' format waits until the end - we always prefer 'stream-json' for live output
    // IMPORTANT: Claude CLI requires --verbose when using --print with --output-format=stream-json
    if (options?.subagentTracing || this.printMode === 'json' || this.printMode === 'stream') {
      args.push('--verbose');
      args.push('--output-format', 'stream-json');
    }
    // Default (printMode === 'text'): no --output-format flag, uses plain text streaming

    // Add model if specified (from config or passed in options)
    const modelToUse = this.model;
    if (modelToUse) {
      args.push('--model', modelToUse);
    }

    // Skip permission prompts for autonomous operation
    if (this.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    // Add file context if provided
    // Claude Code supports --add-dir for directory context
    if (files && files.length > 0) {
      const directories = new Set<string>();

      for (const file of files) {
        // Extract directory from file path for --add-dir
        const lastSlash = file.path.lastIndexOf('/');
        if (lastSlash > 0) {
          directories.add(file.path.substring(0, lastSlash));
        }
      }

      // Add unique directories
      for (const dir of directories) {
        args.push('--add-dir', dir);
      }
    }

    // NOTE: Prompt is NOT added here - it's passed via stdin to avoid
    // shell interpretation of special characters (markdown bullets, etc.)

    return args;
  }

  /**
   * Provide the prompt via stdin instead of command args.
   * This avoids shell interpretation issues with special characters in prompts.
   */
  protected override getStdinInput(
    prompt: string,
    _files?: AgentFileContext[],
    _options?: AgentExecuteOptions
  ): string {
    return prompt;
  }

  // JSONL display event parsing is delegated to the shared jsonl-parser module.
  // See parseJsonlLineToDisplayEvents() and parseJsonlOutputToDisplayEvents().

  /**
   * Override execute to parse Claude JSONL output for display.
   * Wraps the onStdout/onStdoutSegments callbacks to format tool calls and messages.
   */
  override execute(
    prompt: string,
    files?: AgentFileContext[],
    options?: AgentExecuteOptions
  ): AgentExecutionHandle {
    // Wrap callbacks to parse JSONL events when using stream-json output
    const isStreamingJson = options?.subagentTracing || this.printMode === 'json' || this.printMode === 'stream';

    // When skipPermissions is enabled, Claude Code requires IS_SANDBOX=1 in the
    // environment (particularly on Linux VMs running as root). Without it, Claude
    // exits with a non-zero code even if the prompt is valid.
    const sandboxEnv: Record<string, string> = {};
    if (this.skipPermissions) {
      sandboxEnv.IS_SANDBOX = '1';
    }

    const parsedOptions: AgentExecuteOptions = {
      ...options,
      env: { ...sandboxEnv, ...options?.env },
      // TUI-native segments callback (preferred)
      onStdoutSegments: options?.onStdoutSegments && isStreamingJson
        ? (/* original segments ignored - we parse from raw */) => {
            // This callback is set up but actual segments come from wrapping onStdout below
          }
        : options?.onStdoutSegments,
      // Legacy string callback or wrapper that calls both callbacks and JSONL message callback
      onStdout: isStreamingJson && (options?.onStdout || options?.onStdoutSegments || options?.onJsonlMessage)
        ? (data: string) => {
            // Parse each line for JSONL messages and display events
            for (const line of data.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              // Try to parse as JSON and call the raw JSONL message callback
              if (options?.onJsonlMessage) {
                try {
                  const rawJson = JSON.parse(trimmed) as Record<string, unknown>;
                  options.onJsonlMessage(rawJson);
                } catch {
                  // Not valid JSON, skip for JSONL callback
                }
              }
            }

            // Also parse for display events
            const events = parseJsonlOutputToDisplayEvents(data);
            if (events.length > 0) {
              // Call TUI-native segments callback if provided
              if (options?.onStdoutSegments) {
                const segments = processAgentEventsToSegments(events);
                if (segments.length > 0) {
                  options.onStdoutSegments(segments);
                }
              }
              // Also call legacy string callback if provided
              if (options?.onStdout) {
                const parsed = processAgentEvents(events);
                if (parsed.length > 0) {
                  options.onStdout(parsed);
                }
              }
            }
          }
        : options?.onStdout,
    };

    return super.execute(prompt, files, parsedOptions);
  }

  override async validateSetup(
    answers: Record<string, unknown>
  ): Promise<string | null> {
    // Validate print mode
    const printMode = answers.printMode;
    if (
      printMode !== undefined &&
      printMode !== '' &&
      !['text', 'json', 'stream'].includes(String(printMode))
    ) {
      return 'Invalid print mode. Must be one of: text, json, stream';
    }

    // Validate model if provided
    const model = answers.model;
    if (
      model !== undefined &&
      model !== '' &&
      !['sonnet', 'opus', 'haiku'].includes(String(model))
    ) {
      return 'Invalid model. Must be one of: sonnet, opus, haiku (or leave empty for default)';
    }

    return null;
  }

  /**
   * Valid model names for the Claude agent.
   */
  static readonly VALID_MODELS = ['sonnet', 'opus', 'haiku'] as const;

  /**
   * Validate a model name for the Claude agent.
   * @param model The model name to validate
   * @returns null if valid, error message if invalid
   */
  override validateModel(model: string): string | null {
    if (model === '' || model === undefined) {
      return null; // Empty is valid (uses default)
    }
    if (!ClaudeAgentPlugin.VALID_MODELS.includes(model as typeof ClaudeAgentPlugin.VALID_MODELS[number])) {
      return `Invalid model "${model}". Claude agent accepts: ${ClaudeAgentPlugin.VALID_MODELS.join(', ')}`;
    }
    return null;
  }

  /**
   * Get Claude-specific suggestions for preflight failures.
   * Provides actionable guidance for common configuration issues.
   */
  protected override getPreflightSuggestion(): string {
    return (
      'Common fixes for Claude Code:\n' +
      '  1. Test Claude Code directly: claude "hello"\n' +
      '  2. Verify your Anthropic API key: echo $ANTHROPIC_API_KEY\n' +
      '  3. Check Claude Code is installed: claude --version\n' +
      '  4. Try running: claude --print-system-prompt (should show system prompt)\n' +
      '  5. On Linux VMs (especially as root): ensure IS_SANDBOX=1 is set in the environment'
    );
  }

  /**
   * Parse a single line of JSONL output.
   * Delegates to the shared jsonl-parser module.
   * @see parseJsonlLine from '../jsonl-parser.js'
   */
  static parseJsonlLine(line: string): JsonlParseResult {
    return parseJsonlLine(line);
  }

  /**
   * Parse a complete JSONL output string.
   * Delegates to the shared jsonl-parser module.
   * @see parseJsonlOutput from '../jsonl-parser.js'
   */
  static parseJsonlOutput(output: string): {
    messages: ClaudeJsonlMessage[];
    fallback: string[];
  } {
    return parseJsonlOutput(output);
  }

  /**
   * Create a streaming JSONL parser that accumulates partial lines.
   * Delegates to the shared jsonl-parser module.
   * @see createStreamingJsonlParser from '../jsonl-parser.js'
   */
  static createStreamingJsonlParser(): {
    push: (chunk: string) => JsonlParseResult[];
    flush: () => JsonlParseResult[];
    getState: () => { messages: ClaudeJsonlMessage[]; fallback: string[] };
  } {
    return createStreamingJsonlParser();
  }
}

/**
 * Factory function for the Claude Code agent plugin.
 */
const createClaudeAgent: AgentPluginFactory = () => new ClaudeAgentPlugin();

export default createClaudeAgent;
