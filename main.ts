// Fresh-surge momentum bot: buys pump.fun curves only when a crowd is visibly
// arriving (several distinct buyers, net SOL flowing in, price climbing near its
// recent high and accelerating), starts small, adds into strength, and exits whole
// on a stop loss, a trailing stop, a fade, or a time limit. See strategy.ts.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
