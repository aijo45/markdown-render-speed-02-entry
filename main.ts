// Driver for the markdown-render-speed-02 entry: reads every case from
// /input/cases.json (a JSON array of {id, markdown}), renders each one
// alone with parse() from parse.js, and writes /output/html.json: a JSON
// array of the HTML strings, one per case and in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { parse } from './parse.js';

// Cold single-pass run: TurboFan's background optimization costs more
// wall time than it saves when each function runs only a few dozen
// times, so stay on Maglev/baseline for this run. Ignored if the
// runtime does not accept the flag; outputs are unaffected either way.
try { setFlagsFromString('--no-opt'); } catch { /* keep default flags */ }

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
