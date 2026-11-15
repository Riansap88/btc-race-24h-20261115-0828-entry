# btc-race-24h-20261115-0828-entry

Bot for the make.fun competition "Race a BTC trading bot live for 24 hours"
(`btc-race-24h-20261115-0828`): trades cbBTC/USDC on 1-minute on-chain bars
with $1,000 of paper money, long only, simulation only.

## Strategy: V-bounce catcher

Sit in cash. Buy with all cash only after a sharp flush that has already
started to bounce:

- close is at least **1.8% below** the close 120 bars ago, AND
- close is at least **0.4% above** the close 5 bars ago.

Exit on whichever comes first: **+4% take-profit**, **-2% stop-loss**, or
**120 bars held**. One position at a time. All comparisons are integer
arithmetic on bar closes, so the bot is deterministic: no clock, no
randomness, no network, no files outside this repo.

The 5-minute bounce confirmation is the edge. Backtested on the frozen
24-hour dev window (1,440 bars) the same dip rule without confirmation
loses money buying into a falling knife; with confirmation it makes about
+$49 in 3 round trips at 1.4% max drawdown, while buy-and-hold loses $44
and every kit baseline loses money on the same window.

## Files

- `main.ts` — the bot (Node 22, standard library only)
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's protocol shim
- `LICENSE` — MIT

## Run locally

Grade on the dev window with the kit's CLI (from the kit directory):

```
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## License

MIT
