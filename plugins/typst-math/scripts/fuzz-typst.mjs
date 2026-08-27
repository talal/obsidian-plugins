import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as fc from 'fast-check';

import init, { Compiler } from '../../../crates/typst-math-wasm/pkg/typst_math_wasm.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(
	scriptDirectory,
	'../../../crates/typst-math-wasm/pkg/typst_math_wasm_bg.wasm',
);
const wasmBytes = await readFile(wasmPath);
const wasmModule = await WebAssembly.compile(wasmBytes);
await init({ module_or_path: wasmModule });

const compiler = new Compiler();
const configuredRuns = Number(process.env.FUZZ_RUNS ?? 300);
const numRuns = Number.isInteger(configuredRuns)
	? Math.min(10_000, Math.max(1, configuredRuns))
	: 300;
const configuredSeed = Number(process.env.FUZZ_SEED ?? 0x51_7f_15);
const seed = Number.isInteger(configuredSeed) ? configuredSeed : 0x51_7f_15;
const hostileCorpus = [
	'',
	' ',
	'\u0000',
	'\u202e',
	'😀\ud800',
	'<script>alert(1)</script>',
	'</math><script>alert(1)</script>',
	'<img src=x onerror=alert(1)>',
	'"quotes" & <angles>',
	'\\frac{x}{y}',
	'$$x$$',
	'#let =',
];

function assertSafeMathml(mathml, display) {
	assert.match(mathml, /^<math(?:\s[^<>]*)?>[\s\S]*<\/math>$/);
	assert.doesNotMatch(mathml, /<\s*\/?\s*(?:script|style|iframe|object|embed|svg|img)\b/i);
	assert.doesNotMatch(mathml, /\s(?:on[a-z][\w:-]*|style|src|href|xlink:href)(?:\s*=|\s|>)/i);
	if (display) assert.match(mathml, /^<math\sdisplay="block">/);
	// Inline roots may still carry display="block" when the user's own
	// expression triggers Typst's parse-time block promotion.
}

const sourceArbitrary = fc.oneof(fc.constantFrom(...hostileCorpus), fc.string({ maxLength: 1024 }));
const inputArbitrary = fc.record({ source: sourceArbitrary, display: fc.boolean() });
let successfulCompilations = 0;
let rejectedCompilations = 0;

try {
	await fc.assert(
		fc.asyncProperty(inputArbitrary, async ({ source, display }) => {
			try {
				const result = compiler.compile_math(source, display);
				assertSafeMathml(result.mathml, display);
				successfulCompilations += 1;
			} catch (error) {
				rejectedCompilations += 1;
				assert.ok(error instanceof Error || typeof error === 'string');
				assert.notEqual(String(error).trim(), '');
			}
		}),
		{ endOnFailure: true, numRuns, seed },
	);
} finally {
	compiler.free();
}

console.log(
	`Typst fuzz passed: ${numRuns} cases (${successfulCompilations} MathML, ${rejectedCompilations} diagnostics; seed ${seed}).`,
);
