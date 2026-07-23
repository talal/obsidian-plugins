import { App, PluginSettingTab, Setting } from 'obsidian';
import RustFormatterPlugin from './main';

export interface RustFormatterSettings {
	formatOnSave: boolean;
}

export const DEFAULT_SETTINGS: RustFormatterSettings = {
	formatOnSave: true,
};

export class RustFormatterSettingTab extends PluginSettingTab {
	plugin: RustFormatterPlugin;

	constructor(app: App, plugin: RustFormatterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Rust Formatter Settings' });

		containerEl.createEl('p', {
			text: 'This formatter is highly opinionated and uses sane defaults. There are no configuration options for formatting style.',
		});

		new Setting(containerEl)
			.setName('Format on Save')
			.setDesc('Automatically format the note when saving')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.formatOnSave).onChange(async (value) => {
					this.plugin.settings.formatOnSave = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
