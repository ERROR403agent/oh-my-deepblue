import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

vi.mock("../../hud/elements/git.js", () => ({
  getGitBranch: vi.fn((cwd?: string) => cwd ? "feat/native-clawhip-events" : "feat/native-clawhip-events"),
  getGitRepoName: vi.fn(() => "oh-my-claudecode"),
}));

import {
  buildNativeEvent,
  extractIssueNumber,
  extractPrInfo,
  getNativeEventFallbacks,
  isPrCreateCommand,
  isTestCommand,
  shouldEmitNativeEvent,
} from "../native-events.js";

describe("openclaw native events", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omc-native-events-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    execSync("git checkout -b feat/native-clawhip-events", { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("builds a versioned native event envelope with normalized repo metadata", () => {
    const nativeEvent = buildNativeEvent("test-finished", {
      sessionId: "sid-1",
      sessionName: "sid-1",
      projectPath: tmpDir,
      toolName: "Bash",
      command: "npm test",
      contextSummary: "All tests passed",
      issueNumber: 1500,
    }, "2026-03-09T18:00:00.000Z", "post-tool-use");

    expect(nativeEvent.schema).toBe("omc.native-event");
    expect(nativeEvent.version).toBe(1);
    expect(nativeEvent.name).toBe("test-finished");
    expect(nativeEvent.legacyEvent).toBe("post-tool-use");
    expect(nativeEvent.session.id).toBe("sid-1");
    expect(nativeEvent.repo.projectPath).toBe(tmpDir);
    expect(nativeEvent.repo.branch).toBe("feat/native-clawhip-events");
    expect(nativeEvent.repo.issueNumber).toBe(1500);
    expect(nativeEvent.tool?.command).toBe("npm test");
    expect(nativeEvent.dedupeKey).toMatch(/^[a-f0-9]{40}$/);
  });

  it("dedupes repeated native events inside the TTL window", () => {
    const nativeEvent = buildNativeEvent("retry-needed", {
      sessionId: "sid-2",
      projectPath: tmpDir,
      toolName: "Bash",
      command: "npm test",
      errorSummary: "vitest failed",
      retryCount: 2,
    }, "2026-03-09T18:00:00.000Z", "stop");

    expect(shouldEmitNativeEvent(nativeEvent, { sessionId: "sid-2", projectPath: tmpDir })).toBe(true);
    expect(shouldEmitNativeEvent(nativeEvent, { sessionId: "sid-2", projectPath: tmpDir })).toBe(false);
  });

  it("classifies test commands and PR creation commands", () => {
    expect(isTestCommand("pnpm test --runInBand")).toBe(true);
    expect(isTestCommand("gh pr create --fill")).toBe(false);
    expect(isPrCreateCommand("gh pr create --fill")).toBe(true);
    expect(isPrCreateCommand("npm test")).toBe(false);
  });

  it("extracts issue and PR metadata from command/output context", () => {
    expect(extractIssueNumber("implement #1500 hardening")).toBe(1500);
    expect(extractPrInfo(
      "gh pr create --fill",
      "https://github.com/Yeachan-Heo/oh-my-claudecode/pull/1509",
    )).toEqual({
      prUrl: "https://github.com/Yeachan-Heo/oh-my-claudecode/pull/1509",
      prNumber: 1509,
    });
  });

  it("maps native events to legacy fallbacks for backward compatibility", () => {
    expect(getNativeEventFallbacks("started")).toEqual(["session-start"]);
    expect(getNativeEventFallbacks("handoff-needed")).toEqual(["ask-user-question", "stop"]);
    expect(getNativeEventFallbacks("test-failed")).toEqual(["post-tool-use", "pre-tool-use"]);
  });
});
