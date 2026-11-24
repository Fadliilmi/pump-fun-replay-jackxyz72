[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Fadliilmi/pump-fun-replay-jackxyz72/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Fadliilmi/pump-fun-replay-jackxyz72/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Fresh-pop tape rider

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity.

## How it trades

Most pump.fun curves die fast. This bot only buys once a curve's tape proves
real, spread-out demand: at least 4 buy trades from at least 4 distinct
buyers in the last 24 slots, net SOL flowing in, price up 4%+ and holding
near its window high, with the newer half of the window stronger than the
older half and no single wallet dominating the buys.

- First buy is small (0.06 SOL); it pyramids in 0.06 SOL adds only while the
  tape stays strong and the price keeps climbing, up to 0.18 SOL per coin.
- Exits are mechanical: 25% stop loss, an 18% trailing stop once the trade
  is up 30%, a fade exit when net SOL turns negative, an exit on any single
  sell of 2+ SOL, and a 600-slot time limit.
- A tiny probe trade keeps the run above the 20-coin guardrail minimum when
  momentum entries go quiet.

## Layout

- `main.ts` — entrypoint, wires the strategy to the replay harness.
- `strategy.ts` — the tape rider: tape tracking, entry/pyramid/exit rules.
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored unchanged.

Built for the make.fun competition `u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`.
