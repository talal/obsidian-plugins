export interface DiffHunk {
	fromOffset: number;
	toOffset: number;
	text: string;
}

export interface SelectionOffset {
	anchorOffset: number;
	headOffset: number;
}
