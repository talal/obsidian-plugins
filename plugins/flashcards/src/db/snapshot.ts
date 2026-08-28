export const SNAPSHOT_HEADER_SIZE = 48;
export const SNAPSHOT_MAGIC = new Uint8Array([0x46, 0x43, 0x44, 0x42]); // 'FCDB'
const SQLITE_HEADER_PREFIX = 'SQLite format 3\0';

export interface ParsedSnapshotHeader {
	generation: bigint;
	sha256: Uint8Array;
	payloadLength: number;
	payload: Uint8Array;
}

export function isValidSqliteHeader(bytes: Uint8Array): boolean {
	if (bytes.length < 16) return false;
	for (let i = 0; i < 16; i++) {
		if (bytes[i] !== SQLITE_HEADER_PREFIX.charCodeAt(i)) return false;
	}
	return true;
}

export async function computeSha256(data: Uint8Array): Promise<Uint8Array> {
	const buffer = data.buffer.slice(
		data.byteOffset,
		data.byteOffset + data.byteLength,
	) as ArrayBuffer;
	const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
	return new Uint8Array(hashBuffer);
}

export function packSnapshot(
	payload: Uint8Array,
	generation: bigint,
	sha256Bytes: Uint8Array,
): Uint8Array {
	const header = new Uint8Array(SNAPSHOT_HEADER_SIZE);
	const view = new DataView(header.buffer, header.byteOffset, SNAPSHOT_HEADER_SIZE);

	// Magic: 'FCDB'
	header[0] = 0x46;
	header[1] = 0x43;
	header[2] = 0x44;
	header[3] = 0x42;

	// Generation (uint64 Big-Endian)
	view.setBigUint64(4, generation, false);

	// SHA-256 Checksum (32 bytes)
	header.set(sha256Bytes.subarray(0, 32), 12);

	// Payload Length (uint32 Big-Endian)
	view.setUint32(44, payload.byteLength, false);

	const full = new Uint8Array(SNAPSHOT_HEADER_SIZE + payload.byteLength);
	full.set(header, 0);
	full.set(payload, SNAPSHOT_HEADER_SIZE);
	return full;
}

export async function unpackAndVerifySnapshot(
	buffer: Uint8Array,
): Promise<ParsedSnapshotHeader | null> {
	if (buffer.length < SNAPSHOT_HEADER_SIZE + 16) {
		return null;
	}

	// 1. Validate magic bytes 'FCDB'
	if (
		buffer[0] !== SNAPSHOT_MAGIC[0] ||
		buffer[1] !== SNAPSHOT_MAGIC[1] ||
		buffer[2] !== SNAPSHOT_MAGIC[2] ||
		buffer[3] !== SNAPSHOT_MAGIC[3]
	) {
		return null;
	}

	const view = new DataView(buffer.buffer, buffer.byteOffset, SNAPSHOT_HEADER_SIZE);
	const generation = view.getBigUint64(4, false);
	const sha256 = buffer.subarray(12, 44);
	const payloadLength = view.getUint32(44, false);

	// 2. Validate payload length matches buffer length
	if (buffer.length !== SNAPSHOT_HEADER_SIZE + payloadLength) {
		return null;
	}

	const payload = buffer.subarray(SNAPSHOT_HEADER_SIZE);

	// 3. Validate SQLite format 3 header
	if (!isValidSqliteHeader(payload)) {
		return null;
	}

	// 4. Validate SHA-256 checksum
	const computedSha = await computeSha256(payload);
	for (let i = 0; i < 32; i++) {
		if (sha256[i] !== computedSha[i]) {
			return null;
		}
	}

	return {
		generation,
		sha256,
		payloadLength,
		payload,
	};
}
