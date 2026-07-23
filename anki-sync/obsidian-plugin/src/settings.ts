/**
 * Settings tab UI for the Anki Sync plugin.
 * Keeps configurability minimal.
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import type AnkiSyncPlugin from './main';

export class AnkiSyncSettingTab extends PluginSettingTab {
	plugin: AnkiSyncPlugin;

	constructor(app: App, plugin: AnkiSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Anki Sync Settings' });

		new Setting(containerEl)
			.setName('Notes use Typst Math Syntax')
			.setDesc(
				"Compile $...$ and $$...$$ using Typst MathML WASM compiler instead of relying on Anki's MathJax.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useTypstMath).onChange(async (value) => {
					this.plugin.settings.useTypstMath = value;
					if (value && !this.plugin.typstCompiler.isReady()) {
						this.plugin.typstCompiler.init(this.plugin).catch((e) => console.error(e));
					}
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Shared secret for Anki Addon authentication')
			.addText((text) =>
				text
					.setPlaceholder('Enter your API key')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
