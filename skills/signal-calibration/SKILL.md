# /signal-calibration — Signal Quality Deep Dive

Statistical breakdown of all resolved trades to identify systematically losing segments. Produces a concrete list of gates and thresholds to implement. Runs ZoidClaw → EXEC → Squid → Fishy pipeline.

## When to use
- Every 50 resolved trades
- When overall WR drops below 55% over last 20 trades
- When a specific regime or hour is suspected of leaking
- `/signal-calibration`

## Data source
`/home/ubuntu/bots/poly_positions.json` — all resolved trades

## Analysis dimensions

Run this ZoidClaw task:
```python
Task(subagent_type="oh-my-deepblue:zoidclaw-scientist", prompt="""
Run a calibration analysis on /home/ubuntu/bots/poly_positions.json.

For each dimension below, compute WR (win rate), n (sample size), and EV (avg P&L per trade):

1. Hour-of-day (UTC 0-23): Which hours have WR < 0.50 with n >= 8? → candidate for toxic_hours
2. Regime: AGREE vs DIVERGE vs FLAT — WR, EV, n for each
3. Confidence bucket: 0.50-0.55, 0.55-0.60, 0.60-0.65, 0.65-0.70, 0.70-0.75, 0.75-0.80, 0.80+
   → identify lowest confidence bucket with WR > 0.52 (the break-even floor)
4. CL move size at entry: <0.05%, 0.05-0.10%, 0.10-0.15%, >0.15%
   → does larger move correlate with higher WR? What's the minimum move worth entering?
5. CLOB vs Gamma mid gap: when CLOB was >5 cents below Gamma, what was WR?
   → measures order-flow veto effectiveness

For each finding: state null hypothesis, result, and whether it's statistically significant (p < 0.05 threshold).
Flag as GATE CANDIDATE any segment with: WR < 0.50, n >= 10, statistically significant.
""")
```

## Gate criteria
A gate is worth adding only if:
- WR < 0.50 with n >= 10 (statistically significant)
- Adding the gate reduces total trade frequency by < 30%
- Expected EV improvement > $0.20/session

## After analysis
1. EXEC reviews: which GATE CANDIDATEs to implement
2. Squid implements in trading_config.json (toxic_hours, confidence floors, min_move thresholds)
3. Fishy verifies safety params unchanged
4. Restart deepblue-fishy
