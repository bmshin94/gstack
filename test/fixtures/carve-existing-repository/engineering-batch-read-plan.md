# Plan: ordered batch reads for the reconciliation CLI

## Context and scope

Read `README.md`, `src/repository.ts`, and `example.ts` for the existing private
CounterRepository, its runtime, and its error contract. The CLI currently calls
`get` separately for each counter. Add a convenient ordered batch-read method;
this is an API convenience, not a database-load or latency optimization. The
existing methods and runnable example must keep working.

## Proposed behavior — subject to this review

Add `getMany(keys: readonly string[]): Array<number | undefined>` to
CounterRepository. This method is not implemented or approved. The proposed
implementation calls the existing `get` once for each input key, in input order.
Return one result per key in that same order, retaining duplicate keys and
`undefined` results for absent counters. An empty input returns an empty array
without querying SQLite.

Each nonempty read must use the existing key validation and SQLite read path.
Propagate the first validation or database error unchanged; do not convert an
error into `undefined` or return partial success. In particular, reading a key
after the database closes must still fail. Do not cache values, copy the caller's
write values, or change `get`/`set` behavior. This sequence of point reads does not
promise an atomic snapshot or add a transaction.

## Implementation and proof to plan

Review the method's type and control flow, its call-site use in the CLI, and tests
for empty input, ordered known/missing results, duplicates, zero values, invalid
keys, and database errors. Include a trace that writes between separate batch
calls so the later call observes the current stored value. Preserve the existing
numeric round trips and example. These are required tests to plan, not tests
already implemented or passing.

The proposed implementation performs one SELECT per input key and allocates an
output array proportional to the input length. Assess that cost and any relevant
limits for this internal synchronous API; do not claim a measured speedup.
Caching, shared invalidation state, SQL batching, new public packaging, and
background processing are outside this change. Surface any real incompatibility
with the requested method rather than assuming the baseline contract away.
