# OpenClaw Native Event Contract

OMC now emits a normalized native event envelope for clawhip/OpenClaw consumers.

## Top-level payload

Every OpenClaw webhook payload keeps the legacy fields and now also includes:

```json
{
  "event": "session-start",
  "schema": "omc.openclaw-event",
  "schemaVersion": 1,
  "source": "omc",
  "nativeEvent": {
    "schema": "omc.native-event",
    "version": 1,
    "name": "started",
    "dedupeKey": "…",
    "emittedAt": "2026-03-09T00:00:00.000Z",
    "legacyEvent": "session-start",
    "session": {
      "id": "…",
      "name": "…",
      "tmuxSession": "…"
    },
    "repo": {
      "projectPath": "…",
      "projectName": "…",
      "repoRoot": "…",
      "worktreePath": "…",
      "branch": "…",
      "issueNumber": 1500,
      "prNumber": 42,
      "prUrl": "https://github.com/owner/repo/pull/42"
    },
    "tool": {
      "name": "Bash",
      "command": "npm test"
    },
    "error": {
      "summary": "Command failed",
      "retryCount": 2
    },
    "reason": "user-input-required"
  }
}
```

## Native event names

- `started`
- `blocked`
- `finished`
- `failed`
- `retry-needed`
- `pr-created`
- `test-started`
- `test-finished`
- `test-failed`
- `handoff-needed`

## Emission rules

- `started`: session start
- `blocked`: stop handling for active blocked states such as auth/rate-limit/context/tool-error follow-up
- `finished`: clean session end (`reason=clear`)
- `failed`: non-clean session end and tool-failure hook emissions
- `retry-needed`: recent tool failure / retry guidance
- `pr-created`: successful PR creation command detection (`gh pr create`, parsed PR URL/number)
- `test-started`: pre-tool detection of common test commands
- `test-finished`: successful post-tool detection of common test commands
- `test-failed`: tool-failure hook for test commands, plus post-tool failure-shaped outputs when available
- `handoff-needed`: AskUserQuestion / explicit user-input handoff

## Dedupe / noise control

- Native events are deduped per session/worktree with event-specific TTLs.
- `nativeEvent.dedupeKey` is stable for repeated equivalent emissions.
- Legacy payload fields remain present for backward compatibility, but clawhip should route on `nativeEvent.name` when available.

## Routing compatibility

- Existing legacy `hooks` mappings still work.
- Native events first resolve exact mappings.
- If no exact native mapping exists, OMC falls back to:
  - `native-event`
  - then the closest legacy hook mapping (`session-start`, `session-end`, `pre-tool-use`, `post-tool-use`, `stop`, `ask-user-question`)

## Recommended consumer behavior

1. Prefer `nativeEvent.name` for routing.
2. Use `nativeEvent.repo.*`, `nativeEvent.tool.*`, and `nativeEvent.error.*` instead of parsing `instruction`.
3. Use `nativeEvent.dedupeKey` to collapse repeats if you maintain your own event store.
