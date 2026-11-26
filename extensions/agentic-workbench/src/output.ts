import * as vscode from 'vscode';
import { panelTabsHtml } from './panels';
import { RunStage } from './runner';

export const outputViewId = 'agentic.output';

export type RunStatus = 'Running' | 'Succeeded' | 'Failed' | 'Cancelled';

export interface PersistedRun {
	name: string;
	mode?: string;
	status: RunStatus;
	task?: string;
	stages: RunStage[];
	result?: string;
	failure?: string;
}

interface OutputState extends PersistedRun {
	current?: string;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[character]!);
}

export class OutputView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view?: vscode.WebviewView;
	private state: OutputState = { name: '', status: 'Succeeded', stages: [] };

	resolveWebviewView(view: vscode.WebviewView, _context: unknown, _token: unknown): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		const messages = view.webview.onDidReceiveMessage(message => {
			const type = message && (message as { type?: string }).type;
			if (type === 'ready') {
				this.send();
			} else if (type === 'switchPanel') {
				void vscode.commands.executeCommand('agentic.openPanel', (message as { panel?: string }).panel);
			}
		});
		const visibility = view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.send();
			}
		});
		view.onDidDispose(() => {
			messages.dispose();
			visibility.dispose();
			if (this.view === view) {
				this.view = undefined;
			}
		});
		this.send();
	}

	constructor(private readonly extensionUri: vscode.Uri) {}

	dispose(): void { /* nothing to clean up */ }

	async show(): Promise<void> {
		if (this.view) {
			this.view.show(true);
		} else {
			await vscode.commands.executeCommand(`${outputViewId}.focus`);
		}
	}

	begin(name: string, mode?: string, task?: string): void {
		this.state = { name, mode, task, status: 'Running', stages: [], current: undefined, result: undefined, failure: undefined };
		this.send();
	}

	load(run: PersistedRun): void {
		this.state = { ...run, current: undefined };
		this.send();
	}

	started(stageName: string): void {
		this.state.current = stageName;
		this.send();
	}

	record(stage: RunStage): void {
		this.state.stages.push({ ...stage });
		this.send();
	}

	finish(status: RunStatus, result?: string, failure?: string): void {
		this.state.status = status;
		this.state.result = result;
		this.state.failure = failure;
		this.state.current = undefined;
		this.send();
	}

	private send(): void {
		void this.view?.webview.postMessage({ type: 'snapshot', ...this.state });
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'output.css'));
		const tabStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel-tabs.css'));
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'output.js'));
		const wording = {
			idle: vscode.l10n.t("Run an agent or workflow to see its output here."),
			running: vscode.l10n.t("Running…"),
			waiting: vscode.l10n.t("Waiting for the first response…"),
			request: vscode.l10n.t("Request"),
			result: vscode.l10n.t("Result"),
			runEnded: vscode.l10n.t("Run ended"),
			attempt: vscode.l10n.t("Attempt {0}", "{0}"),
			noOutput: vscode.l10n.t("No output recorded for this stage."),
		};
		const localized = escapeHtml(JSON.stringify(wording));
		return `<!doctype html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
	<link rel="stylesheet" href="${style}">
	<link rel="stylesheet" href="${tabStyle}">
	<script defer src="${script}"></script>
	<title>${escapeHtml(vscode.l10n.t("Output"))}</title>
</head>
<body data-localized="${localized}">
	${panelTabsHtml('output', escapeHtml)}
	<div id="root">
		<header>
			<h1 id="run-name"></h1>
			<span id="run-status" class="status-badge"></span>
		</header>
		<p id="run-mode" class="muted" hidden></p>
		<div id="stream"></div>
		<p id="empty" class="muted"></p>
	</div>
</body>
</html>`;
	}
}
