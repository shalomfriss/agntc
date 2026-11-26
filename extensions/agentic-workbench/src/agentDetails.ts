import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { Agent, FactoryRole, factoryRoles, getAgent, Workbench } from './model';
import { discoverModels, usesApiKey } from './providers';
import { discoverSkills, Skill } from './skills';
import { State } from './state';

export const agentDetailsViewId = 'agentic.agentDetails';

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[character]!);
}

function usages(workbench: Workbench, id: string) {
	return [
		...(Object.entries(workbench.factory.agents) as [FactoryRole, string][])
			.filter(([, agentId]) => agentId === id)
			.map(([role]) => ({ label: vscode.l10n.t("Code Factory"), detail: factoryRoles[role] })),
		...workbench.workflows.flatMap(workflow => workflow.steps
			.filter(step => step.agentId === id).map(step => ({ label: workflow.name, detail: step.name }))),
		...workbench.agents.filter(parent => parent.subagents.includes(id))
			.map(parent => ({ label: parent.name, detail: vscode.l10n.t("Parent agent"), agentId: parent.id })),
	];
}

function agentDraft(value: unknown): Omit<Agent, 'id'> {
	if (!value || typeof value !== 'object') {
		throw new Error(vscode.l10n.t("Enter the agent details."));
	}
	const { name, instructions, providerId, model, access, subagents, maxSubagents } = value as Record<string, unknown>;
	if (typeof name !== 'string' || !name.trim()) {
		throw new Error(vscode.l10n.t("Enter a name for this agent."));
	}
	if (typeof instructions !== 'string' || !instructions.trim()) {
		throw new Error(vscode.l10n.t("Enter instructions for this agent."));
	}
	if (access !== 'read' && access !== 'write') {
		throw new Error(vscode.l10n.t("Choose a workspace access level."));
	}
	if (!Array.isArray(subagents) || subagents.some(id => typeof id !== 'string')) {
		throw new Error(vscode.l10n.t("Choose subagents from the agent list."));
	}
	const { skills } = value as Record<string, unknown>;
	if (!Array.isArray(skills) || skills.some(id => typeof id !== 'string')) {
		throw new Error(vscode.l10n.t("Choose skills from the available list."));
	}
	let cap: number | undefined;
	if (maxSubagents !== undefined && maxSubagents !== null && maxSubagents !== '') {
		cap = typeof maxSubagents === 'number' ? maxSubagents : Number(maxSubagents);
		if (!Number.isInteger(cap) || cap < 1 || cap > 50) {
			throw new Error(vscode.l10n.t("Maximum dynamic subagents must be a whole number from 1 to 50, or left empty."));
		}
	}
	return {
		name: name.trim(), instructions: instructions.trim(), access, subagents: [...new Set<string>(subagents)],
		skills: [...new Set<string>(skills)],
		providerId: typeof providerId === 'string' && providerId ? providerId : undefined,
		model: typeof model === 'string' ? model.trim() || undefined : undefined,
		maxSubagents: cap,
	};
}

export class AgentDetailsView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view?: vscode.WebviewView;
	private selection?: string;
	private skills?: Skill[];
	private readonly stateListener: vscode.Disposable;

	constructor(private readonly state: State) {
		this.stateListener = state.onChange(() => this.sendSnapshot());
	}

	dispose(): void {
		this.stateListener.dispose();
	}

	async show(id?: string): Promise<void> {
		const { agents } = this.state.workbench;
		this.selection = id ?? this.selection ?? agents[0]?.id ?? 'new';
		if (this.view) {
			this.view.show(this.selection !== 'new');
			this.sendSnapshot();
		} else {
			await vscode.commands.executeCommand(`${agentDetailsViewId}.focus`, { preserveFocus: this.selection !== 'new' });
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

	private sendSnapshot(): void {
		if (!this.view) {
			return;
		}
		const workbench = this.state.workbench;
		const { profiles, defaultId } = this.state.providers;
		if (!this.selection || (this.selection !== 'new' && !workbench.agents.some(agent => agent.id === this.selection))) {
			this.selection = workbench.agents[0]?.id ?? 'new';
		}
		void this.view.webview.postMessage({
			type: 'snapshot', selection: this.selection, agents: workbench.agents, defaultId,
			profiles: profiles.map(({ id, name, kind, model }) => ({
				id, name, model, hasCatalog: kind === 'copilot' || usesApiKey(kind),
			})),
			usedBy: usages(workbench, this.selection),
			skills: this.skills ?? [],
		});
		if (!this.skills) {
			void discoverSkills().then(skills => {
				this.skills = skills;
				this.sendSnapshot();
			}, () => { this.skills = []; });
		}
	}

	private async receive(view: vscode.WebviewView, message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') {
			return;
		}
		const { type, key, draft, providerId, requestId } = message as Record<string, unknown>;
		const respond = (value: object) => view.webview.postMessage(value);
		try {
			switch (type) {
				case 'ready':
					if (!this.selection && typeof key === 'string') {
						this.selection = key;
					}
					this.sendSnapshot();
					break;
				case 'select':
					if (typeof key === 'string') {
						await this.show(key);
					}
					break;
				case 'save':
					if (typeof key === 'string') {
						const saved = await this.save(key, agentDraft(draft));
						if (this.selection === key) {
							this.selection = saved.id;
						}
						await respond({ type: 'saved', key, id: saved.id });
						this.sendSnapshot();
					}
					break;
				case 'delete':
					if (typeof key === 'string' && key !== 'new') {
						const deleted = await this.deleteAgent(key);
						await respond({ type: 'deleted', key, deleted });
						this.sendSnapshot();
					}
					break;
				case 'run':
					if (typeof key === 'string' && key !== 'new') {
						await vscode.commands.executeCommand('agentic.runAgent', key);
					}
					break;
				case 'connect':
					await vscode.commands.executeCommand('agentic.connectProvider');
					break;
				case 'models':
					if (typeof providerId === 'string' && typeof requestId === 'number') {
						const profile = this.state.providers.profiles.find(value => value.id === providerId);
						if (!profile) {
							throw new Error(vscode.l10n.t("Choose a connected provider."));
						}
						const models = await discoverModels(profile, await this.state.secret(profile.id));
						await respond({ type: 'models', providerId, requestId, models });
					}
					break;
			}
		} catch (error) {
			await respond({ type: 'error', action: type, key, providerId, requestId, text: (error as Error).message });
		}
	}

	private async save(key: string, draft: Omit<Agent, 'id'>): Promise<Agent> {
		const saved = { ...draft, id: key === 'new' ? randomUUID() : key };
		await this.state.updateWorkbench(workbench => {
			const existing = key === 'new' ? undefined : getAgent(workbench.agents, key);
			if (saved.providerId && saved.providerId !== existing?.providerId &&
				!this.state.providers.profiles.some(profile => profile.id === saved.providerId)) {
				throw new Error(vscode.l10n.t("The selected provider was disconnected. Choose another provider."));
			}
			if (existing) {
				Object.assign(existing, saved);
			} else {
				workbench.agents.push(saved);
			}
		});
		return saved;
	}

	private async deleteAgent(id: string): Promise<boolean> {
		const name = getAgent(this.state.workbench.agents, id).name;
		const confirm = vscode.l10n.t("Delete Agent");
		if (await vscode.window.showWarningMessage(vscode.l10n.t("Delete \"{0}\"?", name), { modal: true }, confirm) !== confirm) {
			return false;
		}
		await this.state.updateWorkbench(workbench => {
			if (usages(workbench, id).length) {
				throw new Error(vscode.l10n.t("Unlink this agent before deleting it."));
			}
			workbench.agents = workbench.agents.filter(agent => agent.id !== id);
		});
		return true;
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'agent-details.css'));
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'agent-details.js'));
		const wording = {
			providerDefault: vscode.l10n.t("Provider default"),
			providerDefaultModel: vscode.l10n.t("Provider default ({0})", "{0}"),
			customModel: vscode.l10n.t("Enter a model ID…"),
			loadingModels: vscode.l10n.t("Loading…"),
			refreshModels: vscode.l10n.t("Refresh Models"),
			loadModels: vscode.l10n.t("Load Models"),
			noModels: vscode.l10n.t("This provider returned no models. Enter a model ID to override."),
			overrideModel: vscode.l10n.t("Enter a model ID to override the default."),
			workbenchDefault: vscode.l10n.t("Workbench default"),
			workbenchDefaultProvider: vscode.l10n.t("Workbench default ({0})", "{0}"),
			disconnectedProvider: vscode.l10n.t("Disconnected provider"),
			providerDisconnected: vscode.l10n.t("This provider is disconnected."),
			providerRequired: vscode.l10n.t("Connect a provider to run this agent."),
			addProvider: vscode.l10n.t("Add Provider"),
			connectProvider: vscode.l10n.t("Connect a Provider"),
			writeAccess: vscode.l10n.t("Can change files in a trusted workspace."),
			readAccess: vscode.l10n.t("Can inspect workspace files. Delegated work inherits this limit."),
			unlink: vscode.l10n.t("Unlink"),
			unlinkNamed: vscode.l10n.t("Unlink {0}", "{0}"),
			chooseSubagent: vscode.l10n.t("Choose an agent…"),
			noSubagents: vscode.l10n.t("No available agents"),
			circularLink: vscode.l10n.t("{0} (circular link)", "{0}"),
			subagentProvider: vscode.l10n.t("Each subagent uses its own provider and model."),
			createSubagent: vscode.l10n.t("Create another agent or unlink an existing subagent."),
			dynamicSubagents: vscode.l10n.t("Leave empty to disable. When set, this agent can launch that many ad-hoc worker subagents at runtime."),
			chooseSkill: vscode.l10n.t("Add a skill…"),
			noSkills: vscode.l10n.t("No skills found in ~/.claude/skills, ~/.codex/skills, or .claude/skills."),
			skillsHint: vscode.l10n.t("Selected skills' guidance is added to this agent's instructions when it runs, for any provider."),
			unavailableSkill: vscode.l10n.t("Unavailable skill"),
			unavailableAgent: vscode.l10n.t("Unavailable agent"),
			deletedAgent: vscode.l10n.t("Deleted"),
			saveBeforeRun: vscode.l10n.t("Save changes before running this agent."),
			run: vscode.l10n.t("Run this agent."),
			agentDetails: vscode.l10n.t("Agent Details"),
			newAgent: vscode.l10n.t("New agent"),
			deleteInProgress: vscode.l10n.t("Deleting…"),
			saveInProgress: vscode.l10n.t("Saving…"),
			saveChanges: vscode.l10n.t("Save Changes"),
			saveAgent: vscode.l10n.t("Save Agent"),
			unlinkBeforeDelete: vscode.l10n.t("Unlink this agent from its parent agents and workflows before deleting it."),
			delete: vscode.l10n.t("Delete this agent."),
			saved: vscode.l10n.t("Agent saved."),
			discarded: vscode.l10n.t("Changes discarded."),
			nameRequired: vscode.l10n.t("Enter an agent name."),
			instructionsRequired: vscode.l10n.t("Enter instructions."),
		};
		const localized = escapeHtml(JSON.stringify(wording));
		return `<!doctype html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
	<link rel="stylesheet" href="${style}">
	<script defer src="${script}"></script>
	<title>${escapeHtml(vscode.l10n.t("Agent Details"))}</title>
</head>
<body>
	<form id="details" data-localized="${localized}" hidden>
		<header>
			<div class="selection">
				<div class="field"><label for="agent">${escapeHtml(vscode.l10n.t("Agent"))}</label><select id="agent"></select></div>
				<button type="button" class="secondary" id="new-agent">${escapeHtml(vscode.l10n.t("New Agent"))}</button>
			</div>
		</header>
		<div class="scroll" id="form-body">
			<div class="heading">
				<h1 id="agent-name"></h1>
				<button type="button" class="secondary" id="run" title="${escapeHtml(vscode.l10n.t("Run this agent"))}">${escapeHtml(vscode.l10n.t("Run Agent"))}</button>
			</div>
			<fieldset>
				<legend>${escapeHtml(vscode.l10n.t("Identity"))}</legend>
				<div class="field"><label for="name">${escapeHtml(vscode.l10n.t("Name"))}</label><input id="name" required autocomplete="off" placeholder="${escapeHtml(vscode.l10n.t("e.g. API reviewer"))}"></div>
				<div class="field">
					<label for="instructions">${escapeHtml(vscode.l10n.t("Instructions"))}</label>
					<textarea id="instructions" required spellcheck="false" rows="3" placeholder="${escapeHtml(vscode.l10n.t("Describe what this agent should do"))}"></textarea>
				</div>
			</fieldset>
			<fieldset>
				<legend>${escapeHtml(vscode.l10n.t("Model and access"))}</legend>
				<div class="field">
					<label for="provider">${escapeHtml(vscode.l10n.t("Provider"))}</label><select id="provider" aria-describedby="provider-hint"></select>
					<p id="provider-hint" class="hint"></p>
					<button type="button" class="text-button" id="connect">${escapeHtml(wording.connectProvider)}</button>
				</div>
				<div class="field">
					<div class="label-row"><label for="model">${escapeHtml(vscode.l10n.t("Model"))}</label><button type="button" id="load-models" class="text-button" hidden>${escapeHtml(wording.loadModels)}</button></div>
					<select id="model" aria-describedby="model-hint"></select>
					<div id="custom-model" class="field" hidden>
						<label for="model-id">${escapeHtml(vscode.l10n.t("Model ID"))}</label><input id="model-id" autocomplete="off" spellcheck="false">
					</div>
					<p id="model-hint" class="hint" role="status"></p>
				</div>
				<div class="field">
					<label for="access">${escapeHtml(vscode.l10n.t("Workspace access"))}</label>
					<select id="access" aria-describedby="access-hint">
						<option value="read">${escapeHtml(vscode.l10n.t("Read Files"))}</option>
						<option value="write">${escapeHtml(vscode.l10n.t("Read and Edit Files"))}</option>
					</select>
					<p id="access-hint" class="hint"></p>
				</div>
			</fieldset>
			<fieldset>
				<legend>${escapeHtml(vscode.l10n.t("Delegation"))} <span id="subagent-count" class="count"></span></legend>
				<div class="field">
					<label for="subagent">${escapeHtml(vscode.l10n.t("Add a subagent"))}</label>
					<select id="subagent" aria-describedby="subagent-hint"></select>
					<p id="subagent-hint" class="hint"></p>
				</div>
				<ul id="subagents" class="relationships" aria-label="${escapeHtml(vscode.l10n.t("Linked subagents"))}"></ul>
				<div class="field">
					<label for="max-subagents">${escapeHtml(vscode.l10n.t("Max dynamic subagents"))}</label>
					<input id="max-subagents" type="number" min="1" max="50" step="1" inputmode="numeric" autocomplete="off" aria-describedby="max-subagents-hint" placeholder="${escapeHtml(vscode.l10n.t("Off"))}">
					<p id="max-subagents-hint" class="hint">${escapeHtml(wording.dynamicSubagents)}</p>
				</div>
			</fieldset>
			<fieldset>
				<legend>${escapeHtml(vscode.l10n.t("Skills"))} <span id="skill-count" class="count"></span></legend>
				<div class="field">
					<label for="skill">${escapeHtml(vscode.l10n.t("Add a skill"))}</label>
					<select id="skill" aria-describedby="skill-hint"></select>
					<p id="skill-hint" class="hint">${escapeHtml(wording.skillsHint)}</p>
				</div>
				<ul id="skills" class="relationships" aria-label="${escapeHtml(vscode.l10n.t("Selected skills"))}"></ul>
			</fieldset>
			<section id="usage" hidden aria-labelledby="usage-label">
				<h2 id="usage-label">${escapeHtml(vscode.l10n.t("Used by"))}</h2><ul id="dependencies" class="relationships"></ul>
			</section>
		</div>
		<footer>
			<p id="status" role="status" aria-live="polite"></p>
			<div class="actions">
				<button id="save" type="submit">${escapeHtml(wording.saveChanges)}</button>
				<button id="discard" class="secondary" type="button">${escapeHtml(vscode.l10n.t("Discard"))}</button>
				<button id="delete" class="text-button delete" type="button">${escapeHtml(vscode.l10n.t("Delete"))}</button>
			</div>
		</footer>
	</form>
</body>
</html>`;
	}
}
