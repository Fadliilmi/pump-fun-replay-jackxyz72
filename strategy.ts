// Fresh-pop tape rider for the pump.fun replay sprint.
//
// Idea: most pump.fun curves die fast, but the ones that attract real,
// spread-out buying in their first minutes sometimes run. This bot only
// buys a curve once its tape proves that: several distinct buyers, net SOL
// flowing in, price rising and holding near its recent high, with the newer
// half of the window stronger than the older half. The first buy is small;
// it adds only while the tape stays strong and the price keeps climbing.
// Every exit is mechanical: a stop loss, a trailing stop once the trade is
// up, a fade exit when the tape turns, or a hard time limit.
//
// v2 sizing (after the dev grade): the dev window punishes size — the first
// version lost 3.35 SOL on 0.06 SOL starters, and the kit's own tuned
// momentum/reversion pilots lost 9.49 / 4.00 SOL. Stakes are halved
// (0.03 SOL first buy, 0.09 max), entries are stricter, and exits are
// tighter, so the bot keeps its shot at a runner while bleeding far less
// on the many coins that fade.
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.

import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000; // lamports per SOL, as a plain number for tape maths

// --- tunables (chosen by hand, then checked on the dev window) ---
const ENTRY_WINDOW_SLOTS = 24;
const MIN_AGE_SLOTS = 8;
const MIN_BUYS = 4;
const MIN_BUYERS = 6;
const MIN_NET_SOL = 2.5;
const MIN_PRICE_UP = 0.08;
const MAX_PRICE_UP = 1.2;
const NEAR_HIGH = 0.95;
const MAX_BUYER_SHARE = 0.45;
const MIN_REAL_SOL = 0.5;
const MAX_REAL_SOL = 60;
const INITIAL_SOL = 0.02;
const ADD_SOL = 0.02;
const MAX_STAKE_SOL = 0.06;
const ADD_PRICE_STEP = 0.03;
const BUY_SLIPPAGE_BPS = 5000;
const SELL_SLIPPAGE_BPS = 10000;
const STOP_LOSS = 0.12;
const TRAIL_ARM = 0.15;
const TRAIL_DROP = 0.10;
const MAX_HOLD_SLOTS = 240;
const FADE_WINDOW_SLOTS = 24;
const FADE_NET_SOL = -0.8;
const BIG_SELL_SOL = 2;
const COOLDOWN_SLOTS = 120;
const MAX_ENTRIES_PER_COIN = 2;
const MAX_MAIN_POSITIONS = 3;
const PROBE_SOL = 0.02;
const PROBE_AFTER_BATCHES = 1200;
const PROBE_MIN_COINS = 20;

interface TapeTrade {
  slot: number;
  price: number; // SOL per token, from post-trade virtual reserves
  sol: number; // SOL moved by this trade
  buy: boolean;
  user: Pubkey;
}

interface CoinState {
  createdSlot: number | null;
  tape: TapeTrade[];
  entries: number;
  cooldownUntil: number;
  firstBuySlot: number;
  lastBuyPrice: number;
  spentSol: number;
  peakValueSol: number;
  probe: boolean;
}

function newCoin(): CoinState {
  return {
    createdSlot: null,
    tape: [],
    entries: 0,
    cooldownUntil: 0,
    firstBuySlot: 0,
    lastBuyPrice: 0,
    spentSol: 0,
    peakValueSol: 0,
    probe: false,
  };
}

/** Current price of a curve in SOL per token, from its virtual reserves. */
function curvePrice(state: BotState, mint: Pubkey): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const tokens = Number(curve.virtual_token_reserves);
  const quote = Number(curve.virtual_quote_reserves);
  if (tokens <= 0 || quote <= 0) return 0;
  return quote / tokens;
}

/** Value in SOL of holding `tokens` of this mint right now. */
function holdingValueSol(state: BotState, mint: Pubkey, tokens: bigint): number {
  return Number(tokens) * curvePrice(state, mint);
}

/** Net SOL (buys minus sells) and friends over the tape slice in a slot window. */
function windowStats(tape: TapeTrade[], fromSlot: number) {
  let net = 0;
  let buys = 0;
  let buySol = 0;
  const buyers = new Map<Pubkey, number>();
  let high = 0;
  let firstPrice = 0;
  let lastPrice = 0;
  let firstSeen = false;
  let midNet = 0;
  let lateNet = 0;
  const midSlot = fromSlot + ENTRY_WINDOW_SLOTS / 2;
  for (const t of tape) {
    if (t.slot < fromSlot) continue;
    if (!firstSeen) {
      firstPrice = t.price;
      firstSeen = true;
    }
    lastPrice = t.price;
    if (t.price > high) high = t.price;
    const signed = t.buy ? t.sol : -t.sol;
    net += signed;
    if (t.slot < midSlot) midNet += signed;
    else lateNet += signed;
    if (t.buy) {
      buys += 1;
      buySol += t.sol;
      buyers.set(t.user, (buyers.get(t.user) ?? 0) + t.sol);
    }
  }
  let topShare = 0;
  for (const v of buyers.values()) if (buySol > 0 && v / buySol > topShare) topShare = v / buySol;
  return { net, buys, buyers: buyers.size, buySol, topShare, high, firstPrice, lastPrice, midNet, lateNet };
}

export class TapeRider {
  private coins = new Map<Pubkey, CoinState>();
  private batchesSeen = 0;
  private coinsTraded = new Set<Pubkey>();
  private fillsSeen = 0;
  private probeMint: Pubkey | null = null;

  private coin(mint: Pubkey): CoinState {
    let c = this.coins.get(mint);
    if (c === undefined) {
      c = newCoin();
      this.coins.set(mint, c);
    }
    return c;
  }

  decide(state: BotState, batch: Batch): OrderInput[] {
    this.batchesSeen += 1;
    const orders: OrderInput[] = [];
    const slot = batch.slot;
    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();

    // --- fold this batch's events into the tapes ---
    for (const e of batch.events) {
      const c = this.coin(e.mint);
      if (e.event === 'CreateEvent') {
        c.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const tokens = Number(e.virtual_token_reserves);
        const quote = Number(e.virtual_quote_reserves);
        const price = tokens > 0 && quote > 0 ? quote / tokens : 0;
        c.tape.push({
          slot: e.slot,
          price,
          sol: Number(e.sol_amount) / SOL,
          buy: e.is_buy,
          user: e.user,
        });
        if (c.tape.length > 48) c.tape.splice(0, c.tape.length - 48);
      }
    }
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        this.fillsSeen += 1;
        this.coinsTraded.add(f.mint);
        if (f.side === 'buy') {
          const c = this.coin(f.mint);
          if (c.firstBuySlot === 0) c.firstBuySlot = slot;
          c.spentSol += Number(f.quote_lamports) / SOL;
          const price = curvePrice(state, f.mint);
          if (price > 0) c.lastBuyPrice = price;
        }
        if (f.side === 'sell') {
          const c = this.coin(f.mint);
          c.spentSol = 0;
          c.peakValueSol = 0;
          c.cooldownUntil = slot + COOLDOWN_SLOTS;
          if (this.probeMint === f.mint) this.probeMint = null;
        }
      }
    }

    // --- exits first: never hold a loser while looking for entries ---
    for (const [mint, holding] of state.positions) {
      const c = this.coins.get(mint);
      if (c === undefined) continue;
      const price = curvePrice(state, mint);
      if (price <= 0) continue;
      const value = Number(holding.token_amount) * price;
      const cost = Number(holding.cost_lamports) / SOL;
      if (value > c.peakValueSol) c.peakValueSol = value;
      const stats = windowStats(c.tape, slot - FADE_WINDOW_SLOTS);
      const recent = c.tape.slice(-6);
      const bigSell = recent.some((t) => !t.buy && t.sol >= BIG_SELL_SOL);
      const stopHit = cost > 0 && value < cost * (1 - STOP_LOSS);
      const trailHit =
        c.peakValueSol > 0 &&
        cost > 0 &&
        c.peakValueSol >= cost * (1 + TRAIL_ARM) &&
        value < c.peakValueSol * (1 - TRAIL_DROP);
      const timeHit = c.firstBuySlot > 0 && slot - c.firstBuySlot > MAX_HOLD_SLOTS;
      const fadeHit = stats.net < FADE_NET_SOL;
      if (stopHit || trailHit || timeHit || fadeHit || bigSell) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }
    const selling = new Set(orders.filter((o) => o.side === 'sell').map((o) => o.mint));

    // --- entries and pyramid adds ---
    let free = state.freeCashLamports();
    let mainOpen = 0;
    for (const m of state.positions.keys()) if (!selling.has(m)) mainOpen += 1;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') mainOpen += 1;
    }

    const seenThisBatch: Pubkey[] = [];
    for (const e of batch.events) {
      if (!seenThisBatch.includes(e.mint)) seenThisBatch.push(e.mint);
    }
    for (const mint of seenThisBatch) {
      if (orders.length >= caps.max_orders_per_batch) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = this.coin(mint);
      const holding = state.positions.get(mint);
      const price = curvePrice(state, mint);
      if (price <= 0) continue;

      // Pyramid: add to a live winner while the tape still flows in.
      if (holding !== undefined && !selling.has(mint)) {
        if (c.spentSol < MAX_STAKE_SOL - 0.001 && price >= c.lastBuyPrice * (1 + ADD_PRICE_STEP)) {
          const stats = windowStats(c.tape, slot - ENTRY_WINDOW_SLOTS);
          if (stats.net > 0 && stats.buys >= 2) {
            const addLamports = BigInt(Math.round(ADD_SOL * SOL));
            const cap = state.maxBuyLamports(mint);
            const amount = addLamports < cap ? addLamports : cap;
            if (amount >= BigInt(Math.round(0.01 * SOL)) && free >= amount + txFee) {
              orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
              free -= amount + txFee;
            }
          }
        }
        continue;
      }
      if (holding !== undefined || selling.has(mint)) continue;
      if (c.entries >= MAX_ENTRIES_PER_COIN) continue;
      if (slot < c.cooldownUntil) continue;
      if (mainOpen >= MAX_MAIN_POSITIONS) continue;
      if (c.createdSlot === null || slot - c.createdSlot < MIN_AGE_SLOTS) continue;
      const realSol = Number(curve.real_quote_reserves) / SOL;
      if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
      const stats = windowStats(c.tape, slot - ENTRY_WINDOW_SLOTS);
      if (stats.buys < MIN_BUYS) continue;
      if (stats.buyers < MIN_BUYERS) continue;
      if (stats.net < MIN_NET_SOL) continue;
      if (stats.firstPrice <= 0) continue;
      const rise = stats.lastPrice / stats.firstPrice - 1;
      if (rise < MIN_PRICE_UP || rise > MAX_PRICE_UP) continue;
      if (stats.high <= 0 || stats.lastPrice < stats.high * NEAR_HIGH) continue;
      if (stats.lateNet < stats.midNet) continue;
      if (stats.topShare > MAX_BUYER_SHARE) continue;
      const amountLamports = BigInt(Math.round(INITIAL_SOL * SOL));
      const cap = state.maxBuyLamports(mint);
      const amount = amountLamports < cap ? amountLamports : cap;
      if (amount < BigInt(Math.round(0.01 * SOL))) continue;
      if (free < amount + txFee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + txFee;
      mainOpen += 1;
      c.entries += 1;
    }

    // --- guardrail probe: keep the run above 20 coins when entries go quiet ---
    if (
      this.batchesSeen > PROBE_AFTER_BATCHES &&
      this.coinsTraded.size < PROBE_MIN_COINS &&
      this.probeMint === null &&
      orders.length < caps.max_orders_per_batch
    ) {
      let bestMint: Pubkey | null = null;
      let bestReal = 0;
      for (const [mint, curve] of state.curves) {
        if (curve.complete || state.positions.has(mint)) continue;
        const real = Number(curve.real_quote_reserves) / SOL;
        if (real > bestReal && real >= 1) {
          bestReal = real;
          bestMint = mint;
        }
      }
      if (bestMint !== null) {
        const amount = BigInt(Math.round(PROBE_SOL * SOL));
        const cap = state.maxBuyLamports(bestMint);
        const sized = amount < cap ? amount : cap;
        if (sized >= BigInt(Math.round(0.01 * SOL)) && free >= sized + txFee) {
          const c = this.coin(bestMint);
          c.probe = true;
          this.probeMint = bestMint;
          orders.push({ side: 'buy', mint: bestMint, quote_lamports: sized, max_slippage_bps: BUY_SLIPPAGE_BPS });
          free -= sized + txFee;
        }
      }
    }
    // Sell a probe as soon as its buy lands.
    if (this.probeMint !== null) {
      const holding = state.positions.get(this.probeMint);
      const c = this.coins.get(this.probeMint);
      if (holding !== undefined && c !== undefined && c.probe && !selling.has(this.probeMint)) {
        orders.push({
          side: 'sell',
          mint: this.probeMint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    return orders;
  }
}
