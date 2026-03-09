import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { getGitBranch, getGitRepoName } from "../hud/elements/git.js";
import { ensureSessionStateDir, getOmcRoot, getWorktreeRoot, resolveToWorktreeRoot } from "../lib/worktree-paths.js";
import { getCurrentTmuxSession } from "../notifications/tmux.js";
import type {
  OpenClawContext,
  OpenClawEventName,
  OpenClawHookEvent,
  OpenClawNativeEvent,
  OpenClawNativeEventMapping,
  OpenClawNativeEventName,
} from "./types.js";

const NATIVE_EVENT_MAPPING: OpenClawNativeEventMapping = "native-event";
const TEST_COMMAND_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i,
  /\bnpx\s+(?:vitest|jest)\b/i,
  /\b(?:vitest|jest|mocha|pytest)\b/i,
  /\b(?:cargo|go)\s+test\b/i,
  /\bmake\s+test\b/i,
];
const PR_CREATE_PATTERNS = [
  /\bgh\s+pr\s+create\b/i,
  /\bglab\s+mr\s+create\b/i,
  /\bgit\s+push\b.*\b(?:pull\/|merge_requests\/|pull-requests\/)\b/i,
];
const PR_URL_PATTERNS = [
  /https?:\/\/[^\s/]+\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/i,
  /https?:\/\/[^\s/]+\/[^/\s]+\/[^/\s]+\/merge_requests\/(\d+)/i,
  /https?:\/\/[^\s/]+\/[^/\s]+\/[^/\s]+\/pull-requests\/(\d+)/i,
];
const ISSUE_NUMBER_PATTERNS = [/(?:^|\s)#(\d+)(?:\b|$)/, /\bissue\s+#?(\d+)\b/i];
const EVENT_DEDUPE_TTL_MS: Record<OpenClawNativeEventName, number> = {
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

interface NativeEventCacheEntry {
  emittedAt: string;
}

interface NativeEventCache {
  events?: Record<string, NativeEventCacheEntry>;
}

export function isNativeEventName(event: OpenClawEventName): event is OpenClawNativeEventName {
  return event !== NATIVE_EVENT_MAPPING
    && event !== "session-start"
    && event !== "session-end"
    && event !== "pre-tool-use"
    && event !== "post-tool-use"
    && event !== "stop"
    && event !== "keyword-detector"
    && event !== "ask-user-question";
}

export const isOpenClawNativeEventName = isNativeEventName;

export function getNativeEventFallbacks(event: OpenClawNativeEventName): OpenClawHookEvent[] {
  switch (event) {
    case "started":
      return ["session-start"];
    case "finished":
    case "failed":
      return ["session-end"];
    case "blocked":
    case "retry-needed":
      return ["stop"];
    case "handoff-needed":
      return ["ask-user-question", "stop"];
    case "test-started":
      return ["pre-tool-use", "post-tool-use"];
    case "test-finished":
    case "test-failed":
    case "pr-created":
      return ["post-tool-use", "pre-tool-use"];
  }
}

export function getNativeEventFallback(event: OpenClawNativeEventName): OpenClawHookEvent {
  return getNativeEventFallbacks(event)[0];
}

export function isTestCommand(command?: string): boolean {
  if (!command) return false;
  return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function isPrCreateCommand(command?: string): boolean {
  if (!command) return false;
  return PR_CREATE_PATTERNS.some((pattern) => pattern.test(command));
}

export function extractIssueNumber(...sources: Array<string | undefined>): number | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const pattern of ISSUE_NUMBER_PATTERNS) {
      const match = source.match(pattern);
      if (match?.[1]) return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

export function extractPrInfo(
  command?: string,
  output?: string,
  prUrlFromContext?: string,
  prNumberFromContext?: number,
): { prUrl?: string; prNumber?: number } {
  if (prUrlFromContext || prNumberFromContext) {
    return { prUrl: prUrlFromContext, prNumber: prNumberFromContext };
  }

  const candidates = [output, command];
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const pattern of PR_URL_PATTERNS) {
      const match = candidate.match(pattern);
      if (match?.[0]) {
        return {
          prUrl: match[0],
          prNumber: match[1] ? Number.parseInt(match[1], 10) : undefined,
        };
      }
    }
  }

  return {};
}

function getSessionCachePath(context: OpenClawContext): string {
  const projectPath = resolveToWorktreeRoot(context.projectPath);
  if (context.sessionId) {
    return join(ensureSessionStateDir(context.sessionId, projectPath), "openclaw-native-events.json");
  }

  const omcRoot = getOmcRoot(projectPath);
  const cacheDir = join(omcRoot, "state");
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  return join(cacheDir, "openclaw-native-events.json");
}

function readEventCache(cachePath: string): NativeEventCache {
  try {
    if (!existsSync(cachePath)) return {};
    return JSON.parse(readFileSync(cachePath, "utf-8")) as NativeEventCache;
  } catch {
    return {};
  }
}

function writeEventCache(cachePath: string, cache: NativeEventCache): void {
  try {
    const dir = dirname(cachePath);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // best-effort only
  }
}

export function buildNativeEvent(
  name: OpenClawNativeEventName,
  context: OpenClawContext,
  emittedAt: string,
  legacyEvent?: OpenClawHookEvent,
): OpenClawNativeEvent {
  const worktreePath = context.worktreePath ?? getWorktreeRoot(context.projectPath) ?? resolveToWorktreeRoot(context.projectPath);
  const projectPath = context.projectPath ?? worktreePath;
  const sessionName = context.sessionName ?? context.tmuxSession ?? getCurrentTmuxSession() ?? undefined;
  const repoRoot = context.repoRoot ?? worktreePath;
  const projectName = projectPath ? basename(projectPath) : getGitRepoName(projectPath) ?? undefined;
  const branch = context.branch ?? getGitBranch(projectPath) ?? undefined;
  const issueNumber = context.issueNumber ?? extractIssueNumber(context.prompt, context.reason, branch, context.command);
  const { prUrl, prNumber } = extractPrInfo(context.command, context.contextSummary, context.prUrl, context.prNumber);

  const dedupeSource = JSON.stringify({
    name,
    sessionId: context.sessionId,
    sessionName,
    toolName: context.toolName,
    command: context.command,
    reason: context.reason,
    question: context.question,
    errorSummary: context.errorSummary,
    retryCount: context.retryCount,
    branch,
    issueNumber,
    prNumber,
    prUrl,
  });

  const dedupeKey = createHash("sha1").update(dedupeSource).digest("hex");

  return {
    schema: "omc.native-event",
    version: 1,
    name,
    emittedAt,
    legacyEvent: legacyEvent ?? getNativeEventFallback(name),
    session: {
      id: context.sessionId,
      name: sessionName,
      tmuxSession: context.tmuxSession ?? sessionName,
    },
    repo: {
      projectPath,
      projectName,
      repoRoot,
      worktreePath,
      branch,
      issueNumber,
      prNumber,
      prUrl,
    },
    ...(context.toolName || context.command
      ? {
          tool: {
            name: context.toolName,
            command: context.command,
          },
        }
      : {}),
    ...(context.reason ? { reason: context.reason } : {}),
    ...(context.errorSummary || context.retryCount !== undefined
      ? {
          error: {
            summary: context.errorSummary,
            retryCount: context.retryCount,
          },
        }
      : {}),
    dedupeKey,
  };
}

export function shouldEmitNativeEvent(nativeEvent: OpenClawNativeEvent, context: OpenClawContext): boolean {
  const cachePath = getSessionCachePath(context);
  const cache = readEventCache(cachePath);
  const now = Date.parse(nativeEvent.emittedAt);
  const ttlMs = EVENT_DEDUPE_TTL_MS[nativeEvent.name];
  const nextEvents: Record<string, NativeEventCacheEntry> = {};

  for (const [key, value] of Object.entries(cache.events ?? {})) {
    const ts = Date.parse(value.emittedAt);
    if (!Number.isFinite(ts)) continue;
    if (now - ts <= 10 * 60 * 1000) {
      nextEvents[key] = value;
    }
  }

  const previous = nextEvents[nativeEvent.dedupeKey];
  if (previous) {
    const previousTs = Date.parse(previous.emittedAt);
    if (Number.isFinite(previousTs) && now - previousTs < ttlMs) {
      return false;
    }
  }

  nextEvents[nativeEvent.dedupeKey] = { emittedAt: nativeEvent.emittedAt };
  writeEventCache(cachePath, { events: nextEvents });
  return true;
}
