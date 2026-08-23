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

export class TypstMathSettingTab extends PluginSettingTab {
	plugin: TypstMathPlugin;

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
					.onChange(async (value) => {
						this.plugin.settings.inlineFontSize = normalizeFontSize(
							value,
							DEFAULT_SETTINGS.inlineFontSize,
						);
						this.plugin.applySettings();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Block math font size')
			.setDesc('Font size in pixels. Default: 20px.')
			.addSlider((slider) =>
				slider
					.setLimits(FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP)
					.setValue(this.plugin.settings.blockFontSize)
					.onChange(async (value) => {
						this.plugin.settings.blockFontSize = normalizeFontSize(
							value,
							DEFAULT_SETTINGS.blockFontSize,
						);
						this.plugin.applySettings();
						await this.plugin.saveSettings();
					}),
			);
	}
}
