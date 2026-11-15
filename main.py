"""V-bounce catcher for cbBTC/USDC (agent-fun/bars-replay/v1).

Strategy, in one paragraph: BTC on 1-minute bars spends most of its day
drifting and then snaps back hard after a sharp flush. This bot sits in cash
and only buys after a real washout that has already started to bounce: the
close is at least 1.8% below where it was 120 bars ago AND at least 0.4%
above where it was 5 bars ago. It buys with all of its cash, then exits on
whichever comes first: +4% take-profit, -2% stop-loss, or 120 bars held.
One position at a time, long only, no leverage, no shorts. Every comparison
is integer arithmetic on the bar closes, so two runs on the same bars give
the same orders; there is no clock, no randomness and no network.

Why these numbers (tuned on the frozen 24h dev window, 1,440 bars):
- the 5-minute bounce confirmation is the whole edge: without it the same
  dip rule loses money buying into a falling knife, with it the rule clears
  about +$49 on the dev window in 3 round trips with 1.4% max drawdown;
- the take-profit at +4% lets the one big snap-back of the window pay for
  the round trip cost (about 26 bps all-in per full-size round trip);
- the 120-bar hold cap stops a position from bleeding through a slow grind.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bars

SYMBOL = "CBBTC"

# Entry: sharp 120-bar flush that has already turned up on the 5-bar tape.
DROP_LOOKBACK = 120
DROP_BPS = 180          # close <= 120 bars ago * (1 - 1.8%)
BOUNCE_LOOKBACK = 5
BOUNCE_BPS = 40         # close >= 5 bars ago * (1 + 0.4%)

# Exit: first of take-profit, stop-loss, hold cap.
TAKE_PROFIT_BPS = 400   # +4% from the fill price
STOP_LOSS_BPS = 200     # -2% from the fill price
MAX_HOLD_BARS = 120

# A buy that would fill more than 1.5% above the latest close is rejected
# instead of chased; 1-minute moves almost never reach that far.
MAX_SLIPPAGE_BPS = 150

BPS = 10000

_closes = []            # closes of CBBTC, integer price-scale units
_entry_price = None     # fill price of the open position, same units
_entry_seq = None       # batch seq at which the buy filled
_trades = 0             # filled orders this run (fills reported in batches)


def _cost_basis_price(state):
    """Entry price implied by the position's cost basis (fallback only)."""
    pos = state.positions.get(SYMBOL)
    if pos is None or pos.qty <= 0:
        return None
    sym = state.symbols[SYMBOL]
    scale = state.hello["capital"]["quote_scale"]
    price = pos.cost * 10 ** (sym["qty_scale"] + sym["price_scale"])
    price //= pos.qty * 10 ** scale
    return price


def on_batch(state, batch):
    """Decide the orders for one batch: one bar just closed, fills from the
    previous batch's orders are in batch['fills']."""
    global _entry_price, _entry_seq, _trades

    for fill in batch.get("fills", []):
        if fill.get("status") != "filled" or fill.get("symbol") != SYMBOL:
            continue
        _trades += 1
        if fill.get("side") == "buy":
            _entry_price = int(fill["price"])
            _entry_seq = state.seq
        else:
            _entry_price = None
            _entry_seq = None

    close = state.close(SYMBOL)
    if close is None or state.warming_up:
        return []
    _closes.append(close)

    holding = SYMBOL in state.positions and state.positions[SYMBOL].qty > 0
    if holding:
        entry = _entry_price
        if entry is None:
            entry = _cost_basis_price(state)
        if entry is None:
            return []
        if close * BPS >= entry * (BPS + TAKE_PROFIT_BPS):
            reason = "take-profit"
        elif close * BPS <= entry * (BPS - STOP_LOSS_BPS):
            reason = "stop-loss"
        elif _entry_seq is not None and state.seq - _entry_seq >= MAX_HOLD_BARS:
            reason = "hold-cap"
        else:
            return []
        qty = state.positions[SYMBOL].qty
        sys.stderr.write("sell %s qty=%d at close=%d\n" % (reason, qty, close))
        return [{"side": "sell", "symbol": SYMBOL, "qty": qty,
                 "max_slippage_bps": MAX_SLIPPAGE_BPS}]

    # Flat: only buy a confirmed bounce after a sharp flush.
    n = len(_closes)
    if n > DROP_LOOKBACK and n > BOUNCE_LOOKBACK:
        flushed = _closes[-1] * BPS <= _closes[-1 - DROP_LOOKBACK] * (BPS - DROP_BPS)
        bouncing = _closes[-1] * BPS >= _closes[-1 - BOUNCE_LOOKBACK] * (BPS + BOUNCE_BPS)
        if flushed and bouncing and state.cash > 0:
            sys.stderr.write("buy flush+bounce close=%d cash=%d\n" % (close, state.cash))
            return [{"side": "buy", "symbol": SYMBOL,
                     "notional_quote_units": state.cash,
                     "max_slippage_bps": MAX_SLIPPAGE_BPS}]
    return []


makefun_bars.run(on_batch)
