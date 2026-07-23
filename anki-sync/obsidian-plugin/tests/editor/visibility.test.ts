import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ankiIdPlugin } from '../../src/editorExtension';

describe('Anki ID Visibility Hiding (CodeMirror)', () => {
	let view: EditorView;
	let parent: HTMLElement;

	beforeEach(() => {
		// Create a container for the editor
		parent = document.createElement('div');
		document.body.appendChild(parent);
	});

	afterEach(() => {
		view?.destroy();
		parent.remove();
	});

	function createEditor(doc: string) {
		view = new EditorView({
			state: EditorState.create({
				doc,
				extensions: [ankiIdPlugin],
			}),
			parent,
		});
		return view;
	}

	it('completely hides <!--anki:ID--> comments and preceding spaces from the DOM', () => {
		createEditor('Question :: Answer \t <!--anki:12345-->');

		// The entire text is in the state
		expect(view.state.doc.toString()).toBe('Question :: Answer \t <!--anki:12345-->');

		// But in the DOM, CodeMirror replaces the matched part with an empty widget
		const domText = view.contentDOM.textContent;
		expect(domText).toContain('Question :: Answer');
		expect(domText).not.toContain('<!--anki:12345-->');
		expect(domText).not.toContain(' \t ');

		// Ensure the exact rendered text is what we expect
		expect(domText).toBe('Question :: Answer');
	});

	it('handles multiple notes on multiple lines properly', () => {
		createEditor('Q1 :: A1<!--anki:1-->\nQ2 :: A2  <!--anki:2-->');

		// CodeMirror might render lines as separate divs, but textContent joins them without newlines
		// Actually, let's look at individual lines
		const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line')).map(
			(el) => el.textContent,
		);

		expect(lines[0]).toBe('Q1 :: A1');
		expect(lines[1]).toBe('Q2 :: A2');

		expect(view.contentDOM.innerHTML).not.toContain('<!--anki:');
	});

	it('hides the id param from block card end tags', () => {
		createEditor('%% card end id=abc %%');

		const domText = view.contentDOM.textContent;
		expect(domText).toContain('%% card end %%');
		expect(domText).not.toContain('id=abc');
		expect(domText).toBe('%% card end %%');
	});

	it('treats the hidden tag as an atomic range, skipping it during cursor movement', () => {
		createEditor('Question :: Answer \t <!--anki:12345-->');

		// The visible text "Question :: Answer" is 18 characters long.
		// The hidden text " \t <!--anki:12345-->" spans from index 18 to 38.
		// Total length: 38.

		// Position cursor right before the hidden text
		const startPos = 18;
		const startRange = EditorSelection.cursor(startPos);

		// Move right by one character (simulating ArrowRight)
		const newRange = view.moveByChar(startRange, true);

		// The cursor should skip over the spaces and the HTML comment entirely
		expect(newRange.head).toBe(38);

		// Move left by one character (simulating ArrowLeft) from the end
		const leftRange = view.moveByChar(newRange, false);

		// The cursor should jump back to before the hidden text
		expect(leftRange.head).toBe(18);
	});
});
