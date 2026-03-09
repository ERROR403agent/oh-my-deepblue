/**
 * OpenClaw Gateway Integration Types
 *
 * Defines types for the OpenClaw gateway waker system.
 * Each hook event can be mapped to a gateway with a pre-defined instruction.
 */

/** Legacy hook events that can trigger OpenClaw gateway calls */
export type OpenClawHookEvent =
  | "session-start"
  | "session-end"
  | "pre-tool-use"
  | "post-tool-use"
  | "stop"
  | "keyword-detector"
  | "ask-user-question";

/** Native clawhip-friendly OMC event names */
export type OpenClawNativeEventName =
  | "started"
  | "blocked"
  | "finished"
  | "failed"
  | "retry-needed"
  | "pr-created"
  | "test-started"
  | "test-finished"
  | "test-failed"
  | "handoff-needed";

/** Generic mapping key for any native event */
export type OpenClawNativeEventMapping = "native-event";

/** Any event name accepted by OpenClaw routing/config */
export type OpenClawEventName =
  | OpenClawHookEvent
  | OpenClawNativeEventName
  | OpenClawNativeEventMapping;

/** HTTP gateway configuration (default when type is absent or "http") */
export interface OpenClawHttpGatewayConfig {
  /** Gateway type discriminator (optional for backward compat) */
  type?: "http";
  /** Gateway endpoint URL (HTTPS required, HTTP allowed for localhost) */
  url: string;
  /** Optional custom headers (e.g., Authorization) */
  headers?: Record<string, string>;
  /** HTTP method (default: POST) */
  method?: "POST" | "PUT";
  /** Per-request timeout in ms (default: 10000) */
  timeout?: number;
}

/** CLI command gateway configuration */
export interface OpenClawCommandGatewayConfig {
  /** Gateway type discriminator */
  type: "command";
  /** Command template with {{variable}} placeholders.
   *  Variables are shell-escaped automatically before interpolation. */
  command: string;
  /** Per-command timeout in ms (default: 10000) */
  timeout?: number;
}

/** Gateway configuration — HTTP or CLI command */
export type OpenClawGatewayConfig = OpenClawHttpGatewayConfig | OpenClawCommandGatewayConfig;

/** Per-hook-event mapping to a gateway + instruction */
export interface OpenClawHookMapping {
  /** Name of the gateway (key in gateways object) */
  gateway: string;
  /** Instruction template with {{variable}} placeholders */
  instruction: string;
  /** Whether this hook-event mapping is active */
  enabled: boolean;
}

/** Top-level config schema for omc_config.openclaw.json */
export interface OpenClawConfig {
  /** Global enable/disable */
  enabled: boolean;
  /** Named gateway endpoints */
  gateways: Record<string, OpenClawGatewayConfig>;
  /** Event-to-gateway+instruction mappings (legacy key name retained for compat) */
  hooks: Partial<Record<OpenClawEventName, OpenClawHookMapping>>;
}

export interface OpenClawNativeSessionContext {
  id?: string;
  name?: string;
  tmuxSession?: string;
}

export interface OpenClawNativeRepoContext {
  projectPath?: string;
  projectName?: string;
  repoRoot?: string;
  worktreePath?: string;
  branch?: string;
  issueNumber?: number;
  prNumber?: number;
  prUrl?: string;
}

export interface OpenClawNativeToolContext {
  name?: string;
  command?: string;
}

export interface OpenClawNativeErrorContext {
  summary?: string;
  retryCount?: number;
}

/** Versioned native event contract for clawhip/OpenClaw consumers */
export interface OpenClawNativeEvent {
  schema: "omc.native-event";
  version: 1;
  name: OpenClawNativeEventName;
  emittedAt: string;
  dedupeKey: string;
  legacyEvent?: OpenClawHookEvent;
  session: OpenClawNativeSessionContext;
  repo: OpenClawNativeRepoContext;
  tool?: OpenClawNativeToolContext;
  error?: OpenClawNativeErrorContext;
  reason?: string;
}

/** Payload sent to an OpenClaw gateway */
export interface OpenClawPayload {
  /** The hook event that triggered this call */
  event: OpenClawEventName;
  /** Stable top-level envelope marker */
  schema: "omc.openclaw-event";
  /** Stable top-level envelope version */
  schemaVersion: 1;
  /** Source system */
  source: "omc";
  /** Interpolated instruction text */
  instruction: string;
  /** ISO timestamp */
  timestamp: string;
  /** Normalized native event envelope for clawhip-style routing */
  nativeEvent?: OpenClawNativeEvent;
  /** Session identifier (if available) */
  sessionId?: string;
  /** Project directory path */
  projectPath?: string;
  /** Project basename */
  projectName?: string;
  /** Stable session name when available */
  sessionName?: string;
  /** Stable repo root when available */
  repoRoot?: string;
  /** Stable worktree path when available */
  worktreePath?: string;
  /** Current branch when available */
  branch?: string;
  /** Parsed issue number when available */
  issueNumber?: number;
  /** Parsed PR number when available */
  prNumber?: number;
  /** Parsed PR URL when available */
  prUrl?: string;
  /** Command context when available */
  command?: string;
  /** Error summary when available */
  errorSummary?: string;
  /** Retry count when available */
  retryCount?: number;
  /** Tmux session name (if running inside tmux) */
  tmuxSession?: string;
  /** Recent tmux pane output (for stop/session-end events) */
  tmuxTail?: string;
  /** Reply channel name (from OPENCLAW_REPLY_CHANNEL env var) */
  channel?: string;
  /** Reply target (user/bot) from OPENCLAW_REPLY_TARGET env var */
  to?: string;
  /** Reply thread ID from OPENCLAW_REPLY_THREAD env var */
  threadId?: string;
  /** Context data from the hook (whitelisted fields only) */
  context: OpenClawContext;
}

/**
 * Context data passed from the hook to OpenClaw for template interpolation.
 *
 * All fields are explicitly enumerated (no index signature) to prevent
 * accidental leakage of sensitive data into gateway payloads.
 */
export interface OpenClawContext {
  sessionId?: string;
  sessionName?: string;
  projectPath?: string;
  repoRoot?: string;
  worktreePath?: string;
  branch?: string;
  issueNumber?: number;
  prNumber?: number;
  prUrl?: string;
  tmuxSession?: string;
  toolName?: string;
  command?: string;
  prompt?: string;
  contextSummary?: string;
  reason?: string;
  question?: string;
  errorSummary?: string;
  retryCount?: number;
  nativeEventName?: OpenClawNativeEventName;
  /** Recent tmux pane output (captured automatically for stop/session-end events) */
  tmuxTail?: string;
  /** Reply channel name from OPENCLAW_REPLY_CHANNEL env var */
  replyChannel?: string;
  /** Reply target (user/bot) from OPENCLAW_REPLY_TARGET env var */
  replyTarget?: string;
  /** Reply thread ID from OPENCLAW_REPLY_THREAD env var */
  replyThread?: string;
}

/** Result of a gateway wake attempt */
export interface OpenClawResult {
  /** Gateway name */
  gateway: string;
  /** Whether the call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** HTTP status code if available */
  statusCode?: number;
}
