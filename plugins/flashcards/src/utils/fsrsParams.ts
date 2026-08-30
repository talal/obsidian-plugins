import {
	DEFAULT_MAXIMUM_INTERVAL,
	DEFAULT_REQUEST_RETENTION,
	type FlashcardsPluginSettings,
	type FsrsParams,
} from '../types.js';
import { DEFAULT_LEARNING_STEPS, DEFAULT_RELEARNING_STEPS, parseStudySteps } from './studySteps.js';

export function parseWeights(weightsStr?: string): number[] | undefined {
	if (!weightsStr) return undefined;
	const raw = weightsStr
		.split(',')
		.map((s) => parseFloat(s.trim()))
		.filter((n) => !isNaN(n));
	return raw.length === 21 ? raw : undefined;
}

export function buildFsrsParams(
	settings: FlashcardsPluginSettings,
	overrides?: Partial<FsrsParams>,
): FsrsParams {
	return {
		request_retention: settings.requestRetention ?? DEFAULT_REQUEST_RETENTION,
		maximum_interval: settings.maximumInterval ?? DEFAULT_MAXIMUM_INTERVAL,
		weights: parseWeights(settings.customWeights),
		learning_steps: parseStudySteps(settings.learningSteps, DEFAULT_LEARNING_STEPS),
		relearning_steps: parseStudySteps(settings.relearningSteps, DEFAULT_RELEARNING_STEPS),
		...overrides,
	};
}
