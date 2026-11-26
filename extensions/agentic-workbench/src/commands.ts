import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { AgentDetailsView } from './agentDetails';
import { composeSystemPrompt, parseWorkflowDraft } from './compose';
import { Agent, factoryId, FactoryRole, factoryRoles, getAgent, isInputStep, modes, PlanningMode, Workflow, WorkflowStep } from './model';
import { loadProjectMemory } from './memory';
import { OutputView, PersistedRun } from './output';
import { Panel, panelContextKey } from './panels';
import { ProcessError, runProcess } from './process';
import { compareRuns } from './runCompare';
import { loadSkillContents } from './skills';
import { WorkflowCanvasView } from './workflowCanvas';
import { createPlanning } from './planning';
import { copilotModels, ProviderKind, providerKinds, ProviderProfile, resolveModel, usesApiKey, validateEndpoint, verifyCliLogin } from './providers';
import { AgentRunner, checkCancelled, CommandResult, runCodeFactory, RunStage, runWorkflow, StepInput } from './runner';
import { RunEntry, State } from './state';
import { WorkbenchItem } from './tree';
import { Workspace } from './workspace';

interface Choice<T> extends vscode.QuickPickItem {
	value: T;
}

async function pick<T>(title: string, choices: Choice<T>[]): Promise<T | undefined> {
	return (await vscode.window.showQuickPick(choices, { title, matchOnDescription: true }))?.value;
}

function choice<T>(label: string, value: T, description?: string): Choice<T> {
	return { label, value, description };
}

async function input(prompt: string, value?: string): Promise<string | undefined> {
	return (await vscode.window.showInputBox({
		prompt, value, validateInput: text => text.trim() ? undefined : 'Enter a value.',
	}))?.trim();
}

const signIn = {
	codex: 'codex login',
	claudeCode: 'claude auth login',
} as const;

export class Commands implements vscode.Disposable {
	private active?: AbortController;

	constructor(
		private readonly state: State, private readonly details: AgentDetailsView,
		private readonly canvas: WorkflowCanvasView, private readonly output: OutputView,
	) {}

	dispose(): void {
		this.active?.abort();
	}

	private showPanel(panel: Panel): Thenable<unknown> {
		return vscode.commands.executeCommand('setContext', panelContextKey, panel);
	}

	private async revealPanel(panel?: string): Promise<void> {
		const target: Panel = panel === 'output' ? 'output' : 'workflow';
		await this.showPanel(target);
		if (target === 'workflow') {
			await this.canvas.show();
		} else {
			await this.output.show();
		}
	}

	register(): vscode.Disposable[] {
		const handlers = {
			connectProvider: () => this.connectProvider(),
			editProvider: (id?: string) => this.editProvider(id),
			createAgent: () => this.details.show('new'),
			editAgent: (id?: string) => this.details.show(id),
			runAgent: (id?: string) => this.runAgent(id),
			createWorkflow: () => this.createWorkflow(),
			composeWorkflow: () => this.composeWorkflow(),
			editWorkflow: (id?: string) => this.editWorkflow(id),
			openWorkflowCanvas: async (id?: string) => { await this.showPanel('workflow'); await this.canvas.show(id); },
			openPanel: (panel?: string) => this.revealPanel(panel),
			runWorkflow: (id?: string) => this.runWorkflow(id),
			runCodeFactory: () => this.runWorkflow(factoryId),
			cancelRun: () => this.active?.abort(),
			openRun: (id?: string) => this.openRun(id === 'runs' ? undefined : id),
			openReport: (id?: string) => this.openReport(id),
			compareRuns: () => this.compareRuns(),
		};
		const registrations = Object.entries(handlers).map(([command, handler]) =>
			vscode.commands.registerCommand(`agentic.${command}`, async (item?: WorkbenchItem | string) => {
				try {
					await handler(typeof item === 'string' ? item : item?.key);
				} catch (error) {
					void vscode.window.showErrorMessage((error as Error).message);
				}
			}));
		registrations.push(vscode.commands.registerCommand('agentic.runToStep', (workflowId?: string, stepId?: string) =>
			this.runWorkflow(workflowId, stepId).catch(error => void vscode.window.showErrorMessage((error as Error).message))));
		return registrations;
	}

	private providerChoices(): Choice<ProviderProfile>[] {
		return this.state.providers.profiles.map(value => choice(value.name, value, value.model));
	}

	private async chooseCopilot(): Promise<string | undefined> {
		const models = await copilotModels();
		if (!models.length) {
			throw new Error('Enable GitHub Copilot Chat and sign in to GitHub, then run Connect AI Provider again.');
		}
		return pick('Copilot model', models.map(model => choice(model.name, model.id, model.id)));
	}

	private async authenticateCli(kind: 'codex' | 'claudeCode'): Promise<boolean> {
		try {
			await verifyCliLogin(kind);
			return true;
		} catch (error) {
			const label = 'Open Sign-in Terminal';
			const selected = await vscode.window.showWarningMessage((error as Error).message, label);
			if (selected === label) {
				const terminal = vscode.window.createTerminal({ name: providerKinds[kind].label });
				terminal.show();
				terminal.sendText(signIn[kind]);
				void vscode.window.showInformationMessage('After sign-in succeeds, run Agentic: Connect AI Provider again.');
			}
			return false;
		}
	}

	private async configureKey(kind: ProviderKind, update = false): Promise<string | undefined> {
		const isOptional = kind === 'compatible';
		return (await vscode.window.showInputBox({
			title: update ? 'Update API key' : 'Connect API key',
			prompt: isOptional ? 'Enter an API key if your endpoint requires one.' : 'Enter your provider API key.',
			placeHolder: isOptional ? 'Leave empty for an endpoint that needs no key' : undefined,
			password: true,
			validateInput: text => isOptional || text.trim() ? undefined : 'An API key is required.',
		}))?.trim();
	}

	private async connectProvider(): Promise<void> {
		const kind = await pick('Connect AI provider', (Object.keys(providerKinds) as ProviderKind[])
			.map(kind => choice(providerKinds[kind].label, kind, providerKinds[kind].description)));
		if (!kind) {
			return;
		}
		const name = await input('Name for this connection', providerKinds[kind].label);
		if (!name) {
			return;
		}
		const profile: ProviderProfile = { id: randomUUID(), kind, name };
		let secret: string | undefined;
		if (kind === 'copilot') {
			profile.model = await this.chooseCopilot();
			if (!profile.model) {
				return;
			}
		} else if (kind === 'codex' || kind === 'claudeCode') {
			if (!await this.authenticateCli(kind)) {
				return;
			}
			const model = await vscode.window.showInputBox({ prompt: 'Model ID. Leave empty to use the CLI default.' });
			if (model === undefined) {
				return;
			}
			profile.model = model.trim() || undefined;
		} else {
			if (kind === 'compatible') {
				const base = await input('OpenAI-compatible base URL', 'http://localhost:11434/v1');
				if (!base) {
					return;
				}
				profile.baseUrl = validateEndpoint(base);
			}
			profile.model = await input('Model ID from your provider');
			if (!profile.model) {
				return;
			}
			secret = await this.configureKey(kind);
			if (secret === undefined) {
				return;
			}
		}
		await this.verifyProvider(profile, secret);
		await this.state.saveProvider(profile, secret || undefined);
		void vscode.window.showInformationMessage(`Connected ${profile.name}.`);
	}

	private async verifyProvider(profile: ProviderProfile, secret?: string): Promise<void> {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification, title: `Checking ${profile.name}`, cancellable: true,
		}, async (_, cancellation) => {
			const abort = new AbortController();
			const subscription = cancellation.onCancellationRequested(() => abort.abort());
			try {
				const model = await resolveModel(profile, secret);
				if (profile.kind !== 'codex' && profile.kind !== 'claudeCode') {
					await model.request('Reply with the single word OK.', [{ role: 'user', content: 'Connection check.' }],
						AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]));
				}
				checkCancelled(abort.signal);
			} finally {
				subscription.dispose();
			}
		});
	}

	private async editProvider(id?: string): Promise<void> {
		const profile = id ? this.state.providers.profiles.find(value => value.id === id)
			: await pick('Manage AI provider', this.providerChoices());
		if (!profile) {
			return;
		}
		const action = await pick(profile.name, [
			choice('Rename connection', 'rename'),
			choice('Change default model', 'model'),
			choice('Set as workbench default', 'default'),
			choice('Test connection', 'test'),
			...(usesApiKey(profile.kind) ? [choice('Update API key', 'key')] : []),
			choice('Disconnect from Workbench', 'disconnect'),
		]);
		if (action === 'rename') {
			const name = await input('Provider connection name', profile.name);
			if (name) {
				await this.state.saveProvider({ ...profile, name });
			}
		}
		if (action === 'model') {
			const model = profile.kind === 'copilot' ? await this.chooseCopilot()
				: usesApiKey(profile.kind) ? await input('Default model ID', profile.model)
					: await vscode.window.showInputBox({ prompt: 'Default model ID. Leave empty for the CLI default.', value: profile.model });
			if (model !== undefined) {
				await this.state.saveProvider({ ...profile, model: model.trim() || undefined });
			}
		}
		if (action === 'key') {
			const secret = await this.configureKey(profile.kind, true);
			if (secret !== undefined) {
				await this.verifyProvider(profile, secret);
				await this.state.saveProvider(profile, secret);
			}
		}
		if (action === 'default') {
			await this.state.setDefault(profile.id);
		}
		if (action === 'test') {
			await this.verifyProvider(profile, await this.state.secret(profile.id));
			void vscode.window.showInformationMessage(`${profile.name} is connected.`);
		}
		if (action === 'disconnect') {
			const confirm = 'Disconnect';
			if (await vscode.window.showWarningMessage(
				`Disconnect ${profile.name}? Agents explicitly assigned to it will need a new provider.`,
				{ modal: true }, confirm,
			) === confirm) {
				await this.state.disconnect(profile.id);
			}
		}
	}

	private async chooseAgent(title: string, id?: string): Promise<Agent | undefined> {
		const { agents } = this.state.workbench;
		return id ? getAgent(agents, id) : pick(title, agents.map(agent => choice(agent.name, agent, agent.access)));
	}

	private async createWorkflow(): Promise<void> {
		const name = await input('Workflow name');
		if (!name) {
			return;
		}
		const workflow = { id: randomUUID(), name, steps: [] };
		await this.state.updateWorkbench(workbench => workbench.workflows.push(workflow));
		await this.editWorkflow(workflow.id);
	}

	private async composeWorkflow(): Promise<void> {
		if (!this.state.providers.profiles.length) {
			await this.connectProvider();
			if (!this.state.providers.profiles.length) {
				return;
			}
		}
		const description = await input('Describe the workflow to generate');
		if (!description) {
			return;
		}
		const providers = this.state.providers;
		const profile = providers.profiles.find(value => value.id === providers.defaultId) ?? providers.profiles[0];
		const agents = this.state.workbench.agents;
		const workflow = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification, title: 'Composing workflow', cancellable: true,
		}, async (_, cancellation) => {
			const abort = new AbortController();
			const subscription = cancellation.onCancellationRequested(() => abort.abort());
			try {
				const model = await resolveModel(profile, await this.state.secret(profile.id));
				const answer = await model.request(composeSystemPrompt(agents), [{ role: 'user', content: description }],
					AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]));
				return parseWorkflowDraft(answer, agents);
			} finally {
				subscription.dispose();
			}
		});
		await this.state.updateWorkbench(workbench => workbench.workflows.push(workflow));
		await this.showPanel('workflow');
		await this.canvas.show(workflow.id);
		void vscode.window.showInformationMessage(vscode.l10n.t("Created \"{0}\". Review and adjust it in the canvas.", workflow.name));
	}

	private selectWorkflow(title: string): Promise<string | undefined> {
		return pick(title, [choice('Code Factory', factoryId, 'Plan → Code → Judge → Human testing guide'),
			...this.state.workbench.workflows.map(workflow => choice(workflow.name, workflow.id))]);
	}

	private async editFactory(): Promise<void> {
		const { factory } = this.state.workbench;
		const role = await pick<FactoryRole | 'revisions'>('Manage Code Factory', [
			...(Object.entries(factoryRoles) as [FactoryRole, string][]).map(([role, label]) =>
				choice(label, role, getAgent(this.state.workbench.agents, factory.agents[role]).name)),
			choice('Maximum judge revisions', 'revisions', String(factory.maxRevisions)),
		]);
		if (!role) {
			return;
		}
		if (role === 'revisions') {
			const count = await pick('Additional plans after the first review', Array.from({ length: 9 }, (_, i) => choice(String(i), i)));
			if (count !== undefined) {
				await this.state.updateWorkbench(workbench => { workbench.factory.maxRevisions = count; });
			}
			return;
		}
		const agent = await this.chooseAgent(`Agent for ${factoryRoles[role]}`);
		if (agent) {
			if (role === 'coder' && agent.access !== 'write') {
				throw new Error('The Coding Agent must have workspace write access.');
			}
			await this.state.updateWorkbench(workbench => { workbench.factory.agents[role] = agent.id; });
		}
	}

	private async editWorkflow(id?: string): Promise<void> {
		id ??= await this.selectWorkflow('Manage workflow');
		if (!id) {
			return;
		}
		if (id === factoryId) {
			await this.editFactory();
			return;
		}
		const workflow = this.state.workbench.workflows.find(value => value.id === id);
		if (!workflow) {
			throw new Error('The workflow no longer exists.');
		}
		const action = await pick(workflow.name, [
			choice('Add step', 'add'), choice('Edit step or link inputs', 'edit'),
			choice('Rename workflow', 'rename'), choice('Delete workflow', 'delete'),
		]);
		const save = (change: (current: Workflow) => void) => this.state.updateWorkbench(workbench => {
			const current = workbench.workflows.find(value => value.id === id);
			if (!current) {
				throw new Error('The workflow no longer exists.');
			}
			change(current);
			current.steps.forEach(step => { if (!isInputStep(step)) { getAgent(workbench.agents, step.agentId!); } });
		});
		if (action === 'add') {
			const agent = await this.chooseAgent('Agent for this step');
			if (!agent) {
				return;
			}
			const name = await input('Step name', agent.name);
			if (name) {
				await save(current => current.steps.push({ id: randomUUID(), name, agentId: agent.id, inputs: [] }));
			}
		} else if (action === 'rename') {
			const name = await input('Workflow name', workflow.name);
			if (name) {
				await save(current => { current.name = name; });
			}
		} else if (action === 'delete') {
			const confirm = 'Delete Workflow';
			if (await vscode.window.showWarningMessage(`Delete "${workflow.name}"?`, { modal: true }, confirm) === confirm) {
				await this.state.updateWorkbench(workbench => {
					workbench.workflows = workbench.workflows.filter(value => value.id !== id);
				});
			}
		} else if (action === 'edit') {
			const step = await pick('Workflow step', workflow.steps.filter(value => !isInputStep(value))
				.map(value => choice(value.name, value)));
			if (step) {
				await this.editStep(workflow, step, save);
			}
		}
	}

	private async editStep(workflow: Workflow, step: WorkflowStep, save: (change: (current: Workflow) => void) => Promise<void>): Promise<void> {
		const action = await pick(step.name, [
			choice('Link upstream outputs', 'inputs'), choice('Change agent', 'agent'),
			choice('Rename step', 'rename'), choice('Remove step', 'remove'),
		]);
		let update: Partial<WorkflowStep>;
		if (action === 'rename') {
			const name = await input('Step name', step.name);
			if (!name) {
				return;
			}
			update = { name };
		} else if (action === 'agent') {
			const agent = await this.chooseAgent('Agent for this step');
			if (!agent) {
				return;
			}
			update = { agentId: agent.id };
		} else if (action === 'inputs') {
			const selected = await vscode.window.showQuickPick(workflow.steps.filter(value => value.id !== step.id)
				.map(value => ({ ...choice(value.name, value.id), picked: step.inputs.includes(value.id) })), {
				canPickMany: true, title: `Outputs to pass into ${step.name}`,
			});
			if (!selected) {
				return;
			}
			update = { inputs: selected.map(value => value.value) };
		} else if (action === 'remove') {
			await save(current => {
				current.steps = current.steps.filter(value => value.id !== step.id);
				current.steps.forEach(value => { value.inputs = value.inputs.filter(id => id !== step.id); });
			});
			return;
		} else {
			return;
		}
		await save(current => {
			const target = current.steps.find(value => value.id === step.id);
			if (!target) {
				throw new Error('The workflow step no longer exists.');
			}
			Object.assign(target, update);
		});
	}

	private async selectTask(): Promise<string | undefined> {
		const editor = vscode.window.activeTextEditor;
		const selected = editor?.document.getText(editor.selection).trim();
		if (selected) {
			const source = await pick('Task source', [
				choice('Type a task', 'type'), choice('Use selected editor text', 'selection', selected.slice(0, 80)),
			]);
			if (source !== 'type') {
				return source === 'selection' ? selected : undefined;
			}
		}
		return input('Describe the task to run');
	}

	private async runAgent(id?: string): Promise<void> {
		const agent = await this.chooseAgent('Run agent', id);
		if (agent) {
			await this.run(agent.name, undefined, (task, runner) => runner.run({
				name: agent.name, agentId: agent.id, input: task, allowWrite: true,
			}));
		}
	}

	private async runWorkflow(id?: string, stopBefore?: string): Promise<void> {
		id ??= await this.selectWorkflow('Run workflow');
		if (!id) {
			return;
		}
		if (id === factoryId) {
			const mode = await pick('Code Factory planning mode', modes.map(mode =>
				choice(mode, mode, mode === 'Unstructure' ? 'Plan without a spec framework' : undefined)));
			if (!mode) {
				return;
			}
			const { factory } = this.state.workbench;
			await this.run('Code Factory', mode, (task, runner, workspace, id, signal) =>
				runCodeFactory(factory, task, runner, () => createPlanning(mode, workspace, id, signal), {
					summary: () => workspace.reviewSummary(), tools: () => workspace.evidenceTools(),
					editCount: artifactRoot => workspace.editCount(artifactRoot),
				}));
			return;
		}
		const workflow = this.state.workbench.workflows.find(value => value.id === id);
		if (!workflow) {
			throw new Error('The workflow no longer exists.');
		}
		await this.run(workflow.name, undefined, (task, runner, workspace, _id, signal) =>
			runWorkflow(workflow, task, runner, {}, {
				runCommand: command => this.runToolCommand(command, workspace.cwd, signal),
				decide: (step, inputs) => this.humanDecision(step.name, inputs),
				resolveWorkflow: refId => this.state.workbench.workflows.find(value => value.id === refId),
				breakpoints: new Set(workflow.steps.filter(step => step.breakpoint).map(step => step.id)),
				onPause: (step, inputs) => this.pauseAt(step.name, inputs),
				stopBefore,
			}));
	}

	private async pauseAt(name: string, inputs: StepInput[]): Promise<void> {
		const resume = vscode.l10n.t("Resume");
		const stop = vscode.l10n.t("Stop");
		const detail = inputs.length
			? inputs.map(input => `${input.name}:\n${input.output.slice(0, 1000)}`).join('\n\n')
			: vscode.l10n.t("No inputs resolved yet.");
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t("Paused before {0}. Inspect, then resume or stop.", name), { modal: true, detail }, resume, stop);
		if (choice !== resume) {
			throw new Error('Run stopped at a breakpoint.');
		}
	}

	private async humanDecision(name: string, inputs: StepInput[]): Promise<{ approved: boolean; reason: string }> {
		const accept = vscode.l10n.t("Accept");
		const revise = vscode.l10n.t("Request revision");
		const summary = inputs.map(input => input.name).join(', ');
		const choice = await vscode.window.showInformationMessage(
			summary ? vscode.l10n.t("{0}: review {1}, then decide.", name, summary) : vscode.l10n.t("{0}: decide to continue.", name),
			{ modal: true, detail: inputs.map(input => `${input.name}:\n${input.output.slice(0, 1000)}`).join('\n\n') },
			accept, revise);
		if (choice === accept) {
			return { approved: true, reason: '' };
		}
		if (choice === revise) {
			const reason = await vscode.window.showInputBox({ title: name, prompt: vscode.l10n.t("What needs to change?") });
			return { approved: false, reason: reason ?? '' };
		}
		throw new Error('Run cancelled at the human-decision step.');
	}

	private async runToolCommand(command: string, cwd: string, signal: AbortSignal): Promise<CommandResult> {
		const [exe, flag] = process.platform === 'win32' ? ['cmd.exe', '/c'] : ['/bin/sh', '-c'];
		try {
			const { stdout, stderr } = await runProcess(exe, [flag, command], signal, { cwd });
			return { code: 0, output: `${stdout}${stderr}` };
		} catch (error) {
			if (error instanceof ProcessError) {
				return { code: error.code ?? 1, output: error.output };
			}
			throw error;
		}
	}

	private async run(name: string, mode: PlanningMode | undefined, execute: (
		task: string, runner: AgentRunner, workspace: Workspace, id: string, signal: AbortSignal,
	) => Promise<string>): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			throw new Error('Trust the workspace before starting an agent run.');
		}
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (!folders.length) {
			throw new Error('Open a workspace folder before running an agent or workflow.');
		}
		const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the folder for this run' });
		if (!folder) {
			return;
		}
		if (folder.uri.scheme !== 'file') {
			throw new Error('Select a folder available to the workspace extension host.');
		}
		if (!this.state.providers.profiles.length) {
			await this.connectProvider();
			if (!this.state.providers.profiles.length) {
				return;
			}
		}
		const task = await this.selectTask();
		if (!task) {
			return;
		}
		if (this.active) {
			throw new Error('An agent or workflow is already running in this window.');
		}
		const entry: RunEntry = {
			id: randomUUID().slice(0, 12), name, startedAt: new Date().toISOString(), status: 'Failed',
		};
		const abort = new AbortController();
		this.active = abort;
		const stages: RunStage[] = [];
		await this.showPanel('output');
		this.output.begin(name, mode, task);
		const workspace = new Workspace(folder.uri.fsPath, relative => {
			const uri = vscode.Uri.joinPath(folder.uri, ...relative.split('/'));
			if (vscode.workspace.textDocuments.some(value => value.uri.toString() === uri.toString() && value.isDirty)) {
				throw new Error('This file has unsaved editor changes. Save it before retrying the edit.');
			}
		}, async relative => {
			await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder.uri, ...relative.split('/')), { useTrash: true });
		});
		const providers = this.state.providers;
		let result: string | undefined;
		let failure: string | undefined;
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification, title: mode ? `${name} · ${mode}` : name, cancellable: true,
		}, async (progress, cancellation) => {
			const subscription = cancellation.onCancellationRequested(() => abort.abort());
			try {
				const memory = await loadProjectMemory(folder.uri.fsPath);
				const agents = await Promise.all(this.state.workbench.agents.map(async agent => {
					const parts = [agent.instructions];
					const contents = await loadSkillContents(agent.skills ?? []);
					if (contents.length) {
						parts.push(`## Skills you can use\n\n${contents.join('\n\n')}`);
					}
					if (memory) {
						parts.push(`## Project memory\n\n${memory}`);
					}
					return parts.length > 1 ? { ...agent, instructions: parts.join('\n\n') } : agent;
				}));
				const runner = new AgentRunner(agents, async agent => {
					const profile = providers.profiles.find(value => value.id === (agent.providerId ?? providers.defaultId));
					if (!profile) {
						throw new Error(`Choose a connected provider for "${agent.name}".`);
					}
					return resolveModel(profile, await this.state.secret(profile.id), agent.model);
				}, allowWrite => workspace.tools(allowWrite), stage => {
					stages.push(stage);
					this.output.record(stage);
				}, abort.signal, stage => {
					progress.report({ message: stage });
					this.output.started(stage);
				});
				result = await execute(task, runner, workspace, entry.id, abort.signal);
				entry.status = 'Succeeded';
			} catch (error) {
				entry.status = abort.signal.aborted ? 'Cancelled' : 'Failed';
				failure = (error as Error).message;
			} finally {
				subscription.dispose();
				this.active = undefined;
			}
		});
		this.output.finish(entry.status, result, failure);
		const report = [
			`# ${name}\n\n**Status** ${entry.status}  \n**Started** ${entry.startedAt}`,
			mode && `**Mode** ${mode}`, `## Request\n\n${task}`,
			failure && `## Run ended\n\n${failure}`,
			result && `## ${mode ? 'Human testing plan' : 'Output'}\n\n${result}`,
			`## Workspace edits\n\n${await workspace.summary()}`,
			...stages.map(stage => [
				`## ${stage.name}${stage.attempt ? ` · Attempt ${stage.attempt}` : ''}`,
				`**Agent** ${stage.agent}${stage.model ? `  \n**Model** ${stage.model}` : ''}`,
				stage.error ?? (stage.output === result ? 'See the output above.' : stage.output),
			].filter(Boolean).join('\n\n')),
		].filter(Boolean).join('\n\n') + '\n';
		const uri = this.reportUri(entry.id);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(report));
		const saved: PersistedRun = { name, mode, task, status: entry.status, stages, result, failure };
		await vscode.workspace.fs.writeFile(this.runDataUri(entry.id), Buffer.from(JSON.stringify(saved)));
		await this.state.updateRuns(entry);
		await this.openReport(entry.id);
		if (entry.status === 'Failed') {
			void vscode.window.showErrorMessage(`${name} failed. See the run report.`);
		}
	}

	private reportUri(id: string): vscode.Uri {
		const storage = this.state.context.storageUri;
		if (!storage) {
			throw new Error('Open a workspace folder to view its run reports.');
		}
		return vscode.Uri.joinPath(storage, 'runs', `${id}.md`);
	}

	private runDataUri(id: string): vscode.Uri {
		return vscode.Uri.joinPath(this.reportUri(id), '..', `${id}.json`);
	}

	private async chooseRun(title: string, id?: string): Promise<string | undefined> {
		return id ?? pick(title, this.state.runs.map(run =>
			choice(run.name, run.id, `${run.status} · ${new Date(run.startedAt).toLocaleString()}`)));
	}

	private async loadRun(id: string): Promise<PersistedRun | undefined> {
		try {
			return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.runDataUri(id))).toString()) as PersistedRun;
		} catch {
			return undefined;
		}
	}

	/** Clicking a run loads its full output into the Output panel. */
	private async openRun(id?: string): Promise<void> {
		id = await this.chooseRun('Run output', id);
		if (!id) {
			return;
		}
		const saved = await this.loadRun(id);
		if (!saved) {
			await this.openReport(id);
			return;
		}
		await this.showPanel('output');
		await this.output.show();
		this.output.load(saved);
	}

	private async compareRuns(): Promise<void> {
		if (this.state.runs.length < 2) {
			throw new Error('Run at least two workflows before comparing runs.');
		}
		const first = await this.chooseRun('Compare: first run (A)');
		if (!first) {
			return;
		}
		const second = await this.chooseRun('Compare: second run (B)');
		if (!second || second === first) {
			return;
		}
		const [a, b] = [await this.loadRun(first), await this.loadRun(second)];
		if (!a || !b) {
			throw new Error('Those runs have no saved output to compare.');
		}
		const uri = vscode.Uri.joinPath(this.reportUri(first), '..', `compare-${first}-${second}.md`);
		await vscode.workspace.fs.writeFile(uri, Buffer.from(compareRuns(a, b)));
		await vscode.window.showTextDocument(uri, { preview: false });
	}

	/** Opens the full Markdown report (request, workspace edits, every stage) in the editor. */
	private async openReport(id?: string): Promise<void> {
		id = await this.chooseRun('Run reports', id);
		if (id) {
			await vscode.window.showTextDocument(this.reportUri(id), { preview: false });
		}
	}
}
