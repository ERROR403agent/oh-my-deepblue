import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { HookInput } from "../hooks/bridge.js";
import { getGitBranch } from "../hud/elements/git.js";
import { resolveToWorktreeRoot, ensureSessionStateDir, getOmcRoot } from "../lib/worktree-paths.js";
import { readLastToolError, type ToolErrorState } from "../hooks/persistent-mode/index.js";
import type { OpenClawContext, OpenClawNativeEventName } from "./types.js";
import { extractIssueNumber, extractPrInfo, isPrCreateCommand, isTestCommand } from "./native-events.js";

interface EmissionGateState {
  keys?: Record<string, string>;
}

const GATE_TTLS_MS: Partial<Record<OpenClawNativeEventName, number>> = {
  started: 5 * 60 * 1000,
  blocked: 30 * 1000,
  finished: 5 * 60 * 1000,
  failed: 5 * 60 * 1000,
  "retry-needed": 30 * 1000,
  "pr-created": 5 * 60 * 1000,
  "test-started": 60 * 1000,
  "test-finished": 5 * 60 * 1000,
  "test-failed": 5 * 60 * 1000,
  "handoff-needed": 60 * 1000,
};

function getGatePath(projectPath?: string, sessionId?: string): string {
  const directory = resolveToWorktreeRoot(projectPath);
  if (sessionId) {
    return join(ensureSessionStateDir(sessionId, directory), "openclaw-bridge-events.json");
  }
  return join(getOmcRoot(directory), "state", "openclaw-bridge-events.json");
}

function readGate(path: string): EmissionGateState {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8")) as EmissionGateState;
  } catch {
    return {};
  }
}

function writeGate(path: string, state: EmissionGateState): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // best effort only
  }
}

function shouldAllowEvent(name: OpenClawNativeEventName, dedupeKey: string, projectPath?: string, sessionId?: string): boolean {
  const ttl = GATE_TTLS_MS[name] ?? 60_000;
  const nowIso = new Date().toISOString();
  const now = Date.parse(nowIso);
  const path = getGatePath(projectPath, sessionId);
  const state = readGate(path);
  const nextKeys: Record<string, string> = {};

  for (const [key, emittedAt] of Object.entries(state.keys ?? {})) {
    const parsed = Date.parse(emittedAt);
    if (!Number.isFinite(parsed)) continue;
    if (now - parsed <= 10 * 60 * 1000) {
      nextKeys[key] = emittedAt;
    }
  }

  const seenAt = nextKeys[dedupeKey];
  if (seenAt) {
    const parsed = Date.parse(seenAt);
    if (Number.isFinite(parsed) && now - parsed < ttl) {
      return false;
    }
  }

  nextKeys[dedupeKey] = nowIso;
  writeGate(path, { keys: nextKeys });
  return true;
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getCommand(input: HookInput): string | undefined {
  const toolInput = input.toolInput as Record<string, unknown> | undefined;
  return toStringValue(toolInput?.command);
}

function buildBaseContext(input: HookInput): OpenClawContext {
  const projectPath = resolveToWorktreeRoot(input.directory);
  const command = getCommand(input);
  const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
  const issueNumber = extractIssueNumber(prompt, command);
  const { prUrl, prNumber } = extractPrInfo(command, typeof input.toolOutput === "string" ? input.toolOutput : undefined);

  return {
    sessionId: input.sessionId,
    projectPath,
    repoRoot: projectPath,
    worktreePath: projectPath,
    sessionName: undefined,
    branch: getGitBranch(projectPath) ?? undefined,
    prompt,
    toolName: input.toolName,
    command,
    issueNumber,
    prNumber,
    prUrl,
    contextSummary: typeof input.toolOutput === "string" ? input.toolOutput.slice(0, 500) : undefined,
  };
}

function dedupeKey(name: OpenClawNativeEventName, context: OpenClawContext): string {
  return JSON.stringify({
    name,
    sessionId: context.sessionId,
    toolName: context.toolName,
    command: context.command,
    reason: context.reason,
    question: context.question,
    errorSummary: context.errorSummary,
    retryCount: context.retryCount,
    prNumber: context.prNumber,
  });
}

function pushEvent(target: Array<{ name: OpenClawNativeEventName; context: OpenClawContext }>, name: OpenClawNativeEventName, context: OpenClawContext): void {
  const key = dedupeKey(name, context);
  if (!shouldAllowEvent(name, key, context.projectPath, context.sessionId)) return;
  target.push({ name, context: { ...context, nativeEventName: name } });
}

export function inferNativeEventsForSessionStart(input: HookInput): Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> {
  const context = buildBaseContext(input);
  const events: Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> = [];
  pushEvent(events, "started", {
    ...context,
    sessionName: input.sessionId,
  });
  return events;
}

export function inferNativeEventsForAskUserQuestion(input: HookInput): Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> {
  const context = buildBaseContext(input);
  if (input.toolName !== "AskUserQuestion") return [];
  const questions = ((input.toolInput as { questions?: Array<{ question?: string }> } | undefined)?.questions ?? [])
    .map((entry) => toStringValue(entry.question))
    .filter(Boolean) as string[];
  const question = questions.join("; ") || "User input required";
  const events: Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> = [];
  pushEvent(events, "handoff-needed", {
    ...context,
    question,
    reason: "ask-user-question",
  });
  return events;
}

export function inferNativeEventsForPreToolUse(input: HookInput): Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> {
  const context = buildBaseContext(input);
  const events: Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> = [];
  if (isTestCommand(context.command)) {
    pushEvent(events, "test-started", context);
  }
  return events;
}

function getStatusValue(input: HookInput): string | undefined {
  const obj = input.toolOutput && typeof input.toolOutput === "object"
    ? input.toolOutput as Record<string, unknown>
    : input as unknown as Record<string, unknown>;
  return toStringValue(obj.status) ?? toStringValue(obj.result);
}

function getErrorSummaryFromOutput(input: HookInput): string | undefined {
  const outputObj = input.toolOutput && typeof input.toolOutput === "object"
    ? input.toolOutput as Record<string, unknown>
    : undefined;
  return toStringValue(outputObj?.error)
    ?? toStringValue(outputObj?.message)
    ?? (typeof input.toolOutput === "string" && /error|failed/i.test(input.toolOutput)
      ? input.toolOutput.slice(0, 500)
      : undefined);
}

export function inferNativeEventsForPostToolUse(input: HookInput): Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> {
  const context = buildBaseContext(input);
  const events: Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> = [];
  const command = context.command;
  const status = (getStatusValue(input) ?? "").toLowerCase();
  const errorSummary = getErrorSummaryFromOutput(input);

  if (isPrCreateCommand(command)) {
    const prInfo = extractPrInfo(command, typeof input.toolOutput === "string" ? input.toolOutput : undefined, context.prUrl, context.prNumber);
    pushEvent(events, "pr-created", {
      ...context,
      prNumber: prInfo.prNumber ?? context.prNumber,
      prUrl: prInfo.prUrl ?? context.prUrl,
      reason: "pr-created",
    });
  }

  if (isTestCommand(command)) {
    if (status === "failed" || errorSummary) {
      pushEvent(events, "test-failed", {
        ...context,
        errorSummary,
        reason: "test-failed",
      });
    } else {
      pushEvent(events, "test-finished", {
        ...context,
        reason: "test-finished",
      });
    }
  }

  return events;
}

export function inferNativeEventsForStop(
  input: HookInput,
  result: { mode: string; metadata?: { toolError?: ToolErrorState } },
): Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> {
  const context = buildBaseContext(input);
  const events: Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> = [];
  const stopContext = input as unknown as Record<string, unknown>;
  const stopReason = toStringValue(stopContext.stop_reason) ?? toStringValue(stopContext.stopReason);
  const toolError = result.metadata?.toolError ?? (context.projectPath ? readLastToolError(context.projectPath) : null);

  if (toolError) {
    pushEvent(events, "retry-needed", {
      ...context,
      toolName: toolError.tool_name,
      errorSummary: toolError.error,
      retryCount: toolError.retry_count,
      reason: stopReason ?? result.mode,
    });
  }

  if (result.mode !== "none") {
    pushEvent(events, "blocked", {
      ...context,
      reason: stopReason ?? result.mode,
      errorSummary: toolError?.error,
      retryCount: toolError?.retry_count,
    });
  }

  return events;
}

export function inferNativeEventsForSessionEnd(input: { sessionId: string; projectPath: string; reason?: string }): Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> {
  const projectPath = resolveToWorktreeRoot(input.projectPath);
  const context: OpenClawContext = {
    sessionId: input.sessionId,
    projectPath,
    repoRoot: projectPath,
    worktreePath: projectPath,
    branch: getGitBranch(projectPath) ?? undefined,
    sessionName: input.sessionId,
    reason: input.reason,
  };
  const name: OpenClawNativeEventName = input.reason === "logout" ? "failed" : "finished";
  const events: Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> = [];
  pushEvent(events, name, context);
  return events;
}

export function inferNativeEventsForToolFailure(input: {
  sessionId?: string;
  directory?: string;
  toolName?: string;
  command?: string;
  error?: string;
  retryCount?: number;
  prompt?: string;
}): Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> {
  const projectPath = resolveToWorktreeRoot(input.directory);
  const context: OpenClawContext = {
    sessionId: input.sessionId,
    projectPath,
    repoRoot: projectPath,
    worktreePath: projectPath,
    branch: getGitBranch(projectPath) ?? undefined,
    toolName: input.toolName,
    command: input.command,
    errorSummary: input.error,
    retryCount: input.retryCount,
    prompt: input.prompt,
    issueNumber: extractIssueNumber(input.prompt, input.command),
  };

  const events: Array<{ name: OpenClawNativeEventName; context: OpenClawContext }> = [];
  pushEvent(events, "failed", {
    ...context,
    reason: "tool-failure",
  });
  pushEvent(events, "retry-needed", {
    ...context,
    reason: "tool-failure",
  });
  if (isTestCommand(input.command)) {
    pushEvent(events, "test-failed", {
      ...context,
      reason: "tool-failure",
    });
  }
  return events;
}
