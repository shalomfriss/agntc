export interface Agent {
	id: string;
	name: string;
	instructions: string;
	providerId?: string;
	model?: string;
	access: 'read' | 'write';
	subagents: string[];
	/** When set (>= 1), the agent may dynamically spawn up to this many ad-hoc worker subagents at runtime. */
	maxSubagents?: number;
	/** Ids of installed skills (SKILL.md folders) whose guidance is injected into this agent's prompt. */
	skills?: string[];
}

export type StepKind = 'agent' | 'input' | 'condition' | 'tool' | 'human';

export interface WorkflowStep {
	id: string;
	name: string;
	/** Defaults to 'agent' for stored steps that predate input nodes. */
	kind?: StepKind;
	/** Present for agent steps; absent for input nodes. */
	agentId?: string;
	inputs: string[];
	/** Id of the artifact type this step produces (see contracts.ts). Defaults to Text. */
	outputType?: string;
	/** Optional canvas coordinates for visual layout. */
	x?: number;
	y?: number;
}

export interface Workflow {
	id: string;
	name: string;
	steps: WorkflowStep[];
}

export function stepKind(step: WorkflowStep): StepKind {
	return step.kind ?? 'agent';
}

export function isInputStep(step: WorkflowStep): boolean {
	return stepKind(step) === 'input';
}

export type PlanningMode = 'Unstructure' | 'OpenSpec' | 'SpecKit';
export type FactoryRole = 'planner' | 'coder' | 'judge' | 'tester';

export interface FactorySettings {
	agents: Record<FactoryRole, string>;
	maxRevisions: number;
}

export interface Workbench {
	agents: Agent[];
	workflows: Workflow[];
	factory: FactorySettings;
}

export const factoryId = 'code-factory';
export const factoryRoles: Record<FactoryRole, string> = {
	planner: 'Planning Agent',
	coder: 'Coding Agent',
	judge: 'LLM Judge',
	tester: 'Testing Agent',
};

export const modes: PlanningMode[] = ['Unstructure', 'OpenSpec', 'SpecKit'];

export function defaultWorkbench(): Workbench {
	return {
		agents: [
			{ id: 'planner', name: factoryRoles.planner, access: 'read', subagents: [],
				instructions: 'Inspect the workspace, identify requirements and risks, and produce an actionable implementation plan.' },
			{ id: 'coder', name: factoryRoles.coder, access: 'write', subagents: [],
				instructions: 'Implement the plan in the workspace. Inspect source and existing conventions first. Use the file tools for actual edits.' },
			{ id: 'judge', name: factoryRoles.judge, access: 'read', subagents: [],
				instructions: 'Independently review the implementation against the original request and the plan. Inspect actual files and changes.' },
			{ id: 'tester', name: factoryRoles.tester, access: 'read', subagents: [],
				instructions: 'Write a Markdown testing guide for a human who has never seen this task. Use evidence from the approved implementation.' },
		],
		workflows: [],
		factory: { agents: { planner: 'planner', coder: 'coder', judge: 'judge', tester: 'tester' }, maxRevisions: 2 },
	};
}

export function getAgent(agents: Agent[], id: string): Agent {
	const agent = agents.find(value => value.id === id);
	if (!agent) {
		throw new Error(`Agent "${id}" no longer exists.`);
	}
	return agent;
}

export function validateSubagents(agents: Agent[]): void {
	orderedGraph(agents, agent => agent.subagents, 'Subagents');
}

export function orderedSteps(workflow: Workflow): WorkflowStep[] {
	return orderedGraph(workflow.steps, step => step.inputs, 'Workflow steps');
}

function orderedGraph<T extends { id: string; name: string }>(
	nodes: T[], inputs: (node: T) => string[], label: string,
): T[] {
	const byId = new Map(nodes.map(node => [node.id, node]));
	if (byId.size !== nodes.length) {
		throw new Error(`${label} must have unique IDs.`);
	}
	const ordered: T[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();
	function visit(node: T): void {
		if (visited.has(node.id)) {
			return;
		}
		if (visiting.has(node.id)) {
			throw new Error(`${label} contain a cycle at "${node.name}".`);
		}
		visiting.add(node.id);
		for (const id of inputs(node)) {
			const input = byId.get(id);
			if (!input) {
				throw new Error(`"${node.name}" references a missing item "${id}".`);
			}
			visit(input);
		}
		visiting.delete(node.id);
		visited.add(node.id);
		ordered.push(node);
	}
	nodes.forEach(visit);
	return ordered;
}
