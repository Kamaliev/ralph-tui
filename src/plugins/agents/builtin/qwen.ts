/**
 * ABOUTME: QWEN CLI Coder agent plugin for Alibaba Cloud's Qwen command.
 * Integrates with QWEN CLI Coder for AI-assisted coding.
 * Supports: structured JSONL output parsing, stdin prompt, model selection,
 * skip-permissions (--yolo), and SIGINT interruption.
 */

import { spawn } from 'node:child_process';
import { BaseAgentPlugin, quoteForWindowsShell } from '../base.js';
import { processAgentEvents, processAgentEventsToSegments, type AgentDisplayEvent } from '../output-formatting.js';
import { parseJsonlOutputToDisplayEvents } from '../jsonl-parser.js';
import type {
  AgentPluginMeta,
  AgentPluginFactory,
  AgentFileContext,
  AgentExecuteOptions,
  AgentSetupQuestion,
  AgentDetectResult,
  AgentExecutionHandle,
} from '../types.js';

/**
 * Parse raw QWEN CLI text output into standardized display events.
 * Used as a fallback when lines are not valid JSONL (graceful degradation).
 * @internal Exported for testing only.
 */
export function parseQwenOutput(data: string): AgentDisplayEvent[] {
  if (!data || data.length === 0) return [];

  const events: AgentDisplayEvent[] = [];
  // Pass through all text as plain text events
  events.push({ type: 'text', content: data });
  return events;
}

/**
 * QWEN CLI Coder agent plugin implementation.
 * Uses the `qwen` CLI to execute AI coding tasks.
 * Parses text output into display events for the TUI.
 */
export class QwenAgentPlugin extends BaseAgentPlugin {
  readonly meta: AgentPluginMeta = {
    id: 'qwen',
    name: 'QWEN CLI Coder',
    description: 'Alibaba Cloud QWEN CLI Coder for AI-assisted coding',
    version: '1.0.0',
    author: 'Alibaba Cloud',
    defaultCommand: 'qwen',
    supportsStreaming: true,
    supportsInterrupt: true,
    supportsFileContext: false,
    supportsSubagentTracing: true,
    structuredOutputFormat: 'jsonl',
  };

  private model?: string;

  /** Skip permission prompts for autonomous operation */
  private skipPermissions = false;

  protected override defaultTimeout = 0;

  override async initialize(config: Record<string, unknown>): Promise<void> {
    await super.initialize(config);

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

  override async detect(): Promise<AgentDetectResult> {
    const resolvedCommand = await this.resolveCommandPath();

    if (!resolvedCommand) {
      return {
        available: false,
        error: this.getCommandNotFoundMessage(),
      };
    }

    const commandPath = resolvedCommand.executablePath;
    const versionResult = await this.runVersion(commandPath);

    if (!versionResult.success) {
      return {
        available: false,
        executablePath: commandPath,
        error: versionResult.error,
      };
    }

    // Store the detected path for use in execute()
    this.commandPath = commandPath;

    return {
      available: true,
      version: versionResult.version,
      executablePath: commandPath,
    };
  }

  protected override getCommandNotFoundMessage(): string {
    return 'QWEN CLI Coder not found in PATH. Install from: https://github.com/anthropics/qwen-coder-cli';
  }

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
      let settled = false;

      const safeResolve = (result: { success: boolean; version?: string; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        safeResolve({ success: false, error: `Failed to execute: ${error.message}` });
      });

      proc.on('close', (code) => {
        if (code === 0) {
          const versionMatch = stdout.match(/(\d+\.\d+\.\d+)/);
          if (!versionMatch?.[1]) {
            safeResolve({
              success: false,
              error: `Unable to parse QWEN CLI version output: ${stdout}`,
            });
            return;
          }
          safeResolve({ success: true, version: versionMatch[1] });
        } else {
          safeResolve({ success: false, error: stderr || `Exited with code ${code}` });
        }
      });

      const timer = setTimeout(() => {
        proc.kill();
        safeResolve({ success: false, error: 'Timeout waiting for --version' });
      }, 15000);
    });
  }

  override getSetupQuestions(): AgentSetupQuestion[] {
    return [
      ...super.getSetupQuestions(),
      {
        id: 'model',
        prompt: 'Model to use:',
        type: 'select',
        choices: [
          { value: '', label: 'Default', description: 'Use configured default model' },
          { value: 'qwen3-coder', label: 'Qwen3 Coder', description: 'Standard coder model' },
          { value: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', description: 'Enhanced coder model' },
        ],
        default: '',
        required: false,
        help: 'QWEN Coder model to use',
      },
      {
        id: 'skipPermissions',
        prompt: 'Skip permission prompts?',
        type: 'boolean',
        default: false,
        required: false,
        help: 'Enable --yolo for autonomous operation (skip interactive approval prompts)',
      },
    ];
  }

  protected buildArgs(
    _prompt: string,
    _files?: AgentFileContext[],
    _options?: AgentExecuteOptions
  ): string[] {
    const args: string[] = [];

    // Model selection
    if (this.model) {
      args.push('-m', this.model);
    }

    // Structured JSONL streaming output for tool call visibility
    args.push('--output-format', 'stream-json');

    // Skip permission prompts for autonomous operation
    if (this.skipPermissions) {
      args.push('--yolo');
    }

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

  /**
   * Override execute to parse QWEN JSONL output into structured display events.
   * Wraps onStdout/onStdoutSegments callbacks to parse JSONL lines and emit
   * AgentDisplayEvent[] through processAgentEventsToSegments().
   *
   * Non-JSON lines are treated as plain text (graceful fallback).
   */
  override execute(
    prompt: string,
    files?: AgentFileContext[],
    options?: AgentExecuteOptions
  ): AgentExecutionHandle {
    const parsedOptions: AgentExecuteOptions = {
      ...options,
      // TUI-native segments callback (preferred) — set up as no-op since
      // actual segments come from the onStdout wrapper below
      onStdoutSegments: options?.onStdoutSegments
        ? () => { /* segments emitted from onStdout wrapper */ }
        : undefined,
      // Main parsing wrapper: parse JSONL lines into display events
      onStdout: (options?.onStdout || options?.onStdoutSegments || options?.onJsonlMessage)
        ? (data: string) => {
            // Forward raw JSONL messages to the callback if provided
            if (options?.onJsonlMessage) {
              for (const line of data.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                  const rawJson = JSON.parse(trimmed) as Record<string, unknown>;
                  options.onJsonlMessage(rawJson);
                } catch {
                  // Not valid JSON, skip for JSONL callback
                }
              }
            }

            // Parse JSONL lines into display events (handles both JSON and plain text fallback)
            const events = parseJsonlOutputToDisplayEvents(data);

            // Fallback: if no structured events were extracted, treat raw data as plain text
            if (events.length === 0 && data.trim()) {
              const fallbackEvents = parseQwenOutput(data);
              if (fallbackEvents.length > 0) {
                if (options?.onStdoutSegments) {
                  const segments = processAgentEventsToSegments(fallbackEvents);
                  if (segments.length > 0) {
                    options.onStdoutSegments(segments);
                  }
                }
                if (options?.onStdout) {
                  const formatted = processAgentEvents(fallbackEvents);
                  if (formatted.length > 0) {
                    options.onStdout(formatted);
                  }
                }
              }
              return;
            }

            if (events.length > 0) {
              if (options?.onStdoutSegments) {
                const segments = processAgentEventsToSegments(events);
                if (segments.length > 0) {
                  options.onStdoutSegments(segments);
                }
              }
              if (options?.onStdout) {
                const formatted = processAgentEvents(events);
                if (formatted.length > 0) {
                  options.onStdout(formatted);
                }
              }
            }
          }
        : undefined,
    };

    return super.execute(prompt, files, parsedOptions);
  }

  override async validateSetup(answers: Record<string, unknown>): Promise<string | null> {
    const model = answers.model;
    if (model !== undefined && model !== '' && typeof model === 'string') {
      const err = this.validateModel(model);
      if (err) return err;
    }
    return null;
  }

  override validateModel(model: string): string | null {
    if (model === '' || model === undefined) {
      return null;
    }
    if (!model.startsWith('qwen')) {
      return `Invalid model "${model}". QWEN models start with "qwen"`;
    }
    return null;
  }
}

const createQwenAgent: AgentPluginFactory = () => new QwenAgentPlugin();

export default createQwenAgent;
