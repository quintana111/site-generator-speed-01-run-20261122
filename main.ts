// makefun-site 1.0.0 entry driver: reads every case from the input dir,
// answers each one alone with run() from solve.js, and writes answers.json.
// Outside a container MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for
// /input and /output. (Part 1: imports, flags, input loading.)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of
// its work runs under it (the house baseline runs the same way).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href));

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8'));

const answers = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
