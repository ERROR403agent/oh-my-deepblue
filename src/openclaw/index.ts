/**
 * OpenClaw Integration - Public API
 *
 * Wakes OpenClaw gateways on hook events. Non-blocking, fire-and-forget.
 *
 * Usage (from bridge.ts via _openclaw wrapper):
 *   _openclaw.wake("session-start", { sessionId, projectPath: directory });
 */

export type {
  OpenClawCommandGatewayConfig,
  OpenClawConfig,
  OpenClawContext,
  OpenClawEventName,
  OpenClawGatewayConfig,
  OpenClawHookEvent,
  OpenClawHookMapping,
  OpenClawHttpGatewayConfig,
  OpenClawNativeEvent,
  OpenClawNativeEventName,
  OpenClawPayload,
  OpenClawResult,
} from "./types.js";

export { getOpenClawConfig, resolveGateway, resetOpenClawConfigCache } from "./config.js";
export { wakeGateway, wakeCommandGateway, interpolateInstruction, isCommandGateway, shellEscapeArg } from "./dispatcher.js";
export {
  buildNativeEvent,
  extractIssueNumber,
  extractPrInfo,
  getNativeEventFallback,
  getNativeEventFallbacks,
  isNativeEventName,
  isOpenClawNativeEventName,
  isPrCreateCommand,
  isTestCommand,
  shouldEmitNativeEvent,
} from "./native-events.js";

import type { OpenClawEventName, OpenClawHookEvent, OpenClawContext, OpenClawResult } from "./types.js";
import { getOpenClawConfig, resolveGateway } from "./config.js";
import { wakeGateway, wakeCommandGateway, interpolateInstruction, isCommandGateway } from "./dispatcher.js";
import { basename } from "path";
import { getCurrentTmuxSession } from "../notifications/tmux.js";
import { buildNativeEvent, isOpenClawNativeEventName, shouldEmitNativeEvent } from "./native-events.js";

/** Whether debug logging is enabled */
const DEBUG = process.env.OMC_OPENCLAW_DEBUG === "1";

/**
 * Build a whitelisted context object from the input context.
 * Only known fields are included to prevent accidental data leakage.
 */
function buildWhitelistedContext(context: OpenClawContext): OpenClawContext {
  const result: OpenClawContext = {};
  if (context.sessionId !== undefined) result.sessionId = context.sessionId;
  if (context.sessionName !== undefined) result.sessionName = context.sessionName;
  if (context.projectPath !== undefined) result.projectPath = context.projectPath;
  if (context.repoRoot !== undefined) result.repoRoot = context.repoRoot;
  if (context.worktreePath !== undefined) result.worktreePath = context.worktreePath;
  if (context.branch !== undefined) result.branch = context.branch;
  if (context.issueNumber !== undefined) result.issueNumber = context.issueNumber;
  if (context.prNumber !== undefined) result.prNumber = context.prNumber;
  if (context.prUrl !== undefined) result.prUrl = context.prUrl;
  if (context.tmuxSession !== undefined) result.tmuxSession = context.tmuxSession;
  if (context.toolName !== undefined) result.toolName = context.toolName;
  if (context.command !== undefined) result.command = context.command;
  if (context.prompt !== undefined) result.prompt = context.prompt;
  if (context.contextSummary !== undefined) result.contextSummary = context.contextSummary;
  if (context.reason !== undefined) result.reason = context.reason;
  if (context.question !== undefined) result.question = context.question;
  if (context.errorSummary !== undefined) result.errorSummary = context.errorSummary;
  if (context.retryCount !== undefined) result.retryCount = context.retryCount;
  if (context.nativeEventName !== undefined) result.nativeEventName = context.nativeEventName;
  if (context.tmuxTail !== undefined) result.tmuxTail = context.tmuxTail;
  if (context.replyChannel !== undefined) result.replyChannel = context.replyChannel;
  if (context.replyTarget !== undefined) result.replyTarget = context.replyTarget;
  if (context.replyThread !== undefined) result.replyThread = context.replyThread;
  return result;
}

/**
 * Wake the OpenClaw gateway mapped to a hook event.
 *
 * This is the main entry point called from the hook bridge via _openclaw.wake().
 * Non-blocking, swallows all errors. Returns null if OpenClaw
 * is not configured or the event is not mapped.
 *
 * @param event - The hook event type
 * @param context - Context data for template variable interpolation
 * @returns OpenClawResult or null if not configured/mapped
 */
export async function wakeOpenClaw(
  event: OpenClawEventName,
  context: OpenClawContext,
): Promise<OpenClawResult | null> {
  try {
    const config = getOpenClawConfig();
    if (!config) return null;

    const resolved = resolveGateway(config, event);
    if (!resolved) return null;

    const { gatewayName, gateway, instruction, resolvedEvent } = resolved;

    // Single timestamp for both template variables and payload
    const now = new Date().toISOString();

    // Auto-detect tmux session if not provided in context
    const tmuxSession = context.tmuxSession ?? getCurrentTmuxSession() ?? undefined;

    // Auto-capture tmux pane content for stop/session-end events (best-effort)
    let tmuxTail = context.tmuxTail;
    if (!tmuxTail && (event === "stop" || event === "session-end") && process.env.TMUX) {
      try {
        const { capturePaneContent } = await import("../features/rate-limit-wait/tmux-detector.js");
        const paneId = process.env.TMUX_PANE;
        if (paneId) {
          tmuxTail = capturePaneContent(paneId, 15) ?? undefined;
        }
      } catch {
        // Non-blocking: tmux capture is best-effort
      }
    }

    // Read reply channel context from environment variables
    const replyChannel = context.replyChannel ?? process.env.OPENCLAW_REPLY_CHANNEL ?? undefined;
    const replyTarget = context.replyTarget ?? process.env.OPENCLAW_REPLY_TARGET ?? undefined;
    const replyThread = context.replyThread ?? process.env.OPENCLAW_REPLY_THREAD ?? undefined;

    const nativeEventName = isOpenClawNativeEventName(event)
      ? event
      : context.nativeEventName;

    // Enrich context with reply channel from env vars
    const enrichedContext: OpenClawContext = {
      ...context,
      ...(nativeEventName ? { nativeEventName } : {}),
      ...(replyChannel && { replyChannel }),
      ...(replyTarget && { replyTarget }),
      ...(replyThread && { replyThread }),
    };

    const legacyEvent = resolvedEvent !== event && resolvedEvent !== "native-event"
      ? resolvedEvent as OpenClawHookEvent
      : (!isOpenClawNativeEventName(event) ? event as OpenClawHookEvent : undefined);

    const nativeEvent = nativeEventName
      ? buildNativeEvent(nativeEventName, enrichedContext, now, legacyEvent)
      : undefined;
    if (nativeEvent && !shouldEmitNativeEvent(nativeEvent, enrichedContext)) {
      return null;
    }

    const payloadEvent: OpenClawEventName =
      isOpenClawNativeEventName(event) && resolvedEvent !== event && resolvedEvent !== "native-event"
        ? resolvedEvent
        : event;

    // Build template variables from whitelisted context fields
    const variables: Record<string, string | undefined> = {
      sessionId: context.sessionId,
      sessionName: nativeEvent?.session.name ?? context.sessionName,
      projectPath: context.projectPath,
      projectName: nativeEvent?.repo.projectName ?? (context.projectPath ? basename(context.projectPath) : undefined),
      repoRoot: nativeEvent?.repo.repoRoot ?? context.repoRoot,
      worktreePath: nativeEvent?.repo.worktreePath ?? context.worktreePath,
      branch: nativeEvent?.repo.branch ?? context.branch,
      issueNumber: nativeEvent?.repo.issueNumber !== undefined
        ? String(nativeEvent.repo.issueNumber)
        : (context.issueNumber !== undefined ? String(context.issueNumber) : undefined),
      prNumber: nativeEvent?.repo.prNumber !== undefined
        ? String(nativeEvent.repo.prNumber)
        : (context.prNumber !== undefined ? String(context.prNumber) : undefined),
      prUrl: nativeEvent?.repo.prUrl ?? context.prUrl,
      tmuxSession,
      toolName: nativeEvent?.tool?.name ?? context.toolName,
      command: nativeEvent?.tool?.command ?? context.command,
      prompt: context.prompt,
      contextSummary: context.contextSummary,
      reason: nativeEvent?.reason ?? context.reason,
      question: context.question,
      errorSummary: nativeEvent?.error?.summary ?? context.errorSummary,
      retryCount: nativeEvent?.error?.retryCount !== undefined
        ? String(nativeEvent.error.retryCount)
        : (context.retryCount !== undefined ? String(context.retryCount) : undefined),
      nativeEvent: nativeEventName,
      tmuxTail,
      event: payloadEvent,
      timestamp: now,
      replyChannel,
      replyTarget,
      replyThread,
    };

    // Add interpolated instruction to variables for command gateway {{instruction}} placeholder
    const interpolatedInstruction = interpolateInstruction(instruction, variables);
    variables.instruction = interpolatedInstruction;

    let result: OpenClawResult;

    if (isCommandGateway(gateway)) {
      // Command gateway: execute shell command with shell-escaped variables
      result = await wakeCommandGateway(gatewayName, gateway, variables);
    } else {
      // HTTP gateway: send JSON payload
      const payload = {
        event: payloadEvent,
        schema: "omc.openclaw-event" as const,
        schemaVersion: 1 as const,
        source: "omc" as const,
        instruction: interpolatedInstruction,
        timestamp: now,
        ...(nativeEvent ? { nativeEvent } : {}),
        sessionId: context.sessionId,
        projectPath: context.projectPath,
        projectName: nativeEvent?.repo.projectName ?? (context.projectPath ? basename(context.projectPath) : undefined),
        sessionName: nativeEvent?.session.name ?? context.sessionName,
        repoRoot: nativeEvent?.repo.repoRoot ?? context.repoRoot,
        worktreePath: nativeEvent?.repo.worktreePath ?? context.worktreePath,
        branch: nativeEvent?.repo.branch ?? context.branch,
        issueNumber: nativeEvent?.repo.issueNumber ?? context.issueNumber,
        prNumber: nativeEvent?.repo.prNumber ?? context.prNumber,
        prUrl: nativeEvent?.repo.prUrl ?? context.prUrl,
        command: nativeEvent?.tool?.command ?? context.command,
        errorSummary: nativeEvent?.error?.summary ?? context.errorSummary,
        retryCount: nativeEvent?.error?.retryCount ?? context.retryCount,
        tmuxSession,
        tmuxTail,
        ...(replyChannel && { channel: replyChannel }),
        ...(replyTarget && { to: replyTarget }),
        ...(replyThread && { threadId: replyThread }),
        context: buildWhitelistedContext(enrichedContext),
      };
      result = await wakeGateway(gatewayName, gateway, payload);
    }

    if (DEBUG) {
      console.error(`[openclaw] wake ${event} -> ${gatewayName}: ${result.success ? "ok" : result.error}`);
    }

    return result;
  } catch (error) {
    // Never let OpenClaw failures propagate to hooks
    if (DEBUG) {
      console.error(`[openclaw] wakeOpenClaw error:`, error instanceof Error ? error.message : error);
    }
    return null;
  }
}
