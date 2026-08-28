export function getStudyDayStart(rolloverHour = 4, now = new Date()): number {
	const start = new Date(now.getTime());
	if (now.getHours() < rolloverHour) {
		start.setDate(start.getDate() - 1);
	}
	start.setHours(rolloverHour, 0, 0, 0);
	return start.getTime();
}

export function getStudyDayCutoff(rolloverHour = 4, now = new Date()): number {
	const cutoff = new Date(now.getTime());
	if (now.getHours() < rolloverHour) {
		cutoff.setHours(rolloverHour, 0, 0, 0);
	} else {
		cutoff.setDate(cutoff.getDate() + 1);
		cutoff.setHours(rolloverHour, 0, 0, 0);
	}
	return cutoff.getTime();
}

export function formatLocalDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function getStudyDayKey(timestampMs: number, rolloverHour = 4): string {
	const date = new Date(timestampMs);
	if (date.getHours() < rolloverHour) {
		date.setDate(date.getDate() - 1);
	}
	return formatLocalDate(date);
}

export function shiftLocalDateKey(key: string, days: number): string {
	const [year = 0, month = 1, day = 1] = key.split('-').map(Number);
	const date = new Date(year, month - 1, day);
	date.setDate(date.getDate() + days);
	return formatLocalDate(date);
}
