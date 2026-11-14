# Active user budget guard — explicit resume update

Same visible gpt-6.1-sol, medium reasoning, one thread. No high/Ultra, parallel
Codex, provider substitution, new thread or banked-reset redemption.

Latest coordinator-supplied LIVE reading: 2026-11-14 02:40 PT;
primary.usedPercent=0, secondary.usedPercent=76, weekly remaining=24%.
This is the coordinator's live reading, not a tool reading performed by this
worker. It authorizes the resumed compact source-timing checkpoint.

At a new batch boundary, coordinator checks LIVE account/rateLimits/read.
Weekly remaining = 100 - secondary.usedPercent. The latest user instruction
supersedes the older strictly-below rule: HALT when remaining <=15%; explicit
resume requires remaining >15% and user approval. Do not start another batch
using a stale reading or redeem reset credits automatically.

This worker's exposed tool catalog still has no account/rateLimits/read method.
No live percentage is inferred from local logs or counters. No extra Codex
server/agent is launched to obtain usage. Report an auth/usage/provider crash
immediately. Ordinary compiler/test failures are diagnosed within the authorized
batch. Keep host incremental/debug outputs off and do not change phone profiles.

Comparison scripts remain parent/Gemini owned. No unreviewed integration,
self-merge, push, CI/Metro operation or intermediate phone/IPA checkpoint.

## Active override, 2026-11-14

User explicitly superseded **all 15% stops** and near-complete-only IPA rules.
Use the weekly allowance; at about10% remaining stop adding features and wrap up
with a passing checkpoint, independent review, and coordinator preparation of
**one parity-so-far IPA by about5%**. Coordinator remains sole push/build/CI owner.
No reset credits, high/Ultra, extra Codex workers, intermediate repeated IPAs or
unreviewed comparison-script merge. This supersedes the earlier paragraphs above.
Latest worker read of coordinator LIVE file: weekly used81 / remaining19%;
primary used32 / remaining68%. Budget source: /home/kit/rust-budget-latest.json.
Final physical phone performance is unverified until the user tests that IPA.
