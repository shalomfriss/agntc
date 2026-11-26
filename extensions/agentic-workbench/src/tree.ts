import * as vscode from 'vscode';
import { Agent, factoryId, factoryRoles, getAgent, isInputStep, WorkflowStep } from './model';
import { State } from './state';

type Kind = 'providers' | 'agents' | 'workflows' | 'runs' | 'provider' | 'agent' | 'workflow' | 'run' | 'step';

export class WorkbenchItem extends vscode.TreeItem {
	constructor(
		readonly kind: Kind,
		readonly key: string,
		label: string,
		readonly children: WorkbenchItem[] = [],
		icon?: string,
		readonly itemId = key,
		readonly loadChildren?: () => WorkbenchItem[],
	) {
		super(label, children.length || loadChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		this.contextValue = kind;
		this.id = `${kind}/${itemId}`;
		if (icon) {
			this.iconPath = new vscode.ThemeIcon(icon);
		}
	}

	action(command: string, title: string): this {
		this.command = { command, title, arguments: [this] };
		return this;
	}
}

export class WorkbenchTree implements vscode.TreeDataProvider<WorkbenchItem> {
	readonly onDidChangeTreeData: vscode.Event<void>;

	constructor(private readonly state: State) {
		this.onDidChangeTreeData = state.onChange;
	}

	getTreeItem(item: WorkbenchItem): WorkbenchItem {
		return item;
	}

	getChildren(parent?: WorkbenchItem): WorkbenchItem[] {
		if (parent) {
			return parent.loadChildren?.() ?? parent.children;
		}
		const { profiles, defaultId } = this.state.providers;
		const workbench = this.state.workbench;
		const agentItem = (agent: Agent, chain: string[], role?: string): WorkbenchItem => {
			const ancestry = [...chain, agent.id];
			const item = new WorkbenchItem('agent', agent.id, role ?? agent.name, [], 'hubot', ancestry.join('/'),
				agent.subagents.length ? () => agent.subagents.map(id => agentItem(getAgent(workbench.agents, id), ancestry)) : undefined);
			const provider = profiles.find(value => value.id === (agent.providerId ?? defaultId));
			item.description = [role && role !== agent.name ? agent.name : '', provider?.name ?? 'Provider required', agent.model].filter(Boolean).join(' · ');
			item.tooltip = agent.instructions;
			item.accessibilityInformation = { label: [role ?? agent.name, item.description].filter(Boolean).join(', ') };
			return item.action('agentic.editAgent', 'Open Agent Details');
		};
		const custom = workbench.workflows.map(workflow => {
			const stepItem = (step: WorkflowStep) => {
				const upstream = step.inputs.map(id => workflow.steps.find(value => value.id === id)?.name).filter(Boolean).join(', ');
				if (isInputStep(step)) {
					const item = new WorkbenchItem('step', step.id, step.name, [], 'edit', `${workflow.id}/${step.id}`);
					item.description = 'User input';
					return item;
				}
				const agent = getAgent(workbench.agents, step.agentId!);
				const item = new WorkbenchItem('step', step.id, step.name, [], 'arrow-right', `${workflow.id}/${step.id}`);
				item.description = upstream ? `${agent.name} ← ${upstream}` : agent.name;
				return item;
			};
			return new WorkbenchItem('workflow', workflow.id, workflow.name, workflow.steps.map(stepItem), 'type-hierarchy')
				.action('agentic.openWorkflowCanvas', 'Open Workflow Canvas');
		});
		const factory = new WorkbenchItem('workflow', factoryId, 'Code Factory',
			Object.entries(workbench.factory.agents).map(([role, id]) =>
				agentItem(getAgent(workbench.agents, id), [factoryId, role], factoryRoles[role as keyof typeof factoryRoles])),
			'type-hierarchy').action('agentic.editWorkflow', 'Manage Code Factory');
		const providerItems = profiles.map(profile => {
			const item = new WorkbenchItem('provider', profile.id, profile.name, [], 'plug');
			item.description = [profile.id === defaultId && 'Default', profile.model].filter(Boolean).join(' · ');
			return item.action('agentic.editProvider', 'Manage Provider');
		});
		const runs = this.state.runs.map(run => {
			const item = new WorkbenchItem('run', run.id, run.name, [], run.status === 'Succeeded' ? 'pass' : 'circle-slash');
			item.description = `${run.status} · ${new Date(run.startedAt).toLocaleString()}`;
			return item.action('agentic.openRun', 'Open Run Output');
		});
		const groups = [
			new WorkbenchItem('workflows', 'workflows', 'Workflows', [factory, ...custom], 'type-hierarchy'),
			new WorkbenchItem('agents', 'agents', 'Agents', workbench.agents.map(agent => agentItem(agent, ['agents'])), 'hubot'),
			new WorkbenchItem('providers', 'providers', 'Providers', providerItems, 'plug'),
			new WorkbenchItem('runs', 'runs', 'Runs', runs, 'history'),
		];
		groups[0].collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		groups[1].collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
		for (const [item, command, title] of [
			[groups[1], 'agentic.createAgent', 'Create Agent'],
			[groups[2], 'agentic.connectProvider', 'Connect Provider'],
			[groups[3], 'agentic.openRun', 'Open Run Output'],
		] as const) {
			if (!item.children.length) {
				item.action(command, title);
			}
		}
		return groups;
	}
}
