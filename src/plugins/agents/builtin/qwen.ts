/**
 * ABOUTME: QWEN CLI Coder agent plugin for Alibaba Cloud's Qwen command.
 * Integrates with QWEN CLI Coder for AI-assisted coding.
 * Supports: text output parsing, stdin prompt, model selection, SIGINT interruption.
 */

import { spawn } from 'node:child_process';
import { BaseAgentPlugin, quoteForWindowsShell } from '../base.js';
import { processAgentEvents, processAgentEventsToSegments, type AgentDisplayEvent } from '../output-formatting.js';
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
 * Since QWEN CLI does not emit structured JSON, all output is treated as plain text.
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
    supportsSubagentTracing: false,
  };

  private model?: string;
  protected override defaultTimeout = 0;

  override async initialize(config: Record<string, unknown>): Promise<void> {
    await super.initialize(config);

    if (typeof config.model === 'string' && config.model.length > 0) {
      this.model = config.model;
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
   * Override execute to parse QWEN text output into display events.
   * Wraps onStdout/onStdoutSegments callbacks to parse text and buffer partial lines.
   */
  override execute(
    prompt: string,
    files?: AgentFileContext[],
    options?: AgentExecuteOptions
  ): AgentExecutionHandle {
    // Buffer for incomplete lines split across chunks
    let textBuffer = '';

    // Helper to flush remaining buffer content
    const flushBuffer = () => {
      if (!textBuffer) return;

      const events = parseQwenOutput(textBuffer);
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

      textBuffer = '';
    };

    // Wrap callbacks to parse text output
    const parsedOptions: AgentExecuteOptions = {
      ...options,
      onStdout: (options?.onStdout || options?.onStdoutSegments)
        ? (data: string) => {
            const combined = textBuffer + data;
            const lines = combined.split('\n');

            // If data doesn't end with newline, last line is incomplete - buffer it
            if (!data.endsWith('\n')) {
              textBuffer = lines.pop() || '';
            } else {
              textBuffer = '';
            }

            const completeData = lines.join('\n');
            if (!completeData) return;

            const events = parseQwenOutput(completeData);
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
      onEnd: (result) => {
        flushBuffer();
        options?.onEnd?.(result);
      },
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
