// Fresh-pop tape rider — entrypoint for the pump.fun replay sprint.
//
// The hello message hands us the capital, caps and fees; every batch after
// that carries the slot, the events, the marks and the fills. All decisions
// live in strategy.ts (TapeRider.decide); this file only wires it to the
// replay harness via the vendored SDK shim.

import { runBot } from './vendor/makefun-bot.ts';
import { TapeRider } from './strategy.ts';

const rider = new TapeRider();

await runBot({
  onBatch(state, batch) {
    return rider.decide(state, batch);
  },
});
