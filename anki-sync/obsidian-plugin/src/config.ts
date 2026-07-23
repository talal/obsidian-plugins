/**
 * Plugin settings types and defaults.
 * Minimal configurability to maintain simplicity.
 */

export interface PluginSettings {
	useTypstMath: boolean;
	apiKey: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	useTypstMath: false,
	apiKey: '',
};
