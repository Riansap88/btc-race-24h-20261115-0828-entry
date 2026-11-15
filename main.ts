// V-bounce catcher for cbBTC/USDC (agent-fun/bars-replay/v1).
//
// Strategy, in one paragraph: BTC on 1-minute bars spends most of its day
// drifting and then snaps back hard after a sharp flush. This bot sits in cash
// and only buys after a real washout that has already started to bounce: the
// close is at least 1.8% below where it was 120 bars ago AND at least 0.4%
// above where it was 5 bars ago. It buys with all of its cash, then exits on
// whichever comes first: +4% take-profit, -2% stop-loss, or 120 bars held.
// One position at a time, long only, no leverage, no shorts. Every comparison
// is exact integer arithmetic on the bar closes, so two runs on the same bars
// give the same orders; there is no clock, no randomness and no network.
//
// Why these numbers (tuned on the frozen 24h dev window, 1,440 bars):
// - the 5-minute bounce confirmation is the whole edge: without it the same
//   dip rule loses money buying into a falling knife, with it the rule clears
//   about +$49 on the dev window in 3 round trips with 1.4% max drawdown;
// - the take-profit at +4% lets the one big snap-back of the window pay for
//   the round trip cost (about 26 bps all-in per full-size round trip);
// - the 120-bar hold cap stops a position from bleeding through a slow grind.

import { BPS, runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Entry: sharp 120-bar flush that has already turned up on the 5-bar tape.
const DROP_LOOKBACK = 120;
const DROP_BPS = 180n; // close <= 120 bars ago * (1 - 1.8%)
const BOUNCE_LOOKBACK = 5;
const BOUNCE_BPS = 40n; // close >= 5 bars ago * (1 + 0.4%)

// Exit: first of take-profit, stop-loss, hold cap.
const TAKE_PROFIT_BPS = 400n; // +4% from the fill price
const STOP_LOSS_BPS = 200n; // -2% from the fill price
const MAX_HOLD_BARS = 120;

// A buy that would fill more than 1.5% above the latest close is rejected
// instead of chased; 1-minute moves almost never reach that far.
const MAX_SLIPPAGE_BPS = 150;

/** Closes of CBBTC, integer price-scale units, one per batch answered. */
const closes: (bigint | null)[] = [];
/** Fill price of the open position, same units; null while flat. */
let entryPrice: bigint | null = null;
/** Batch seq at which the buy filled; null while flat. */
let entrySeq: number | null = null;

/** Entry price implied by the position's cost basis (fallback only). */
function costBasisPrice(state: BarsState): bigint | null {
  const pos = state.positions.get(SYMBOL);
  if (pos === undefined || pos.qty <= 0n) return null;
  const sym = state.symbols.get(SYMBOL)!;
  const scale = state.hello.capital.quote_scale;
  return (pos.cost * 10n ** BigInt(sym.qty_scale + sym.price_scale)) / (pos.qty * 10n ** BigInt(scale));
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        entryPrice = BigInt(fill.price);
        entrySeq = state.seq;
      } else {
        entryPrice = null;
        entrySeq = null;
      }
    }

    const close = state.close(SYMBOL);
    if (close === null || state.warmingUp) return [];
    closes.push(close);

    const pos = state.positions.get(SYMBOL);
    if (pos !== undefined && pos.qty > 0n) {
      const entry = entryPrice ?? costBasisPrice(state);
      if (entry === null) return [];
      let reason: string | null = null;
      if (close * BPS >= entry * (BPS + TAKE_PROFIT_BPS)) reason = 'take-profit';
      else if (close * BPS <= entry * (BPS - STOP_LOSS_BPS)) reason = 'stop-loss';
      else if (entrySeq !== null && state.seq - entrySeq >= MAX_HOLD_BARS) reason = 'hold-cap';
      if (reason === null) return [];
      console.error(`sell ${reason} qty=${pos.qty} at close=${close}`);
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    // Flat: only buy a confirmed bounce after a sharp flush.
    const n = closes.length;
    if (n > DROP_LOOKBACK && n > BOUNCE_LOOKBACK) {
      const now = closes[n - 1]!;
      const then120 = closes[n - 1 - DROP_LOOKBACK]!;
      const then5 = closes[n - 1 - BOUNCE_LOOKBACK]!;
      const flushed = now * BPS <= then120 * (BPS - DROP_BPS);
      const bouncing = now * BPS >= then5 * (BPS + BOUNCE_BPS);
      if (flushed && bouncing && state.cash > 0n) {
        console.error(`buy flush+bounce close=${close} cash=${state.cash}`);
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
