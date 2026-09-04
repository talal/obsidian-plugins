import { type App, Notice, PluginSettingTab, Setting } from 'obsidian';

import type FlashcardsPlugin from './main.js';
import { buildFsrsParams } from './utils/fsrsParams.js';
import { WasmBridge } from './wasm.js';

export class FlashcardsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: FlashcardsPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Desired retention')
			.setDesc(
				'Target retention rate in percentage for scheduled reviews (80% - 99%). Default: 90.',
			)
			.addText((text) => {
				text
					.setPlaceholder('90')
					.setValue(
						this.plugin.settings.requestRetention !== undefined
							? String(Math.round(this.plugin.settings.requestRetention * 100))
							: '',
					)
					.onChange(async (val) => {
						const trimmed = val.trim();
						if (!trimmed) {
							delete this.plugin.settings.requestRetention;
							await this.plugin.saveSettings();
						} else {
							const num = parseInt(trimmed, 10);
							if (!isNaN(num) && num >= 80 && num <= 99) {
								if (num === 90) {
									delete this.plugin.settings.requestRetention;
								} else {
									this.plugin.settings.requestRetention = num / 100;
								}
								await this.plugin.saveSettings();
							}
						}
					});
			});

		new Setting(containerEl)
			.setName('Maximum interval')
			.setDesc('The maximum interval cap in days for reviewed cards. Default: 36500 (100 years).')
			.addText((text) => {
				text
					.setPlaceholder('36500')
					.setValue(
						this.plugin.settings.maximumInterval !== undefined
							? String(this.plugin.settings.maximumInterval)
							: '',
					)
					.onChange(async (val) => {
						const trimmed = val.trim();
						if (!trimmed) {
							delete this.plugin.settings.maximumInterval;
							await this.plugin.saveSettings();
						} else {
							const num = parseInt(trimmed, 10);
							if (!isNaN(num) && num > 0) {
								this.plugin.settings.maximumInterval = num;
								await this.plugin.saveSettings();
							}
						}
					});
			});

		new Setting(containerEl)
			.setName('Learning steps')
			.setDesc('Step intervals for new cards. Default: 10m.')
			.addText((text) => {
				text
					.setPlaceholder('10m')
					.setValue(this.plugin.settings.learningSteps || '')
					.onChange(async (val) => {
						const trimmed = val.trim();
						if (!trimmed) {
							delete this.plugin.settings.learningSteps;
						} else {
							this.plugin.settings.learningSteps = trimmed;
						}
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Relearning steps')
			.setDesc('Step intervals for forgotten cards. Default: 10m.')
			.addText((text) => {
				text
					.setPlaceholder('10m')
					.setValue(this.plugin.settings.relearningSteps || '')
					.onChange(async (val) => {
						const trimmed = val.trim();
						if (!trimmed) {
							delete this.plugin.settings.relearningSteps;
						} else {
							this.plugin.settings.relearningSteps = trimmed;
						}
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Next day starts at')
			.setDesc(
				'Cutoff hour past midnight when cards become due for the next study day (0 - 23). Default: 4.',
			)
			.addText((text) => {
				text
					.setPlaceholder('4')
					.setValue(
						this.plugin.settings.rolloverHour !== undefined
							? String(this.plugin.settings.rolloverHour)
							: '',
					)
					.onChange(async (val) => {
						const trimmed = val.trim();
						if (!trimmed) {
							delete this.plugin.settings.rolloverHour;
							await this.plugin.saveSettings();
						} else {
							const num = parseInt(trimmed, 10);
							if (!isNaN(num) && num >= 0 && num <= 23) {
								if (num === 4) {
									delete this.plugin.settings.rolloverHour;
								} else {
									this.plugin.settings.rolloverHour = num;
								}
								await this.plugin.saveSettings();
							}
						}
					});
			});

		new Setting(containerEl)
			.setName('Leech threshold')
			.setDesc(
				'Number of lapses (times Again is pressed on a review card) before the card is marked as a leech. Set to 0 to disable. Default: 4.',
			)
			.addText((text) => {
				text
					.setPlaceholder('4')
					.setValue(
						this.plugin.settings.leechThreshold !== undefined
							? String(this.plugin.settings.leechThreshold)
							: '',
					)
					.onChange(async (val) => {
						const trimmed = val.trim();
						if (!trimmed) {
							delete this.plugin.settings.leechThreshold;
							await this.plugin.saveSettings();
						} else {
							const num = parseInt(trimmed, 10);
							if (!isNaN(num) && num >= 0) {
								if (num === 4) {
									delete this.plugin.settings.leechThreshold;
								} else {
									this.plugin.settings.leechThreshold = num;
								}
								await this.plugin.saveSettings();
							}
						}
					});
			});

		const weightsDesc = this.plugin.settings.customWeights
			? `Custom weights: ${this.plugin.settings.customWeights}`
			: 'Using default FSRS-6 weights.';

		new Setting(containerEl)
			.setName('FSRS weights')
			.setDesc(weightsDesc)
			.addButton((btn) => {
				btn.setButtonText('Optimize weights').onClick(async () => {
					await this.optimizeWeights();
				});
			})
			.addButton((btn) => {
				btn.setButtonText('Reset to defaults').onClick(async () => {
					delete this.plugin.settings.customWeights;
					await this.plugin.saveSettings();
					new Notice('FSRS weights reset to defaults.');
					this.display();
				});
			});
	}

	private async optimizeWeights(): Promise<void> {
		try {
			const params = buildFsrsParams(this.plugin.settings);

			// Query review logs
			const logs = await this.plugin.getReviewLogs();
			if (logs.length < 8) {
				new Notice('Need at least 8 review logs to optimize weights.');
				return;
			}

			const optimized = WasmBridge.optimizeFsrsWeights(params, logs);
			this.plugin.settings.customWeights = optimized.map((n) => n.toFixed(5)).join(', ');
			await this.plugin.saveSettings();
			new Notice('FSRS weights successfully optimized!');
			this.display();
		} catch (err) {
			console.error('Failed to optimize weights:', err);
			new Notice('Failed to optimize FSRS weights.');
		}
	}
}
