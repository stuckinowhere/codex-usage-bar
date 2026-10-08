# Token speed: last response and confidence checks

The main number is the **last valid model response**, not a streaming speed
and not the average of the whole turn. The tooltip keeps the weighted average
of up to ten accepted responses in this chat as a secondary comparison:
`sum(output tokens) / sum(measured seconds)`.

## What is measured

`src/speed.mjs` pairs `thread/tokenUsage/updated.last.outputTokens` with elapsed
renderer time since an observed turn start or the preceding response boundary.
It includes initial waiting and subtracts the union of complete, observed tool
intervals, so parallel tools are not subtracted twice. It checks `turnId` before
attributing an update and checks that the cumulative output counter increased
by exactly the reported last-response output count when a baseline is known.

Codex's desktop notification does **not** provide provider API start/end times.
Local token-usage records reviewed for this implementation also did not include
request duration. These intervals remain a proxy and are always marked `~`.
Network delivery, retries, unreported pauses, compaction, and overlapping model
and tool execution can affect the estimate. A valid sample is not a calibrated
measurement of provider throughput. History may span turns or model changes
within the same chat; the last response is the primary metric.

## Presentation

- During a running turn, the main number shows the last accepted response.
- Wide layouts show `last · Ns ago`. Compact layouts keep the explanation and
  age in the tooltip and accessibility label.
- Age refreshes every five seconds while a fresh sample is displayed. Samples
  aged 60 seconds or more display `—` at the next refresh; the tooltip identifies
  the stale sample. Timers are cleaned up on unmount and stop after expiry.
- The tooltip shows total output tokens, measured duration, weighted average,
  and separate reasoning/non-reasoning rates when a valid breakdown is supplied.
- **Non-reasoning output is not visible text:** it also includes tool-call output.
  Missing or inconsistent reasoning counts remain unknown rather than zero.
- Completion (including failed/interrupted turns), idle status, and a new turn
  clear the current number. A new turn needs its own fresh sample.

## Rejection and recovery

- Late updates from another turn are ignored before counters or timing change.
- Mid-turn attachment has no known start and cannot produce a first sample.
- Counter gaps, resets, malformed counts, short intervals (under 250ms),
  non-monotonic timing, and incomplete tool lifecycles invalidate the sample.
  Recovery requires a fresh, unambiguous response boundary.
- Usage arriving while tools are still running is discarded. Subsequent timing
  is re-established conservatively; samples may be unavailable in tool-heavy
  turns rather than infer a duration from uncertain ordering.
- Waiting-on-approval/user-input status invalidates the timing interval. The
  first response after that pause establishes a new boundary without a rate.
- Observable thread reattachment, `notLoaded`/`systemError` status, and account
  changes clear timing and history. Unsignalled reconnects cannot be detected
  reliably from this notification stream; counter checks reduce that risk.
- Duplicate counters do not create another sample. Equal rounded rates still
  publish their new timestamp so the UI never retains an old sample age.

All state is renderer-local, host/chat scoped and bounded. No message text,
credentials, provider requests, or persistent telemetry are recorded.

## Source contract and verification

The reviewed official protocol exposes
[threadId, turnId and tokenUsage](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTokenUsageUpdatedNotification.ts)
and separate
[output/reasoning counts](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/TokenUsageBreakdown.ts).
[Active flags](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadActiveFlag.ts)
identify approval/input waits. The shared observer is packaged by both the
macOS and Windows adapters; neither uses a separate speed algorithm.

Verification covers synthetic event lifecycle/rejection cases, both adapters'
packaged observer, and an isolated renderer fixture using host React. It does
not establish native installed-app UI acceptance or precise provider latency.

Verified for the 8 October 2026 speed update:

- 33 JavaScript tests, including late-turn counters, counter gaps, approval/input
  pauses, incomplete tools, stable snapshots, reasoning splits and expiry.
- 10 macOS/shared Python suites (55 unittest cases plus standalone install/worker
  scenarios), including actual packaged observer execution for both adapters.
- 35 width/font and 60 zoom/reference fixture layouts, four font regressions,
  existing diff/plan/spacing behavior, and real React timer age/expiry/refresh
  checks. No renderer errors. Fixture values are fictional.

The published change is source code; the earlier installed desktop mod is not
updated by pushing to GitHub. Rebuilding/reinstalling and native UI acceptance
are separate operations.

## Historical Hermes comparison

The previous implementation borrowed Hermes's weighted last-ten aggregate.
Hermes records canonical output counts and API duration per call; Codex desktop
notifications do not expose that same latency. The weighted formula is retained
only in the tooltip. The old first-to-last-text-delta estimator is not used,
because it omitted prefill and first-token waiting and could inflate speed.
