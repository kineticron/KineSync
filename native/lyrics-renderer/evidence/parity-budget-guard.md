# Active user budget guard

Runtime identifies this worker as gpt-6.1-sol, medium reasoning, one visible thread.
No subagent or parallel Codex work is authorized; comparison belongs to the parent's
Gemini task, not another Codex worker. No provider substitution or banked reset.

At natural batch boundaries before new build cycles, discover and read LIVE
`account/rateLimits/read` if available. Compute weekly remaining as
`100 - secondary.usedPercent`. If LIVE remaining is STRICTLY BELOW15%, stop all
Codex work immediately and report; exactly15% is not below. Resume requires user
approval. Do not mistake stale logs, local counters or user estimates for LIVE.

First discovery in this active batch: no account/rateLimits/read tool exists in
the available tool catalog (searched account/rate-limit/usage/quota metadata).
LIVE reading is unavailable, percentage UNKNOWN. User's reported33% remaining is
context only, not verified. No banked reset or alternate provider was used.
Recheck availability at the next natural build batch boundary; report any live
result precisely. Avoid launching another Codex agent/server to obtain counters.

Continue frugally with batched runtime fixes, targeted meaningful tests, bounded
host build storage and source/numeric evidence once the parent-owned script lands.
