import { App, PluginSettingTab, Setting } from 'obsidian';

import type TypstMathPlugin from './main';

export interface TypstMathSettings {
	inlineFontSize: number;
	blockFontSize: number;
}

export const DEFAULT_SETTINGS: TypstMathSettings = {
	inlineFontSize: 18,
	blockFontSize: 20,
};

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 48;
export const FONT_SIZE_STEP = 1;

export function normalizeFontSize(value: unknown, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;

	const steppedValue = Math.round(value / FONT_SIZE_STEP) * FONT_SIZE_STEP;
	if (steppedValue < FONT_SIZE_MIN || steppedValue > FONT_SIZE_MAX) return fallback;
	return steppedValue;
}

function debounce(fn: () => void, waitMs: number): () => void {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	return () => {
		clearTimeout(timeout);
		timeout = setTimeout(fn, waitMs);
	};
}

export class TypstMathSettingTab extends PluginSettingTab {
	plugin: TypstMathPlugin;

	// Slider drags fire onChange per tick; persist trailing-debounced while the
	// CSS variables apply instantly.
	private persistDebounced = debounce(() => void this.plugin.saveSettings(), 500);

	constructor(app: App, plugin: TypstMathPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.createEl('h2', { text: 'Typst math' });

		new Setting(containerEl)
			.setName('Inline math font size')
			.setDesc('Font size in pixels. Default: 18px.')
			.addSlider((slider) =>
				slider
					.setLimits(FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP)
					.setValue(this.plugin.settings.inlineFontSize)
					.onChange((value) => {
						this.plugin.settings.inlineFontSize = normalizeFontSize(
							value,
							DEFAULT_SETTINGS.inlineFontSize,
						);
						this.plugin.applySettings();
						this.persistDebounced();
					}),
			);

		new Setting(containerEl)
			.setName('Block math font size')
			.setDesc('Font size in pixels. Default: 20px.')
			.addSlider((slider) =>
				slider
					.setLimits(FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP)
					.setValue(this.plugin.settings.blockFontSize)
					.onChange((value) => {
						this.plugin.settings.blockFontSize = normalizeFontSize(
							value,
							DEFAULT_SETTINGS.blockFontSize,
						);
						this.plugin.applySettings();
						this.persistDebounced();
					}),
			);
	}
}
