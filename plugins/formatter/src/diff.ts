import type { EditorPosition } from 'obsidian';

import type { DiffHunk } from './types';

export function offsetToPos(text: string, offset: number): EditorPosition {
	const clamped = Math.max(0, Math.min(offset, text.length));
	let line = 0;
	let lineStart = 0;
	while (lineStart <= clamped) {
		const nextNewline = text.indexOf('\n', lineStart);
		if (nextNewline === -1 || nextNewline >= clamped) {
			return { line, ch: clamped - lineStart };
		}
		line++;
		lineStart = nextNewline + 1;
	}
	return { line, ch: clamped - lineStart };
}

export function mapOffset(offset: number, hunks: DiffHunk[]): number {
	let shift = 0;
	for (const hunk of hunks) {
		if (offset < hunk.fromOffset) {
			break;
		}
		const oldLen = hunk.toOffset - hunk.fromOffset;
		const newLen = hunk.text.length;
		if (offset >= hunk.toOffset) {
			shift += newLen - oldLen;
		} else {
			const relative = oldLen > 0 ? (offset - hunk.fromOffset) / oldLen : 0;
			const mappedInside = Math.min(newLen, Math.round(relative * newLen));
			return hunk.fromOffset + shift + mappedInside;
		}
	}
	return offset + shift;
}

export function applyHunksToString(original: string, hunks: DiffHunk[]): string {
	let result = '';
	let lastOffset = 0;
	for (const hunk of hunks) {
		result += original.slice(lastOffset, hunk.fromOffset);
		result += hunk.text;
		lastOffset = hunk.toOffset;
	}
	result += original.slice(lastOffset);
	return result;
}

export function computeDiffHunks(original: string, formatted: string): DiffHunk[] {
	if (original === formatted) return [];

	let prefix = 0;
	const minLen = Math.min(original.length, formatted.length);
	while (prefix < minLen && original.charCodeAt(prefix) === formatted.charCodeAt(prefix)) {
		prefix++;
	}
	// Snap prefix back to start of line to preserve whole-line fold state
	if (prefix > 0 && original.charCodeAt(prefix - 1) !== 10) {
		const lineStart = original.lastIndexOf('\n', prefix - 1);
		prefix = lineStart === -1 ? 0 : lineStart + 1;
	}

	let suffix = 0;
	while (
		suffix < original.length - prefix &&
		suffix < formatted.length - prefix &&
		original.charCodeAt(original.length - 1 - suffix) ===
			formatted.charCodeAt(formatted.length - 1 - suffix)
	) {
		suffix++;
	}
	// Snap suffix forward to line boundary
	let startOfSuffix = original.length - suffix;
	if (startOfSuffix > prefix && original.charCodeAt(startOfSuffix - 1) !== 10) {
		const nextNewline = original.indexOf('\n', startOfSuffix);
		if (nextNewline !== -1) {
			startOfSuffix = nextNewline + 1;
		} else {
			startOfSuffix = original.length;
		}
	}
	suffix = original.length - startOfSuffix;

	const oldSlice = original.slice(prefix, original.length - suffix);
	const newSlice = formatted.slice(prefix, formatted.length - suffix);

	if (oldSlice === newSlice) return [];

	const oldLines = oldSlice.split('\n');
	const newLines = newSlice.split('\n');

	// For large diffs or simple changes, use a single hunk for the middle slice
	if (oldLines.length + newLines.length > 500 || oldLines.length <= 1 || newLines.length <= 1) {
		return [
			{
				fromOffset: prefix,
				toOffset: original.length - suffix,
				text: newSlice,
			},
		];
	}

	const hunks = diffLines(oldLines, newLines, prefix, original.length - suffix, newSlice);
	return hunks.length > 0
		? hunks
		: [
				{
					fromOffset: prefix,
					toOffset: original.length - suffix,
					text: newSlice,
				},
			];
}

function diffLines(
	a: string[],
	b: string[],
	baseOffset: number,
	endOffset: number,
	newSlice: string,
): DiffHunk[] {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	const v = new Map<number, number>();
	v.set(1, 0);
	const trace: Array<Map<number, number>> = [];

	let reachedEnd = false;
	for (let d = 0; d <= max; d++) {
		trace.push(new Map(v));
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
				x = v.get(k + 1) ?? 0;
			} else {
				x = (v.get(k - 1) ?? 0) + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v.set(k, x);
			if (x >= n && y >= m) {
				reachedEnd = true;
				break;
			}
		}
		if (reachedEnd) break;
	}

	if (!reachedEnd) {
		return [{ fromOffset: baseOffset, toOffset: endOffset, text: newSlice }];
	}

	// Backtrack edit script
	let x = n;
	let y = m;
	const script: Array<'equal' | 'delete' | 'insert'> = [];
	for (let d = trace.length - 1; d > 0; d--) {
		const prevV = trace[d]!;
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && (prevV.get(k - 1) ?? 0) < (prevV.get(k + 1) ?? 0))) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = prevV.get(prevK) ?? 0;
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) {
			script.push('equal');
			x--;
			y--;
		}
		if (d > 0) {
			if (x === prevX) {
				script.push('insert');
				y--;
			} else {
				script.push('delete');
				x--;
			}
		}
	}
	while (x > 0 && y > 0) {
		script.push('equal');
		x--;
		y--;
	}
	script.reverse();

	// Calculate line offsets for `a`
	const aLineStarts: number[] = [0];
	for (let i = 0; i < a.length; i++) {
		aLineStarts.push(aLineStarts[i]! + a[i]!.length + 1);
	}

	const hunks: DiffHunk[] = [];
	let aIdx = 0;
	let bIdx = 0;
	let hunkAStart: number | null = null;
	let hunkBStart: number | null = null;

	for (const op of script) {
		if (op === 'equal') {
			if (hunkAStart !== null && hunkBStart !== null) {
				const fromOffset = baseOffset + aLineStarts[hunkAStart]!;
				const toOffset = aIdx < a.length ? baseOffset + aLineStarts[aIdx]! : endOffset;
				const textLines = b.slice(hunkBStart, bIdx);
				const text =
					textLines.join('\n') + (aIdx < a.length || newSlice.endsWith('\n') ? '\n' : '');
				hunks.push({ fromOffset, toOffset, text });
				hunkAStart = null;
				hunkBStart = null;
			}
			aIdx++;
			bIdx++;
		} else if (op === 'delete') {
			if (hunkAStart === null) hunkAStart = aIdx;
			if (hunkBStart === null) hunkBStart = bIdx;
			aIdx++;
		} else if (op === 'insert') {
			if (hunkAStart === null) hunkAStart = aIdx;
			if (hunkBStart === null) hunkBStart = bIdx;
			bIdx++;
		}
	}

	if (hunkAStart !== null && hunkBStart !== null) {
		const fromOffset = baseOffset + aLineStarts[hunkAStart]!;
		const toOffset = endOffset;
		const textLines = b.slice(hunkBStart, bIdx);
		const text = textLines.join('\n') + (newSlice.endsWith('\n') ? '\n' : '');
		hunks.push({ fromOffset, toOffset, text });
	}

	return hunks;
}
