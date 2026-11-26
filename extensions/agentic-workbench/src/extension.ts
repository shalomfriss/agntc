import * as vscode from 'vscode';
import { AgentDetailsView, agentDetailsViewId } from './agentDetails';
import { Commands } from './commands';
import { OutputView, outputViewId } from './output';
import { panelContextKey } from './panels';
import { State } from './state';
import { WorkbenchTree } from './tree';
import { WorkflowCanvasView, workflowCanvasViewId } from './workflowCanvas';

export function activate(context: vscode.ExtensionContext): void {
	const state = new State(context);
	const details = new AgentDetailsView(state);
	const canvas = new WorkflowCanvasView(state);
	const output = new OutputView(context.extensionUri);
	const commands = new Commands(state, details, canvas, output);
	void vscode.commands.executeCommand('setContext', panelContextKey, 'workflow');
	const retain = { webviewOptions: { retainContextWhenHidden: true } };
	context.subscriptions.push(state, details, canvas, output, commands, ...commands.register(),
		vscode.window.registerWebviewViewProvider(agentDetailsViewId, details, retain),
		vscode.window.registerWebviewViewProvider(workflowCanvasViewId, canvas, retain),
		vscode.window.registerWebviewViewProvider(outputViewId, output, retain),
		vscode.window.registerTreeDataProvider('agentic.workbench', new WorkbenchTree(state)));
}
