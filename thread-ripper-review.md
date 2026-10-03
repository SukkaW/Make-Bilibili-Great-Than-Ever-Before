# Thread-ripper review and simplification plan

Reviewed on 2026-10-02, on branch `thread-ripper` at `616d520`, including the uncommitted core-layer flattening. During the review, no repository files were changed.

I recommend **replacing the prediction layer with completion-driven scheduling**, while preserving the range assembler, response validation, and synthetic XHR lifecycle. Moving the existing machinery into fewer files has reduced wrappers, but it has left nearly all the difficult decisions intact.

## Current size and architecture

The current `src` is **7,284 lines**, down from the earlier ~7,988 figure. Its main components are:

| Component | Lines | Assessment |
|---|---:|---|
| Engine, range jobs, types, policy, validation | 1,991 | Biggest simplification opportunity |
| Host model and `WindowStats` | 950 | Too much inferred state |
| Interception, candidates, registry, observer | 1,331 | Useful foundation; some unnecessary abstraction |
| Debug metrics | 877 | Keep during comparison, shrink afterward |
| XHR override | 495 | Mostly justified compatibility code |
| Remaining source | 1,640 | Largely outside this refactor |

The architectural problem is **too many interacting mechanisms making the same decision**. Host estimates determine ownership, allocation, piece sizes, timeouts, rescue triggers, and split points. A poor estimate consequently affects almost everything.

The deadlines are especially questionable: “ordinary segment wanted in 1.5 seconds” is an invented scheduling target, with no knowledge of the player’s buffer. It then needs slack, urgency factors, rescue budgets, and exceptions to compensate.

## Confirmed defects

Three concrete problems are worth fixing independently of the rewrite:

1. **The six-try limit is bypassed while a duplicate remains alive.** The failed-primary branch increments `tries` and immediately requeues without checking the limit. A focused probe took a segment from five to eight failed tries while continuing to enqueue replacements. See [failure handling](src/modules/thread-ripper/engine.ts), line 499.

2. **Forced fallback attempts bypass the per-host cap.** `pump()` sends forced units directly to `launch()`, skipping the eligibility check. A focused probe launched a seventh request on a host already at six. See [the scheduler](src/modules/thread-ripper/engine.ts), line 605.

3. **One host’s 403 can invalidate an address globally, even after another host served it successfully.** If the refusing host previously accepted that signature family, the code bans the address across every host. I reproduced that state transition. The failure should initially belong to the host/address pair; the evidence does not justify a global ban. See [refusal handling](src/core/player/host-model.ts), line 638.

## Unnecessary coupling and state

- `bestAlternative()` calls candidate selection, which advances URL rotation. Merely asking whether help is available changes subsequent selection.
- Tail splitting calculates its split point using an alternative host, then queues the tail for fresh primary selection. The eventual destination need not match the calculation. See [the help path](src/modules/thread-ripper/engine.ts), line 809.
- Rescue budgets are consumed before confirming that help actually launches.
- `NORMAL` is never assigned; `writeChunk().waste` is never consumed; `MediaFileMatch.exact` and its address-history cache have no production consumer.
- Calling another request “alive” uses `host.active > 0`, which proves another request exists, rather than proving it is delivering bytes.

These are signs that the extra state is making behavior harder to reason about.

## Proposed replacement

1. **A bounded queue of moderately sized ranges.** Start with a small number of fixed size choices, benchmarked against the current implementation. Remove piece sizing based on predicted transfer time.

2. **Workers take more work when they finish.** Faster workers naturally complete more pieces. Keep global and per-host limits, including several simultaneous requests to the same good host.

3. **Requested and listed hosts get first access to work.** Explore additional mirrors through bounded races or small requests. An unknown mirror should not immediately receive a large, exclusive part of the response.

4. **Keep short races and cancel losers promptly.** Preserve the existing useful protection against first-byte latency without downloading every copy to completion.

5. **One path handles unfinished work.** A stalled attempt releases its unfinished bytes for retry. When the queue empties and a usable worker is idle, it can take part of the largest unfinished tail. Reserve the actual destination before shrinking the original segment.

6. **Use real clocks.** Retain the player’s XHR timeout and a simple inactivity timeout. Remove invented deadlines, ETA bands, soft/hard timeout hierarchies, weighted allocation credits, straggler/stale budgets, and predicted finish-time balancing.

7. **Keep a small reliability cache.** Track unavailable host/file/address combinations and bounded cooldowns. Remove cold-connection ratios, overshoot distributions, cross-representation factors, and outage penalty rollback.

This replaces the owners mechanism while preserving its practical purpose: avoiding a response whose completion depends on a large piece stranded on an unsuitable mirror.

## Behavior to preserve

- Page-realm allocation and contiguous segment frontiers.
- Comparing overlapping bytes before accepting them.
- Range and file-size validation.
- Resuming from the frontier after a partial failure.
- Abort, reopen, timeout, and event-handler reentrancy.
- Native fallback before headers are committed.
- Signature expiry, Akamai handling, and no-p2p URL conversion.

There is one existing validation exception to address explicitly: a 206 without readable `Content-Range` is accepted when its length matches and the file size is known. That establishes length, not the returned offset. Tightening it would change compatibility behavior, so it should be a separate, tested decision. See [response validation](src/modules/thread-ripper/classify.ts), line 27.

## Implementation order

| Step | Work | Expected result |
|---|---|---|
| 1 | Remove dead state and consolidate duplicate selection logic; fix the three defects separately | Small, reviewable changes |
| 2 | Replace allocation and overlapping rescue mechanisms with the worker queue and one unfinished-work path | Largest complexity reduction |
| 3 | Delete host-model machinery whose consumers disappeared | Remove whole concepts and their bookkeeping |
| 4 | Simplify warm-up/cache handling after measuring its startup contribution | Avoid speculative fetching of every representation |
| 5 | Reduce diagnostics after performance comparison is complete | Keep raw export and essential playback measurements |

**Keep the current metrics during steps 1–4.** They are debug-only and disappear from the production bundle; cutting them first would reduce source count while weakening verification.

## Estimated line budget

| Component | Target lines |
|---|---:|
| Thread-ripper implementation | 800–1,000 |
| Reliability/feedback state | 200–300 |
| Interceptor and media URL plumbing | 850–1,000 |
| XHR bridge | 450–500 |
| Reduced diagnostics | 250–350 |
| Remaining source | ~1,640 |
| **Whole `src`** | **~4,200–4,800** |

These are engineering estimates, not a reason to compress readable code or remove compatibility checks.

## Verification and performance acceptance

Performance parity needs verification. I inspected the surviving simulator archives; the `core` variant matches the reviewed working tree byte for byte. Its archived comparison contains 56 runs with no failed runs, but mixed playback and throughput results. That does not establish equivalence. Earlier ablations also give enough evidence to avoid assuming that simply deleting every measurement will preserve speed.

For the rewrite, compare pinned current and replacement builds across all six profiles, with alternating run order and repeated identical-build controls. Measure **startup, seeks, rebuffering, slowest segments, burst throughput, fetched bytes, and failures**.

Add focused fault cases for truncation, wrong ranges, inconsistent totals, host-local 403s, abort/reopen, and exhausted retries. Then verify through real playback, particularly thin links and Hi-Res audio.

TypeScript, focused lint checks, and in-memory production/debug bundling passed. The three defect probes confirmed the behavior described above. **The simplification design is ready; equivalent performance remains an acceptance criterion for its implementation.**
