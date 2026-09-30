// A WALL-CLOCK GUARD ON ANY MACHINE. A guard like "the yard builds in under six seconds" is set on a
// quiet, fast machine; on a slower or busier one the same work takes longer and a fixed guard fails
// with nothing slower in the code. tools/selftest.py measures what the machine charges per unit of
// work right now and passes it as PEDON_TIMING_SCALE; a guard is that many times its quiet limit.
// Never less than the quiet limit: a fast machine does not tighten it.
export const TIMING_SCALE = Math.max(1, Number(process.env.PEDON_TIMING_SCALE) || 1);

/** A time limit in ms, set on a quiet machine, as it applies to this one. */
export const within = ms => ms * TIMING_SCALE;
