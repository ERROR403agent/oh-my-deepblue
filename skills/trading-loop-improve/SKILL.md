# /trading-loop-improve — Autonomous Trading Improvement Loop

Analyzes recent trade history, identifies losing patterns, proposes improvements, implements them safely, and restarts the trading bot. Runs end-to-end without human input unless a safety gate trips.

## When to use
- After 30+ new resolved trades accumulate in poly_positions.json
- After a losing streak (3+ consecutive losses)
- When the Boss says "adjust for profit" or "check trades"
- On demand: `/trading-loop-improve`

## Full pipeline

### Phase 1 — ZoidClaw analysis
```python
Task(subagent_type="oh-my-deepblue:zoidclaw-analyst", prompt="""
Analyze /home/ubuntu/bots/poly_positions.json and /home/ubuntu/bots/fivemin_performance.json.

Segment all resolved trades by:
1. Regime (AGREE / DIVERGE / FLAT) — WR and avg EV for each
2. Hour of day UTC — flag any hour with WR < 0.50 and n >= 8
3. Confidence tier (0.50-0.60, 0.60-0.70, 0.70-0.80, 0.80+) — WR and EV for each
4. CL move size (<0.05%, 0.05-0.10%, >0.10%) — WR for each

For each segment with negative EV: label it LOSS LEAK.
Recommend: which segments to gate, which confidence floors to raise, which regimes to disable.
Output: structured table. Be specific — [metric] [op] [threshold], not vague suggestions.
""")
```

### Phase 2 — EXEC decision
```python
Task(subagent_type="oh-my-deepblue:exec-planner", prompt="""
ZoidClaw's analysis: [paste Phase 1 output]

Review and decide: which recommendations to implement now?
Filter by: implementation cost < 30 min AND expected EV improvement > $0.50/session.
Output: prioritized list of 1-3 changes with exact config keys and new values.
WHO: Squid. WHAT: implement these changes. WHEN: now. DONE WHEN: Fishy approves.
""")
```

### Phase 3 — Safety gate
Before any changes, run the /careful pre-flight:
```bash
python3 -c "
import json
cfg = json.load(open('/home/ubuntu/bots/trading_config.json'))
print('simulation_mode:', cfg['simulation_mode'])
print('bet_size_usdc:', cfg['bet_size_usdc'])
print('hard_cap_usdc:', cfg['hard_cap_usdc'])
print('daily_loss_limit:', cfg['daily_loss_limit'])
print('wallet_emergency_threshold:', cfg.get('wallet_emergency_threshold'))
"
```

**STOP if any recommended change would:**
- Raise bet_size_usdc above current value by more than 50%
- Raise hard_cap_usdc above $20
- Raise daily_loss_limit above $30
- Set simulation_mode to True (disables live trading)

If stopped: surface to Boss with specific values. Do not proceed.

### Phase 4 — Squid implements
For each approved change:
```python
Task(subagent_type="oh-my-deepblue:squid-executor", prompt="""
Implement: [specific change from EXEC's list — exact key name and new value]
File: /home/ubuntu/bots/trading_config.json (and/or bot_fishy.py if code change needed)
Constraints:
- Smallest viable diff
- Check config/code sync: verify the key isn't also hardcoded in bot_fishy.py
- Do not change anything outside the approved list
Output: file:line of what changed, and whether a restart is required.
""")
```

### Phase 5 — Fishy verifies
```python
Task(subagent_type="oh-my-deepblue:fishy-verifier", prompt="""
Verify the trading config changes are safe:
1. simulation_mode is still False
2. wallet_emergency_threshold not raised above $75
3. daily_loss_limit not raised above $30
4. hard_cap_usdc not raised above $20
5. Only the approved changes were made — nothing extra

Read /home/ubuntu/bots/trading_config.json and confirm each point.
PASS or FAIL. Show the receipt.
""")
```

### Phase 6 — Deploy (only if Fishy PASS)
```bash
systemctl --user restart deepblue-fishy
sleep 5
journalctl --user -u deepblue-fishy -n 15 --no-pager | grep -E "(started|error|ERROR|5min|EMERGENCY)"
```

If bot fails to start: immediately revert the last config change and re-run verification.

### Phase 7 — Report
Append to /home/ubuntu/openclaw_tasks.md:
```
## [DONE - {date}] trading-loop-improve
Changes: {list what changed}
Expected EV improvement: {ZoidClaw's estimate}
Fishy verdict: PASS
Bot restarted: yes
Watch: first 5 windows for anomalies
```

## Abort conditions
- Fishy REJECT → revert all changes, do not restart, escalate to Boss
- Bot crash after restart → revert last config change immediately
- Any change not in EXEC's approved list → STOP, do not implement
