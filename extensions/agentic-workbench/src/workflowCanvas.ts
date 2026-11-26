import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { artifactTypes } from './contracts';
import { factoryId, FactoryRole, factoryRoles, getAgent, isInputStep, orderedSteps, stepKind, Workbench, Workflow, WorkflowStep } from './model';
import { panelTabsHtml } from './panels';
import { State } from './state';

export const workflowCanvasViewId = 'agentic.workflowCanvas';

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[character]!);
}

function clampCoordinate(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : fallback;
}

export class WorkflowCanvasView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view?: vscode.WebviewView;
	private selection?: string;
	private readonly stateListener: vscode.Disposable;

	constructor(private readonly state: State) {
		this.stateListener = state.onChange(() => this.sendSnapshot());
	}

	dispose(): void {
		this.stateListener.dispose();
	}

	async show(id?: string): Promise<void> {
		const { workflows } = this.state.workbench;
		this.selection = id ?? this.selection ?? workflows[0]?.id;
		if (this.view) {
			this.view.show(true);
			this.sendSnapshot();
		} else {
			await vscode.commands.executeCommand(`${workflowCanvasViewId}.focus`);
		}
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.state.context.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
		const messages = view.webview.onDidReceiveMessage(message => this.receive(view, message));
		const visibility = view.onDidChangeVisibility(() => {
			if (view.visible) {
				this.sendSnapshot();
			}
		});
		view.onDidDispose(() => {
			messages.dispose();
			visibility.dispose();
			if (this.view === view) {
				this.view = undefined;
			}
		});
	}

	private factoryWorkflow(workbench: Workbench): object {
		const roles: FactoryRole[] = ['planner', 'coder', 'judge', 'tester'];
		const steps = roles.map((role, index): WorkflowStep => ({
			id: role, name: factoryRoles[role], kind: 'agent', agentId: workbench.factory.agents[role],
			inputs: index ? [roles[index - 1]] : [], x: 24, y: 24 + index * 132,
		}));
		return { id: factoryId, name: vscode.l10n.t("Code Factory"), steps, readOnly: true };
	}

	private sendSnapshot(): void {
		if (!this.view) {
			return;
		}
		const workbench = this.state.workbench;
		const workflows = workbench.workflows;
		const exists = (id?: string) => id === factoryId || workflows.some(workflow => workflow.id === id);
		if (this.selection && !exists(this.selection)) {
			this.selection = undefined;
		}
		this.selection ??= factoryId;
		const found = workflows.find(value => value.id === this.selection);
		const workflow = this.selection === factoryId ? this.factoryWorkflow(workbench)
			: found && { id: found.id, name: found.name, steps: found.steps, readOnly: false };
		void this.view.webview.postMessage({
			type: 'snapshot',
			selection: this.selection,
			workflows: [{ id: factoryId, name: vscode.l10n.t("Code Factory") },
				...workflows.map(({ id, name }) => ({ id, name }))],
			workflow,
			agents: workbench.agents.map(({ id, name, access, subagents, maxSubagents }) =>
				({ id, name, access, subagents, maxSubagents })),
			artifactTypes: Object.values(artifactTypes).map(type => ({
				id: type.id, name: type.name, fields: type.schema ? Object.keys(type.schema.properties ?? {}) : [],
			})),
		});
	}

	private async mutate(id: string, change: (workflow: Workflow) => void): Promise<void> {
		await this.state.updateWorkbench(workbench => {
			const workflow = workbench.workflows.find(value => value.id === id);
			if (!workflow) {
				throw new Error(vscode.l10n.t("This workflow no longer exists."));
			}
			change(workflow);
			for (const step of workflow.steps) {
				if (stepKind(step) === 'agent') {
					getAgent(workbench.agents, step.agentId!);
				}
			}
			orderedSteps(workflow);
		});
	}

	private async prompt(title: string, value?: string): Promise<string | undefined> {
		return (await vscode.window.showInputBox({
			title, value, validateInput: text => text.trim() ? undefined : vscode.l10n.t("Enter a value."),
		}))?.trim();
	}

	private nodeAgentId(id: unknown): string | undefined {
		const workbench = this.state.workbench;
		if (this.selection === factoryId) {
			const roles: FactoryRole[] = ['planner', 'coder', 'judge', 'tester'];
			return roles.includes(id as FactoryRole) ? workbench.factory.agents[id as FactoryRole] : undefined;
		}
		const workflow = workbench.workflows.find(value => value.id === this.selection);
		const step = workflow?.steps.find(value => value.id === id);
		return step && !isInputStep(step) ? step.agentId : undefined;
	}

	private step(workflow: Workflow, id: unknown): WorkflowStep {
		const step = workflow.steps.find(value => value.id === id);
		if (!step) {
			throw new Error(vscode.l10n.t("That node no longer exists."));
		}
		return step;
	}

	private async receive(view: vscode.WebviewView, message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') {
			return;
		}
		const data = message as Record<string, unknown>;
		const respond = (value: object) => view.webview.postMessage(value);
		try {
			switch (data.type) {
				case 'ready':
					this.sendSnapshot();
					break;
				case 'switchPanel':
					await vscode.commands.executeCommand('agentic.openPanel', data.panel);
					break;
				case 'openNode': {
					const agentId = this.nodeAgentId(data.id);
					if (agentId) {
						await vscode.commands.executeCommand('agentic.editAgent', agentId);
					}
					break;
				}
				case 'select':
					this.selection = typeof data.id === 'string' ? data.id : undefined;
					this.sendSnapshot();
					break;
				case 'create': {
					const name = await this.prompt(vscode.l10n.t("Workflow name"));
					if (name) {
						const workflow: Workflow = { id: randomUUID(), name, steps: [] };
						await this.state.updateWorkbench(workbench => workbench.workflows.push(workflow));
						this.selection = workflow.id;
						this.sendSnapshot();
					}
					break;
				}
				case 'rename': {
					const current = this.state.workbench.workflows.find(value => value.id === this.selection);
					if (current) {
						const name = await this.prompt(vscode.l10n.t("Rename workflow"), current.name);
						if (name) {
							await this.mutate(current.id, workflow => { workflow.name = name; });
						}
					}
					break;
				}
				case 'delete':
					if (this.selection) {
						const id = this.selection;
						const workflow = this.state.workbench.workflows.find(value => value.id === id);
						const confirm = vscode.l10n.t("Delete Workflow");
						if (workflow && await vscode.window.showWarningMessage(
							vscode.l10n.t("Delete \"{0}\"?", workflow.name), { modal: true }, confirm) === confirm) {
							await this.state.updateWorkbench(workbench => {
								workbench.workflows = workbench.workflows.filter(value => value.id !== id);
							});
							this.selection = undefined;
							this.sendSnapshot();
						}
					}
					break;
				case 'addNode':
					if (this.selection) {
						const kinds = ['input', 'condition', 'tool', 'human', 'subworkflow'];
						const kind = typeof data.kind === 'string' && kinds.includes(data.kind) ? data.kind as WorkflowStep['kind'] : 'agent';
						const agentId = typeof data.agentId === 'string' ? data.agentId : undefined;
						const names: Record<string, string> = {
							input: vscode.l10n.t("User input"), condition: vscode.l10n.t("Quality gate"),
							tool: vscode.l10n.t("Run tests"), human: vscode.l10n.t("Human review"),
							subworkflow: vscode.l10n.t("Subworkflow"),
						};
						const outputTypes: Record<string, string | undefined> = { condition: 'GateResult', tool: 'TestReport', human: 'ReviewReport' };
						await this.mutate(this.selection, workflow => {
							const index = workflow.steps.length;
							const step: WorkflowStep = {
								id: randomUUID(),
								name: typeof data.name === 'string' && data.name.trim() ? data.name.trim()
									: names[kind!] ?? vscode.l10n.t("Step {0}", index + 1),
								kind, agentId: kind === 'agent' ? agentId : undefined, inputs: [],
								outputType: outputTypes[kind!],
								command: kind === 'tool' ? '' : undefined,
								workflowId: kind === 'subworkflow' && typeof data.workflowId === 'string' ? data.workflowId : undefined,
								x: 24, y: 24 + index * 128,
							};
							if (kind === 'agent' && !agentId) {
								throw new Error(vscode.l10n.t("Choose an agent for this node."));
							}
							workflow.steps.push(step);
						});
					}
					break;
				case 'setOutputType':
					if (this.selection && typeof data.outputType === 'string') {
						await this.mutate(this.selection, workflow => {
							const step = this.step(workflow, data.id);
							step.outputType = data.outputType === 'Text' ? undefined : data.outputType as string;
						});
					}
					break;
				case 'setCommand':
					if (this.selection && typeof data.command === 'string') {
						await this.mutate(this.selection, workflow => {
							this.step(workflow, data.id).command = data.command as string;
						});
					}
					break;
				case 'setWorkflowRef':
					if (this.selection && typeof data.workflowId === 'string') {
						if (data.workflowId === this.selection) {
							throw new Error(vscode.l10n.t("A workflow cannot call itself."));
						}
						await this.mutate(this.selection, workflow => {
							this.step(workflow, data.id).workflowId = data.workflowId as string;
						});
					}
					break;
				case 'remove':
					if (this.selection) {
						await this.mutate(this.selection, workflow => {
							workflow.steps = workflow.steps.filter(value => value.id !== data.id);
							for (const step of workflow.steps) {
								step.inputs = step.inputs.filter(input => input !== data.id);
							}
						});
					}
					break;
				case 'renameNode': {
					const workflow = this.state.workbench.workflows.find(value => value.id === this.selection);
					const node = workflow?.steps.find(value => value.id === data.id);
					if (workflow && node) {
						const name = await this.prompt(vscode.l10n.t("Node name"), node.name);
						if (name) {
							await this.mutate(workflow.id, current => { this.step(current, data.id).name = name; });
						}
					}
					break;
				}
				case 'setAgent':
					if (this.selection && typeof data.agentId === 'string') {
						await this.mutate(this.selection, workflow => {
							const step = this.step(workflow, data.id);
							if (isInputStep(step)) {
								throw new Error(vscode.l10n.t("Input nodes do not run an agent."));
							}
							step.agentId = data.agentId as string;
						});
					}
					break;
				case 'link':
					if (this.selection) {
						await this.mutate(this.selection, workflow => {
							const source = this.step(workflow, data.from);
							const target = this.step(workflow, data.to);
							if (source.id === target.id) {
								throw new Error(vscode.l10n.t("A node cannot feed itself."));
							}
							if (isInputStep(target)) {
								throw new Error(vscode.l10n.t("Input nodes only produce output. Connect it into an agent."));
							}
							if (!target.inputs.includes(source.id)) {
								target.inputs.push(source.id);
							}
						});
					}
					break;
				case 'unlink':
					if (this.selection) {
						await this.mutate(this.selection, workflow => {
							const target = this.step(workflow, data.to);
							target.inputs = target.inputs.filter(input => input !== data.from);
						});
					}
					break;
				case 'move':
					if (this.selection) {
						await this.mutate(this.selection, workflow => {
							const step = this.step(workflow, data.id);
							step.x = clampCoordinate(data.x, step.x ?? 24);
							step.y = clampCoordinate(data.y, step.y ?? 24);
						});
					}
					break;
				case 'saveLayout':
					if (this.selection && Array.isArray(data.positions)) {
						const positions = data.positions as Array<{ id?: unknown; x?: unknown; y?: unknown }>;
						await this.mutate(this.selection, workflow => {
							for (const entry of positions) {
								const step = workflow.steps.find(value => value.id === entry.id);
								if (step) {
									step.x = clampCoordinate(entry.x, step.x ?? 24);
									step.y = clampCoordinate(entry.y, step.y ?? 24);
								}
							}
						});
						await respond({ type: 'status', text: vscode.l10n.t("Workflow saved.") });
					}
					break;
				case 'run':
					if (this.selection) {
						await vscode.commands.executeCommand('agentic.runWorkflow', this.selection);
					}
					break;
				case 'editAgent':
					if (typeof data.agentId === 'string') {
						await vscode.commands.executeCommand('agentic.editAgent', data.agentId);
					}
					break;
				case 'createAgent':
					await vscode.commands.executeCommand('agentic.createAgent');
					break;
			}
		} catch (error) {
			await respond({ type: 'error', text: (error as Error).message });
			this.sendSnapshot();
		}
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'workflow-canvas.css'));
		const tabStyle = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel-tabs.css'));
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'workflow-canvas.js'));
		const wording = {
			newWorkflow: vscode.l10n.t("New Workflow"),
			noWorkflows: vscode.l10n.t("No workflows yet. Create one to start wiring agents together."),
			createWorkflow: vscode.l10n.t("Create Workflow"),
			namePrompt: vscode.l10n.t("Workflow name"),
			renamePrompt: vscode.l10n.t("Rename workflow"),
			deleteConfirm: vscode.l10n.t("Delete this workflow?"),
			addInput: vscode.l10n.t("Add Input"),
			addAgent: vscode.l10n.t("Add Agent"),
			addCondition: vscode.l10n.t("Add Gate"),
			addTool: vscode.l10n.t("Add Tool"),
			addHuman: vscode.l10n.t("Add Review"),
			addSub: vscode.l10n.t("Add Subworkflow"),
			save: vscode.l10n.t("Save"),
			run: vscode.l10n.t("Run"),
			outputType: vscode.l10n.t("Produces"),
			condition: vscode.l10n.t("Quality gate · waits for all inputs to pass"),
			toolHint: vscode.l10n.t("Runs this shell command in the workspace and reports pass/fail."),
			commandPlaceholder: vscode.l10n.t("e.g. swift test"),
			humanHint: vscode.l10n.t("Pauses the run for you to accept or request revision."),
			chooseWorkflow: vscode.l10n.t("Choose a workflow…"),
			subHint: vscode.l10n.t("Runs another workflow as a step."),
			inspector: vscode.l10n.t("Inspector"),
			inspectKind: vscode.l10n.t("Type"),
			inspectProduces: vscode.l10n.t("Produces"),
			inspectInputs: vscode.l10n.t("Inputs"),
			inspectNone: vscode.l10n.t("No inputs connected."),
			inspectContract: vscode.l10n.t("Contract fields"),
			rename: vscode.l10n.t("Rename"),
			remove: vscode.l10n.t("Remove"),
			delete: vscode.l10n.t("Delete"),
			inputNode: vscode.l10n.t("Input"),
			inputHint: vscode.l10n.t("Supplies the launch input to connected agents."),
			chooseAgent: vscode.l10n.t("Choose an agent…"),
			noAgents: vscode.l10n.t("No agents yet"),
			createAgent: vscode.l10n.t("Create an agent"),
			unassigned: vscode.l10n.t("Unassigned agent"),
			missingAgent: vscode.l10n.t("Agent was deleted"),
			readOnly: vscode.l10n.t("Reads files"),
			readWrite: vscode.l10n.t("Edits files"),
			subagents: vscode.l10n.t("Subagents"),
			dynamic: vscode.l10n.t("+{0} dynamic", "{0}"),
			linkHint: vscode.l10n.t("Drag from a node's bottom port into another node's top port to feed its output onward."),
			readOnlyHint: vscode.l10n.t("Code Factory roles are read-only. Change them in the Workbench tree under Code Factory, then press Run."),
			emptyWorkflow: vscode.l10n.t("Add an input or agent node to begin."),
			nodeName: vscode.l10n.t("Node name"),
			disconnect: vscode.l10n.t("Disconnect"),
			runTitle: vscode.l10n.t("Run this workflow"),
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
	<title>${escapeHtml(vscode.l10n.t("Workflow Canvas"))}</title>
</head>
<body data-localized="${localized}">
	<div id="root">
		${panelTabsHtml('workflow', escapeHtml)}
		<header class="toolbar">
			<div class="field">
				<select id="workflow" aria-label="${escapeHtml(vscode.l10n.t("Workflow"))}"></select>
				<button type="button" class="secondary" id="new" title="${escapeHtml(wording.newWorkflow)}">${escapeHtml(vscode.l10n.t("New"))}</button>
			</div>
			<div class="actions" id="actions">
				<button type="button" id="add-input" class="secondary">${escapeHtml(wording.addInput)}</button>
				<button type="button" id="add-agent" class="secondary">${escapeHtml(wording.addAgent)}</button>
				<button type="button" id="add-condition" class="secondary">${escapeHtml(wording.addCondition)}</button>
				<button type="button" id="add-tool" class="secondary">${escapeHtml(wording.addTool)}</button>
				<button type="button" id="add-human" class="secondary">${escapeHtml(wording.addHuman)}</button>
				<button type="button" id="add-sub" class="secondary">${escapeHtml(wording.addSub)}</button>
				<button type="button" id="rename" class="secondary">${escapeHtml(wording.rename)}</button>
				<button type="button" id="delete" class="text-button delete">${escapeHtml(wording.delete)}</button>
				<button type="button" id="save" class="secondary">${escapeHtml(wording.save)}</button>
				<button type="button" id="run" title="${escapeHtml(wording.runTitle)}">${escapeHtml(wording.run)}</button>
			</div>
		</header>
		<p id="status" role="status" aria-live="polite"></p>
		<div id="viewport" tabindex="0">
			<svg id="wires" aria-hidden="true"></svg>
			<div id="nodes"></div>
			<p id="placeholder" class="placeholder"></p>
		</div>
		<p id="hint" class="hint"></p>
		<aside id="inspector" hidden></aside>
	</div>
</body>
</html>`;
	}
}
