import { requestUrl } from 'obsidian';

export interface HealthResponse {
	version: string;
	profileLoaded: boolean;
}

export type SyncResponse = Record<string, string>;

export class AddonClient {
	private baseUrl = 'http://127.0.0.1:8766';
	private apiKey = '';

	constructor() {}

	setApiKey(key: string) {
		this.apiKey = key;
	}

	private getHeaders(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.apiKey}`,
		};
	}

	async testConnection(): Promise<'unreachable' | 'unauthorized' | 'profile-not-loaded' | 'ok'> {
		try {
			const res = await requestUrl({
				url: `${this.baseUrl}/health`,
				method: 'GET',
				headers: this.getHeaders(),
				throw: false,
			});

			if (res.status === 401) return 'unauthorized';
			if (res.status !== 200) return 'unreachable';
			const json = res.json as HealthResponse;
			return json.profileLoaded ? 'ok' : 'profile-not-loaded';
		} catch {
			return 'unreachable';
		}
	}

	async syncNotes(payload: any[]): Promise<SyncResponse> {
		const res = await requestUrl({
			url: `${this.baseUrl}/syncNotes`,
			method: 'POST',
			body: JSON.stringify(payload),
			headers: this.getHeaders(),
			throw: false,
		});

		if (res.status === 200) {
			return res.json as SyncResponse;
		} else {
			const errorMsg = res.json?.error || `HTTP ${res.status}`;
			throw new Error(`Sync failed: ${errorMsg}`);
		}
	}

	async markOrphaned(uuids: string[]): Promise<SyncResponse> {
		const res = await requestUrl({
			url: `${this.baseUrl}/markOrphaned`,
			method: 'POST',
			body: JSON.stringify(uuids),
			headers: this.getHeaders(),
			throw: false,
		});

		if (res.status === 200) {
			return res.json as SyncResponse;
		} else {
			const errorMsg = res.json?.error || `HTTP ${res.status}`;
			throw new Error(`Mark orphaned failed: ${errorMsg}`);
		}
	}
}
