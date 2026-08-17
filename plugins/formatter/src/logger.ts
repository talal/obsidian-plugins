import { App, Plugin } from 'obsidian';

export class Logger {
	constructor(
		private app: App,
		private plugin: Plugin,
		private prefix: string,
	) {}

	async logError(message: string, error?: unknown) {
		console.error(`${this.prefix}: ${message}`, error ?? '');

		const date = new Date().toISOString().split('T')[0];
		const logPath = `${this.plugin.manifest.dir}/${date}.log`;
		const timestamp = new Date().toISOString();

		let logLine = `[${timestamp}] ERROR: ${message}`;
		if (error !== undefined) {
			let errorDetails: string;
			if (error instanceof Error) {
				errorDetails = error.message;
			} else if (typeof error === 'string') {
				errorDetails = error;
			} else {
				errorDetails = JSON.stringify(error);
			}
			logLine += ` | Details: ${errorDetails}`;
		}
		logLine += '\n';

		try {
			if (await this.app.vault.adapter.exists(logPath)) {
				await this.app.vault.adapter.append(logPath, logLine);
			} else {
				await this.app.vault.adapter.write(logPath, logLine);
			}
		} catch (e) {
			console.error(`${this.prefix}: Failed to write to log file`, e);
		}
	}
}
