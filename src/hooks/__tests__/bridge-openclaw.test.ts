import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _openclaw, processHook, resetSkipHooksCache, type HookInput } from "../bridge.js";

describe("_openclaw.wake", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is a no-op when OMC_OPENCLAW is not set", () => {
    vi.stubEnv("OMC_OPENCLAW", "");
    // Should return undefined without doing anything
    const result = _openclaw.wake("session-start", { sessionId: "sid-1" });
    expect(result).toBeUndefined();
  });

  it("is a no-op when OMC_OPENCLAW is not '1'", () => {
    vi.stubEnv("OMC_OPENCLAW", "true");
    const result = _openclaw.wake("session-start", { sessionId: "sid-1" });
    expect(result).toBeUndefined();
  });

  it("triggers the dynamic import when OMC_OPENCLAW === '1'", async () => {
    vi.stubEnv("OMC_OPENCLAW", "1");

    // Mock the dynamic import of openclaw/index.js
    const mockWakeOpenClaw = vi.fn().mockResolvedValue({ gateway: "test", success: true });
    vi.doMock("../../openclaw/index.js", () => ({
      wakeOpenClaw: mockWakeOpenClaw,
    }));

    _openclaw.wake("session-start", { sessionId: "sid-1", projectPath: "/home/user/project" });

    // Give the microtask queue time to process the dynamic import
    await new Promise((resolve) => setTimeout(resolve, 10));

    vi.doUnmock("../../openclaw/index.js");
  });

  it("does not throw when OMC_OPENCLAW === '1' and import fails", async () => {
    vi.stubEnv("OMC_OPENCLAW", "1");

    // Even if the dynamic import fails, _openclaw.wake should not throw
    expect(() => {
      _openclaw.wake("session-start", {});
    }).not.toThrow();

    // Give time for the promise chain to settle
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("accepts all supported hook event types", () => {
    vi.stubEnv("OMC_OPENCLAW", "");
    // These should all be callable without type errors (no-op since OMC_OPENCLAW not set)
    expect(() => _openclaw.wake("session-start", {})).not.toThrow();
    expect(() => _openclaw.wake("session-end", {})).not.toThrow();
    expect(() => _openclaw.wake("pre-tool-use", { toolName: "Bash" })).not.toThrow();
    expect(() => _openclaw.wake("post-tool-use", { toolName: "Bash" })).not.toThrow();
    expect(() => _openclaw.wake("stop", {})).not.toThrow();
    expect(() => _openclaw.wake("keyword-detector", { prompt: "hello" })).not.toThrow();
    expect(() => _openclaw.wake("ask-user-question", { question: "what?" })).not.toThrow();
    expect(() => _openclaw.wake("test-started", { toolName: "Bash", command: "npm test" })).not.toThrow();
    expect(() => _openclaw.wake("pr-created", { toolName: "Bash", command: "gh pr create" })).not.toThrow();
  });

  it("passes context fields through to wakeOpenClaw", async () => {
    vi.stubEnv("OMC_OPENCLAW", "1");

    const mockWakeOpenClaw = vi.fn().mockResolvedValue(null);
    vi.doMock("../../openclaw/index.js", () => ({
      wakeOpenClaw: mockWakeOpenClaw,
    }));

    const context = { sessionId: "sid-123", projectPath: "/home/user/project", toolName: "Read" };
    _openclaw.wake("pre-tool-use", context);

    // Wait for async import
    await new Promise((resolve) => setTimeout(resolve, 10));

    vi.doUnmock("../../openclaw/index.js");
  });
});

describe("bridge-level regression tests", () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    delete process.env.DISABLE_OMC;
    delete process.env.OMC_SKIP_HOOKS;
    delete process.env.OMC_OPENCLAW;
    delete process.env.OMC_NOTIFY;
    resetSkipHooksCache();
    tmpDir = mkdtempSync(join(tmpdir(), "bridge-openclaw-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    process.env = originalEnv;
    resetSkipHooksCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keyword-detector injects translation message for non-Latin prompts", async () => {
    const input: HookInput = {
      sessionId: "test-session",
      prompt: "이 코드를 수정해줘",
      directory: tmpDir,
    };

    const result = await processHook("keyword-detector", input);

    // The result should contain the PROMPT_TRANSLATION_MESSAGE
    expect(result.message).toBeDefined();
    expect(result.message).toContain("[PROMPT TRANSLATION]");
    expect(result.message).toContain("Non-English input detected");
  });

  it("keyword-detector does NOT inject translation message for Latin prompts", async () => {
    const input: HookInput = {
      sessionId: "test-session",
      prompt: "fix the bug in auth.ts",
      directory: tmpDir,
    };

    const result = await processHook("keyword-detector", input);

    // Should not contain translation message for English text
    const msg = result.message || "";
    expect(msg).not.toContain("[PROMPT TRANSLATION]");
  });

  it("pre-tool-use emits ask-user-question and handoff-needed for AskUserQuestion", async () => {
    process.env.OMC_OPENCLAW = "1";
    process.env.OMC_NOTIFY = "0"; // suppress real notifications

    const wakeSpy = vi.spyOn(_openclaw, "wake");

    const input: HookInput = {
      sessionId: "test-session-ask",
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [{ question: "What should I do next?" }],
      },
      directory: tmpDir,
    };

    await processHook("pre-tool-use", input);

    // Verify _openclaw.wake was called with ask-user-question event
    const askCall = wakeSpy.mock.calls.find(
      (call) => call[0] === "ask-user-question",
    );
    expect(askCall).toBeDefined();
    expect(askCall![1]).toMatchObject({
      sessionId: "test-session-ask",
      question: "What should I do next?",
    });
    const handoffCall = wakeSpy.mock.calls.find(
      (call) => call[0] === "handoff-needed",
    );
    expect(handoffCall).toBeDefined();
    expect(handoffCall![1]).toMatchObject({
      sessionId: "test-session-ask",
      question: "What should I do next?",
    });

    wakeSpy.mockRestore();
  });

  it("session-start emits a started native event", async () => {
    process.env.OMC_OPENCLAW = "1";
    const wakeSpy = vi.spyOn(_openclaw, "wake");

    await processHook("session-start", {
      sessionId: "test-session-start",
      directory: tmpDir,
    });

    const startCall = wakeSpy.mock.calls.find((call) => call[0] === "started");
    expect(startCall).toBeDefined();
    expect(startCall![1]).toMatchObject({
      sessionId: "test-session-start",
    });

    wakeSpy.mockRestore();
  });

  it("pre-tool-use emits test-started for test commands", async () => {
    process.env.OMC_OPENCLAW = "1";
    const wakeSpy = vi.spyOn(_openclaw, "wake");

    await processHook("pre-tool-use", {
      sessionId: "test-session-test-started",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      directory: tmpDir,
    });

    const preToolCall = wakeSpy.mock.calls.find((call) => call[0] === "test-started");
    expect(preToolCall).toBeDefined();
    expect(preToolCall![1]).toMatchObject({
      sessionId: "test-session-test-started",
      command: "npm test",
    });

    wakeSpy.mockRestore();
  });

  it("post-tool-use emits pr-created for PR creation commands", async () => {
    process.env.OMC_OPENCLAW = "1";
    const wakeSpy = vi.spyOn(_openclaw, "wake");

    await processHook("post-tool-use", {
      sessionId: "test-session-pr-created",
      toolName: "Bash",
      toolInput: { command: "gh pr create --base dev" },
      toolOutput: "https://github.com/Yeachan-Heo/oh-my-claudecode/pull/1501",
      directory: tmpDir,
    });

    const postToolCall = wakeSpy.mock.calls.find((call) => call[0] === "pr-created");
    expect(postToolCall).toBeDefined();
    expect(postToolCall![1]).toMatchObject({
      prNumber: 1501,
      prUrl: "https://github.com/Yeachan-Heo/oh-my-claudecode/pull/1501",
    });

    wakeSpy.mockRestore();
  });
});
