# Token and cost history

Snapshot 2026-09-02. Per-key detail in `usage-by-key.csv`.
Cost model: flat **$0.80 per successful task** (Opus 5). Earlier tasks on the retired
Opus 4.8 models were billed at **$0.50**. Failed requests were never charged.
Caveat: some tasks were billed that delivered empty or truncated streams, so `spent`
runs slightly high.

## Totals

| | |
|---|---|
| Credit loaded | $3,780.00 |
| Spent | $1,423.00 |
| Remaining | $2,357.00 |
| Tasks (successful) | 2,759 |
| Input tokens | 646,026,951 |
| Output tokens | 827,144 |
| Total tokens | 646,854,095 |

Accounts: 30 — 20 loaded at $129, 10 at $120.

## By model

| Model | Tasks | Input tokens | Output tokens |
|---|---|---|---|
| claude-opus-4-8-thinking | 2,337 | 609,012,284 | 784,307 |
| claude-opus-4-8 | 277 | 21,140,520 | 25,061 |
| claude-opus-5-thinking | 86 | 15,435,514 | 13,615 |
| claude-opus-5 | 59 | 438,633 | 4,161 |

Opus 4.8 accounted for 2,614 of 2,759 tasks and ~97% of all tokens before it was retired
on 2026-09-01.

Input/output ratio is roughly 780:1 — nearly all spend went to prompt tokens, not
generated output.

## Per account

`usage-by-key.csv` — one row per key, carrying the **full key** plus `initial_credit`,
`spent`, `remaining`, `tasks`, `input_tokens`, `output_tokens`, `total_tokens`.
Row order matches `keys.txt` line for line (verified by key-tail match on all 30).
Column sums reconcile with the totals above: spent $1,423.00, tasks 2,759,
input 646,026,951.

Spend is fairly even across the pool, $6 to $64 per account, since selection was random
per request. Top consumers: ZvlE0 $63.70 (122 tasks), xNVsX $63.30 (123), 4DRFH $62.90
(121). Least used: uLhWS $6.00, UCex $12.50, dINo $15.40.
