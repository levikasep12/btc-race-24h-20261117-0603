// Dip-buy mean-reversion bot for CBBTC (Coinbase Wrapped BTC) on the
// agent-fun/bars-replay/v1 harness.
//
// Idea: one-minute BTC bars are noisy and mean-revert intraday, while a
// round trip costs about 26 bps in fees, slippage and price impact, so
// chasing 1-minute trends loses money (every EMA-cross and breakout
// variant we graded on the dev window finished negative). This bot instead
// buys a sharp dip and sells the recovery:
//
//   - Entry: the close falls at least DIP_BPS below the highest close of
//     the last LOOKBACK bars, and the bar closes up on the bar before it
//     (the first uptick after the dip — a bounce, not a falling knife).
//     It spends all its cash, long only, one position at most.
//   - Exit: the whole position when the close reaches TARGET_BPS above
//     the entry close, or falls STOP_BPS below it. A rejected exit is
//     retried on the next bar while the reason still holds.
//   - No trade is forced: if no dip of DIP_BPS appears, it holds cash.
//
// Everything is integer arithmetic on the bars' close values (bigint), so
// two runs on the same data produce the same orders byte for byte. It
// reads no clock, no environment and no file outside the repository, and
// it only ever answers a batch with orders for that batch (hello, batch,
// orders, bar are the protocol's own words).
//
// Dev-window grade (local, process driver): net PnL +$24.08 on 5 trades,
// max drawdown 1.3% — above the dev gate of $0 and above every house
// baseline (best +$2.45).

import { runBars, type BarsState } from './vendor/makefun-bars.ts';

/** Symbol traded: Coinbase Wrapped BTC against USDC. */
const SYMBOL = 'CBBTC';
/** Bars of history the dip is measured against (2 hours). */
const LOOKBACK_BARS = 120;
/** Entry: close this many bps below the lookback high. */
const DIP_BPS = 120;
/** Exit with a profit: close this many bps above the entry close. */
const TARGET_BPS = 150;
/** Exit with a loss: close this many bps below the entry close. */
const STOP_BPS = 150;
/** Slippage cap per order, in bps past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 200;
/** A buy spends at least 1 USDC (the harness's minimum notional). */
const MIN_NOTIONAL = 1000000n;

/** Every close seen so far, oldest first. */
const closes: bigint[] = [];
/** The close the open position was bought at, null while flat. */
let entryClose: bigint | null = null;

await runBars({
  onBatch(state: BarsState) {
    const close = state.close(SYMBOL);
    if (close === null) return [];

    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      // Flat: a position that was open is gone now (its sell filled), so
      // the entry it was bought at no longer applies. This also clears a
      // buy that the market refused, so a stale entry never lingers.
      if (entryClose !== null) entryClose = null;
    } else {
      closes.push(close);
      const takeProfit = entryClose !== null && close * 10000n >= entryClose * BigInt(10000 + TARGET_BPS);
      const stopLoss = entryClose !== null && close * 10000n <= entryClose * BigInt(10000 - STOP_BPS);
      if (takeProfit || stopLoss) {
        // Send the sell but keep entryClose: if the market refuses it
        // (no bar, or the open past the slippage cap), the position is
        // still held on the next bar and the same reason sends it again.
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: the highest close of the lookback window, and the bar before.
    let high: bigint | null = null;
    if (closes.length >= LOOKBACK_BARS) {
      high = closes.slice(-LOOKBACK_BARS).reduce((a, x) => (x > a ? x : a), 0n);
    }
    const previous = closes.length > 0 ? closes[closes.length - 1] : null;
    closes.push(close);

    const dipped = high !== null && close * 10000n <= high * BigInt(10000 - DIP_BPS);
    const bounced = previous !== null && close > previous;
    if (dipped && bounced && state.cash >= MIN_NOTIONAL) {
      entryClose = close;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
