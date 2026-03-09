import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Mock persistent-mode so we can control shouldSendIdleNotification
vi.mock("../persistent-mode/index.js", () => ({
  checkPersistentModes: vi.fn().mockResolvedValue({ mode: "none", message: "" }),
  createHookOutput: vi.fn().mockReturnValue({ continue: true }),
  shouldSendIdleNotification: vi.fn().mockReturnValue(false), // cooldown ACTIVE — gate closed
  recordIdleNotificationSent: vi.fn(),
  getIdleNotificationCooldownSeconds: vi.fn().mockReturnValue(60),
  readLastToolError: vi.fn().mockReturnValue(null),
}));

vi.mock("../todo-continuation/index.js", () => ({
  isExplicitCancelCommand: vi.fn().mockReturnValue(false),
  isAuthenticationError: vi.fn().mockReturnValue(false),
  isContextLimitStop: vi.fn().mockReturnValue(false),
  isRateLimitStop: vi.fn().mockReturnValue(false),
}));

import { _openclaw, processHook, resetSkipHooksCache, type HookInput } from "../bridge.js";
import { checkPersistentModes } from "../persistent-mode/index.js";

describe("stop hook OpenClaw cooldown bypass (issue #1120)", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-stop-claw-"));
    // git init so resolveToWorktreeRoot returns this directory
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    resetSkipHooksCache();
    delete process.env.DISABLE_OMC;
    delete process.env.OMC_SKIP_HOOKS;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetSkipHooksCache();
  });

  it("calls _openclaw.wake('stop') even when shouldSendIdleNotification returns false", async () => {
    process.env.OMC_OPENCLAW = "1";
    const wakeSpy = vi.spyOn(_openclaw, "wake");

    const input: HookInput = {
      sessionId: "test-session-123",
      directory: tmpDir,
    };

    await processHook("persistent-mode", input);

    // OpenClaw stop should fire regardless of notification cooldown
    expect(wakeSpy).toHaveBeenCalledWith(
      "stop",
      expect.objectContaining({
        sessionId: "test-session-123",
      }),
    );

    wakeSpy.mockRestore();
  });

  it("does NOT call _openclaw.wake('stop') when user_requested abort", async () => {
    process.env.OMC_OPENCLAW = "1";
    const wakeSpy = vi.spyOn(_openclaw, "wake");

    const input: HookInput = {
      sessionId: "test-session-456",
      directory: tmpDir,
      // Simulate user-requested abort
    };
    (input as Record<string, unknown>).user_requested = true;

    await processHook("persistent-mode", input);

    // OpenClaw stop should NOT fire for user aborts
    const stopCall = wakeSpy.mock.calls.find((call) => call[0] === "stop");
    expect(stopCall).toBeUndefined();

    wakeSpy.mockRestore();
  });

  it("emits retry-needed when persistent-mode reports a recent tool error", async () => {
    process.env.OMC_OPENCLAW = "1";
    vi.mocked(checkPersistentModes).mockResolvedValueOnce({
      mode: "ralph",
      message: "retry",
      metadata: {
        toolError: {
          tool_name: "Bash",
          tool_input_preview: "npm test",
          error: "Command failed",
          timestamp: new Date().toISOString(),
          retry_count: 2,
        },
      },
    } as never);

    const wakeSpy = vi.spyOn(_openclaw, "wake");

    await processHook("persistent-mode", {
      sessionId: "test-session-789",
      directory: tmpDir,
    });

    const retryCall = wakeSpy.mock.calls.find((call) => call[0] === "retry-needed");
    expect(retryCall).toBeDefined();
    expect(retryCall![1]).toMatchObject({
      sessionId: "test-session-789",
      toolName: "Bash",
      errorSummary: "Command failed",
      retryCount: 2,
    });

    wakeSpy.mockRestore();
  });
});
