import { Decoration, MatchDecorator, ViewPlugin, EditorView } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';

export const ankiIdDecorator = Decoration.replace({});

export const ankiIdMatcher = new MatchDecorator({
	regexp: /(?:[ \t]*<!--anki:[A-Za-z0-9]+-->)|(?:[ \t]*id=[A-Za-z0-9]+(?=[ \t]*%%))/g,
	decoration: ankiIdDecorator,
});

export const ankiIdPlugin = ViewPlugin.fromClass(
	class {
		decorations: any;
		constructor(view: EditorView) {
			this.decorations = ankiIdMatcher.createDeco(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = ankiIdMatcher.updateDeco(update, this.decorations);
			}
		}
	},
	{
		decorations: (v) => v.decorations,
		provide: (plugin) =>
			EditorView.atomicRanges.of((view) => {
				return view.plugin(plugin)?.decorations || Decoration.none;
			}),
	},
);
