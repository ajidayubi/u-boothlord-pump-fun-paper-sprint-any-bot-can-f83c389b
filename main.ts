// Entry point. The strategy lives in strategy.ts; the replay protocol (stdin/stdout,
// hello/batch/done) lives in the vendored SDK shim. Nothing to install: Node 22 runs
// this file as it is.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy as buildSniper, DEFAULT_PARAMS as TUNING } from './strategy.ts';

await runBot(buildSniper(TUNING));
