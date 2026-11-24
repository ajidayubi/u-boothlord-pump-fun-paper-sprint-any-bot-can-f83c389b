// Launch sniper with a rug filter, for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Plain-words design. A coin is watched from the slot it is created. In its first
// slot the bot reads the opening tape: how much SOL the creator bought for
// themselves, how many outside wallets bought alongside them, whether the creator
// has already sold, and how much real SOL the curve holds. A launch only gets bought
// when it looks honest: the creator's own buy is small (a big creator buy is a dump
// waiting to happen), exactly two outside wallets showed up (one is nobody, three or
// more smells like the creator's own cluster), the creator has not sold, and the
// curve already holds at least a SOL of real money. The buy is one shot of 0.2 SOL
// in the coin's first slot, and never again for that coin. The bag then leaves whole
// at +50%, at -50%, after 60 slots, or the moment the creator sells. Nothing here
// reads the clock, the environment or any random source, and every loop walks a map
// in the order its entries arrived, so two runs take the same decisions.
//
// Money is carried in SOL as plain numbers; only at the order boundary is an amount
// turned into lamports. Slots are plain numbers too.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age, in slots since creation, at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to aim for per coin in total. */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for, in SOL. */
  minBuySol: number;
  /** Buys after the first one, each on a later batch, while the coin keeps qualifying. */
  maxAdds: number;
  /** An add needs the price at least this far above the previous buy's decision price (fraction). */
  addStep: number;
  /** An add waits this many slots after the previous buy was decided. */
  addDelay: number;
  /** SOL per add. */
  addSol: number;
  /** An add needs the recent net flow at least this (SOL). */
  addMinFlowSol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: SOL window. */
  minDevBuySol: number;
  maxDevBuySol: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** SOL sold by others / SOL bought, as a fraction, at most. */
  maxSellRatio: number;
  /** Largest single non-creator sell seen, as a fraction of the real SOL reserve before it, at most. */
  maxBigSell: number;
  /** Price now over the create price, as a fraction: window. */
  minRunup: number;
  maxRunup: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowSol: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys, in bps: a buy whose price jumps more than this in the latency is refused. */
  buySlippageBps: number;
  /** First take-profit: sell tp1Part of the bag once it is worth tp1 over its cost (fractions). */
  tp1: number;
  tp1Part: number;
  /** After the first take-profit, the rest stops out at this much under its cost (fraction; negative = above). */
  slAfterTp1: number;
  /** Exit when the bag is worth this much over its cost (fraction). */
  tp: number;
  /** Exit when it is worth this much under its cost (fraction). */
  sl: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value (fractions). */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many SOL. */
  exitFlowSol: number;
}

// Tuned on the dev window with the kit's simulator, preferring a flat,
// interpretable region over the single best cell: buy only in a coin's first slot,
// only when exactly two outside wallets bought with a creator who bought at most
// 1 SOL themselves, 0.2 SOL a coin, out at +50% or -50% or after 60 slots, and out
// at once when the creator sells. Full-window sim: +0.115 SOL over 67 coins,
// max drawdown 1.2%. Grade-local on the same settings: +0.123 SOL.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 1,
  stakeSol: 0.2,
  minBuySol: 0.005,
  maxAdds: 0,
  addStep: 0,
  addDelay: 2,
  addSol: 0.1,
  addMinFlowSol: 0,
  minRealSol: 1,
  maxRealSol: 30,
  minDevBuySol: 0,
  maxDevBuySol: 1,
  minTrades: 0,
  minBuyers: 2,
  maxBuyers: 2,
  maxSellRatio: 1,
  maxBigSell: 1,
  minRunup: -1,
  maxRunup: 99,
  flowWindow: 10,
  minFlowSol: -1000,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tp1: 100,
  tp1Part: 0.5,
  slAfterTp1: 0,
  tp: 0.5,
  sl: 0.5,
  trailArm: 100,
  trail: 0.1,
  maxHold: 60,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowSol: 1000,
};

const LAMPORTS = 1e9;
/** Curve fee on every trade (protocol 0.95% + creator 0.30%). */
const CURVE_FEE = 0.0125;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: Pubkey;
}

interface Launch {
  mint: Pubkey;
  bornSlot: number;
  creator: Pubkey;
  /** Opening reserves: the price run-up is measured against them. */
  openVq: number;
  openVt: number;
  devBuySol: number;
  trades: number;
  buyers: Set<Pubkey>;
  boughtSol: number;
  soldByOthersSol: number;
  biggestDump: number;
  creatorSold: boolean;
  lastTouchSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  ticks: Tick[];
  buysSent: number;
  spentSol: number;
  /** Decision price (SOL per token) of the last buy sent. */
  lastBuyPrice: number;
  lastBuySlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Bag {
  openedSlot: number;
  txPaidSol: number;
  bestSol: number;
  creatorSoldAtOpen: boolean;
  tookTp1: boolean;
}

/** What selling `tokens` against virtual reserves (vq, vt) would pay, in SOL, after the curve fee. */
function sellProceeds(tokens: number, vq: number, vt: number): number {
  if (tokens <= 0 || vt <= 0) return 0;
  return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const P = params;
  const openings = new Map<Pubkey, Launch>();
  const bags = new Map<Pubkey, Bag>();
  /** Mints with a sell in flight. */
  const leaving = new Set<Pubkey>();
  const stake = P.stakeSol;
  const minBuy = P.minBuySol;

  function noteEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        openings.set(e.mint, {
          mint: e.mint,
          bornSlot: e.slot,
          creator: e.creator,
          openVq: Number(e.virtual_quote_reserves),
          openVt: Number(e.virtual_token_reserves),
          devBuySol: 0,
          trades: 0,
          buyers: new Set(),
          boughtSol: 0,
          soldByOthersSol: 0,
          biggestDump: 0,
          creatorSold: false,
          lastTouchSlot: e.slot,
          ticks: [],
          buysSent: 0,
          spentSol: 0,
          lastBuyPrice: 0,
          lastBuySlot: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = openings.get(e.mint);
        if (c === undefined) continue;
        const sol = Number(e.sol_amount) / LAMPORTS;
        c.trades += 1;
        c.lastTouchSlot = e.slot;
        c.ticks.push({
          slot: e.slot,
          isBuy: e.is_buy,
          sol,
          user: e.user,
        });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.boughtSol += sol;
          if (isDev && e.slot === c.bornSlot) c.devBuySol += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.creatorSold = true;
        } else {
          c.soldByOthersSol += sol;
          const reserveBefore = Number(e.real_quote_reserves) / LAMPORTS + sol;
          if (reserveBefore > 0) {
            const share = sol / reserveBefore;
            if (share > c.biggestDump) c.biggestDump = share;
          }
        }
      } else {
        const c = openings.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net SOL bought minus sold, and distinct outside buyers, over the last flowWindow slots. */
  function recentFlow(c: Launch, slot: number): { netSol: number; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.ticks.length && c.ticks[drop]!.slot <= from) drop++;
    if (drop > 0) c.ticks.splice(0, drop);
    let netSol = 0;
    const buyers = new Set<Pubkey>();
    for (const t of c.ticks) {
      if (t.isBuy) {
        netSol += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        netSol -= t.sol;
      }
    }
    return { netSol, buyers: buyers.size };
  }

  function buyPending(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy') return true;
    }
    return false;
  }

  function sellPending(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'sell') return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      noteEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map<Pubkey, { vq: number; vt: number }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: Number(m.virtual_quote_reserves), vt: Number(m.virtual_token_reserves) });
      }

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          bags.delete(f.mint);
          leaving.delete(f.mint);
          continue;
        }
        const b = bags.get(f.mint);
        if (f.status !== 'rejected' && b !== undefined) b.txPaidSol += Number(f.tx_fee_lamports) / LAMPORTS;
        if (f.side === 'buy' && f.status === 'filled' && b === undefined) {
          bags.set(f.mint, {
            openedSlot: f.slot,
            txPaidSol: Number(f.tx_fee_lamports) / LAMPORTS,
            bestSol: 0,
            creatorSoldAtOpen: openings.get(f.mint)?.creatorSold ?? false,
            tookTp1: false,
          });
        }
      }
      for (const mint of [...leaving]) {
        if (!sellPending(state, mint)) leaving.delete(mint);
      }
      for (const mint of [...bags.keys()]) {
        if (!state.positions.has(mint) && !leaving.has(mint) && !buyPending(state, mint)) {
          bags.delete(mint);
        }
      }

      // Bags leave first, whole, on the first trigger that fires.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (leaving.has(mint)) continue;
        const c = openings.get(mint);
        let b = bags.get(mint);
        if (b === undefined) {
          b = { openedSlot: state.slot, txPaidSol: txSol, bestSol: 0, creatorSoldAtOpen: c?.creatorSold ?? false, tookTp1: false };
          bags.set(mint, b);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const curve = state.curves.get(mint);
          if (curve === undefined) continue;
          mk = { vq: Number(curve.virtual_quote_reserves), vt: Number(curve.virtual_token_reserves) };
        }
        const worth = sellProceeds(Number(pos.token_amount), mk.vq, mk.vt) - txSol;
        const basis = Number(pos.cost_lamports) / LAMPORTS + b.txPaidSol;
        if (worth > b.bestSol) b.bestSol = worth;
        let leave = false;
        if (basis > 0) {
          if (!b.tookTp1 && worth >= basis * (1 + P.tp1)) {
            const part = Number(pos.token_amount) * P.tp1Part;
            if (part > 0 && part < Number(pos.token_amount)) {
              orders.push({ side: 'sell', mint, token_amount: BigInt(Math.floor(part)), max_slippage_bps: 10_000 });
              leaving.add(mint);
              b.tookTp1 = true;
              b.bestSol = 0;
              if (c !== undefined) c.done = true;
              continue;
            }
          }
          if (worth >= basis * (1 + P.tp)) leave = true;
          const stop = b.tookTp1 ? P.slAfterTp1 : P.sl;
          if (worth <= basis * (1 - stop)) leave = true;
          if (b.bestSol >= basis * (1 + P.trailArm) && worth <= b.bestSol * (1 - P.trail)) leave = true;
        }
        if (state.slot - b.openedSlot >= P.maxHold) leave = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.creatorSold && !b.creatorSoldAtOpen) leave = true;
          if (state.slot - c.lastTouchSlot >= P.staleSlots) leave = true;
          if (recentFlow(c, state.slot).netSol < -P.exitFlowSol) leave = true;
        }
        if (!leave) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        leaving.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries and adds.
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS - txSol * orders.length;
      let open = state.committedPositionCount();
      for (const c of openings.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.bornSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd && age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (isAdd) {
          if (c.buysSent > P.maxAdds) continue;
          if (!state.positions.has(c.mint) || leaving.has(c.mint) || buyPending(state, c.mint)) continue;
        } else if (open >= state.hello.caps.max_open_positions) {
          continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.creatorSold && (P.skipDevSold || isAdd)) {
          if (!isAdd) c.done = true;
          continue;
        }
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        if (isAdd) {
          if (state.slot - c.lastBuySlot < P.addDelay) continue;
          if (vq / vt < c.lastBuyPrice * (1 + P.addStep)) continue;
          if (recentFlow(c, state.slot).netSol < P.addMinFlowSol) continue;
          const maxAdd = Number(state.maxBuyLamports(c.mint)) / LAMPORTS;
          const amount = Math.min(P.addSol, maxAdd);
          if (amount < minBuy || freeSol < amount + txSol) continue;
          orders.push({
            side: 'buy',
            mint: c.mint,
            quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
            max_slippage_bps: P.buySlippageBps,
          });
          freeSol -= amount + txSol;
          c.buysSent += 1;
          c.spentSol += amount;
          c.lastBuyPrice = vq / vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        // Rug filter: only honest-looking launches get the buy.
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (realSol < P.minRealSol || realSol > P.maxRealSol) continue;
        if (c.devBuySol < P.minDevBuySol || c.devBuySol > P.maxDevBuySol) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.boughtSol > 0 && c.soldByOthersSol > c.boughtSol * P.maxSellRatio) continue;
        if (c.biggestDump > P.maxBigSell) continue;
        const runup = vq * c.openVt / (vt * c.openVq) - 1;
        if (runup > P.maxRunup || runup < P.minRunup) continue;
        const fl = recentFlow(c, state.slot);
        if (fl.netSol < P.minFlowSol || fl.buyers < P.minRecentBuyers) continue;
        const room = stake - c.spentSol;
        if (room < minBuy) continue;
        const maxBuy = Number(state.maxBuyLamports(c.mint)) / LAMPORTS;
        const amount = Math.min(room, maxBuy);
        if (amount < minBuy) continue;
        if (freeSol < amount + txSol) continue;
        orders.push({
          side: 'buy',
          mint: c.mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: P.buySlippageBps,
        });
        freeSol -= amount + txSol;
        c.buysSent += 1;
        c.spentSol += amount;
        c.lastBuyPrice = vq / vt;
        c.lastBuySlot = state.slot;
        open += 1;
      }
      return orders;
    },
  };
}
