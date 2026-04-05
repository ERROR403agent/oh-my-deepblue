# /alpha-hunt — Weekly Alpha Discovery

Researches new edge in Polymarket 5-min BTC markets. Scores candidate patterns by EV and implementation cost. Shadow-tests the best one. Promotes to live if WR > 58% over 20 windows.

## When to use
- Weekly (Sunday UTC)
- When WR has been flat 2+ weeks despite calibration
- When Boss asks "find new edge"
- `/alpha-hunt`

## Research questions for ZoidClaw

```python
Task(subagent_type="oh-my-deepblue:zoidclaw-researcher", prompt="""
Research potential new alpha patterns in Polymarket 5-min BTC markets.
Use /home/ubuntu/bots/poly_positions.json as the empirical base.

Investigate these hypotheses:

1. Smart money entry timing
   In our existing trades, does entry time within the window (T-250s vs T-150s vs T-90s) correlate with WR?
   Earlier entry at higher price = informed bet or noise?

2. Price drift before resolution
   In the 30s before window close (T-30 to T-0), does price tend to continue or reverse the trend established at T-120s?
   → Mean reversion vs momentum at resolution — which regime does Chainlink Data Streams show?

3. DIVERGE window pattern
   When CL and BN disagree at T-150s, does the BN direction or the CL direction tend to resolve correctly?
   → Is BN lead or CL lead more predictive in DIVERGE regime?

4. Volatility-adjusted entry
   In low-volatility windows (<0.005%/s), what is the base rate for continuation vs reversal?
   → Is the FLAT regime gating too aggressively or not aggressively enough?

5. Orderbook imbalance signal
   When YES token price > 0.60 at window open (strong prior), what is the probability of resolution confirming that prior?
   → Is the market efficient at T-250s or is there mean-reversion alpha?

For each hypothesis: show the data, state n, compute WR, estimate EV/trade at $4 bet size.
Rate implementation complexity: Low (config change) / Medium (code change <2h) / High (new module).
""")
```

## Hypothesis scoring

EXEC scores each candidate:
```python
Task(subagent_type="oh-my-deepblue:exec-planner", prompt="""
ZoidClaw's research: [paste output]

Score each hypothesis: EV/trade × confidence × (1 / implementation_cost_hours).
Select top 1-2 to shadow-test.
For each selected: WHO implements, WHAT exactly (config key or code change), DONE WHEN (WR > 58% over 20 shadow windows).
""")
```

## Shadow test protocol

Squid implements as LOG-ONLY (signal logged but no order placed):
```python
Task(subagent_type="oh-my-deepblue:squid-executor", prompt="""
Implement shadow test for: [hypothesis name and description]
Requirements:
- Log the signal and what the outcome would have been
- Do NOT place any orders
- Tag log lines with [SHADOW:{hypothesis_name}]
- Run for minimum 20 windows before any evaluation
""")
```

## Promotion criteria

ZoidClaw evaluates after 20 windows:
- Shadow WR > 58%
- No conflict with existing CL-EARLY gate  
- EV/trade > $0.50 at current bet sizes
- n >= 20 resolved windows

If criteria met → Fishy verifies → Squid promotes to live → restart bot → monitor 5 windows.

## Failure modes
- Promoting before n >= 20 (survivorship bias)
- Running shadow test during low-activity hours (sample contamination)
- Skipping Fishy verification before going live (real capital at risk)
