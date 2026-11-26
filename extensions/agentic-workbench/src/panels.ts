import * as vscode from 'vscode';

export const panelContextKey = 'agenticWorkbench.panel';
export type Panel = 'workflow' | 'output';

/** Renders the shared tab strip placed at the top of the left details panel webviews. */
export function panelTabsHtml(active: Panel, escapeHtml: (value: string) => string): string {
	const tabs: Array<[Panel, string]> = [
		['workflow', vscode.l10n.t("Workflow")],
		['output', vscode.l10n.t("Output")],
	];
	const buttons = tabs.map(([panel, label]) =>
		`<button type="button" role="tab" class="panel-tab${panel === active ? ' active' : ''}"` +
		` data-panel="${panel}" aria-selected="${panel === active}">${escapeHtml(label)}</button>`).join('');
	return `<nav class="panel-tabs" role="tablist">${buttons}</nav>`;
}
