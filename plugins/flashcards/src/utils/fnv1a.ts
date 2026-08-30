const FNV_PRIME_64 = 0x100000001b3n;
const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * Computes a fast, synchronous 64-bit FNV-1a hash over text, formatted as a 16-character hex string.
 */
export function fnv1a64(str: string): string {
	let hash = FNV_OFFSET_64;
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		hash ^= BigInt(code & 0xff);
		hash = (hash * FNV_PRIME_64) & MASK_64;
		hash ^= BigInt((code >> 8) & 0xff);
		hash = (hash * FNV_PRIME_64) & MASK_64;
	}
	return hash.toString(16).padStart(16, '0');
}
