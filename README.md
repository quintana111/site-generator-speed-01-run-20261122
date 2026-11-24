# Fast makefun-site — site-generator-speed-01-run-20261122

[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/quintana111/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/quintana111/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` is a dependency-free ES
module whose `run(input)` returns exactly the output tree makefun-site 1.0.0's
`build` returns for the case's site, byte for byte. `main.ts` is the harness
driver (reads `/input/cases.json`, answers each case alone with `run`, writes
`/output/answers.json`).

Speed comes from template codegen (`new Function`, static for-binding
resolution), regex-free Markdown block scanning, batched inline escaping,
offset-based front-matter parsing, manual word counting and cached slugify —
all within one build; nothing is cached from one case to the next.

Practice set (3 cases, 250/340/480 Markdown sources): 3/3 byte-identical,
~210 ms total vs ~540 ms for the house baseline (~2.5x) with
`--no-incremental-marking`, interleaved.
