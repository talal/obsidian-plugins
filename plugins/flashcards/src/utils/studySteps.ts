const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_LEARNING_STEPS = [10 * MINUTE_MS];
export const DEFAULT_RELEARNING_STEPS = [10 * MINUTE_MS];

/** Parse the settings format such as `10m 9h 2d` into millisecond durations. */
export function parseStudySteps(value: string | undefined, fallback: number[]): number[] {
	const parsed = (value ?? '')
		.trim()
		.split(/\s+/)
		.map((token) => {
			const match = /^(\d+(?:\.\d+)?)([mhd])$/i.exec(token);
			if (!match) return null;

			const amountText = match[1];
			const unitText = match[2];
			if (!amountText || !unitText) return null;
			const amount = Number(amountText);
			const unit = unitText.toLowerCase();
			const multiplier = unit === 'm' ? MINUTE_MS : unit === 'h' ? HOUR_MS : DAY_MS;
			const duration = Math.round(amount * multiplier);
			return Number.isSafeInteger(duration) && duration > 0 ? duration : null;
		})
		.filter((duration): duration is number => duration !== null);

	return parsed.length > 0 ? parsed : [...fallback];
}
