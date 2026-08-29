<script lang="ts">
	import { Component, MarkdownRenderer, type App } from 'obsidian';
	import type { ReviewItem } from '../../types.ts';

	interface Props {
		app?: App;
		card: ReviewItem;
		isRevealed: boolean;
		cardDisplay: {
			isCloze: boolean;
			frontMarkdown: string;
			backMarkdown: string;
		} | null;
	}

	let { app, card, isRevealed, cardDisplay }: Props = $props();

	function renderMarkdownAction(
		node: HTMLElement,
		params: { app?: App; markdown: string; sourcePath: string },
	) {
		let comp = new Component();
		comp.load();
		let renderId = 0;

		const render = async (targetApp: App | undefined, md: string, path: string) => {
			const currentId = ++renderId;
			node.empty();
			if (targetApp) {
				await MarkdownRenderer.render(targetApp, md, node, path, comp);
			} else {
				node.innerHTML = md;
			}
			if (currentId !== renderId) {
				node.empty();
			}
		};

		void render(params.app, params.markdown, params.sourcePath);

		return {
			update(newParams: { app?: App; markdown: string; sourcePath: string }) {
				comp.unload();
				comp = new Component();
				comp.load();
				void render(newParams.app, newParams.markdown, newParams.sourcePath);
			},
			destroy() {
				comp.unload();
			},
		};
	}
</script>

<div class="fc-card-container">
	<article class="fc-card">
		<div class="fc-card-meta">
			<span class="fc-note-title" dir="auto">{card.noteTitle}</span>
			<div class="fc-meta-badges">
				{#if card.direction === 'reverse'}
					<span class="fc-badge fc-badge-reverse">Reverse</span>
				{/if}
				{#if card.tags.includes('card/todo')}
					<span class="fc-badge fc-badge-todo">Todo</span>
				{/if}
				<span class="fc-card-due" dir="auto">{card.dueHuman}</span>
			</div>
		</div>

		<div class="fc-card-body">
			<div
				class="fc-card-front"
				dir="auto"
				use:renderMarkdownAction={{
					app,
					markdown: cardDisplay?.frontMarkdown ?? '',
					sourcePath: card.notePath,
				}}
			></div>

			{#if !cardDisplay?.isCloze && isRevealed && cardDisplay?.backMarkdown}
				<div class="fc-card-divider"></div>
				<div
					class="fc-card-back"
					dir="auto"
					use:renderMarkdownAction={{
						app,
						markdown: cardDisplay.backMarkdown,
						sourcePath: card.notePath,
					}}
				></div>
			{/if}
		</div>
	</article>
</div>
