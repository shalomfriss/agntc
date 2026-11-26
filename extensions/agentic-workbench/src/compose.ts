import { randomUUID } from 'node:crypto';
import { artifactTypes } from './contracts';
import { StepKind, Workflow, WorkflowStep } from './model';

const kinds: StepKind[] = ['agent', 'input', 'condition', 'tool', 'human', 'subworkflow'];
const defaultOutput: Partial<Record<StepKind, string>> = { condition: 'GateResult', tool: 'TestReport', human: 'ReviewReport' };

interface DraftStep {
	name?: unknown;
	kind?: unknown;
	agent?: unknown;
	inputs?: unknown;
	outputType?: unknown;
	command?: unknown;
}

/** Parses a model's JSON proposal into a validated Workflow, resolving agent and step references by name. */
export function parseWorkflowDraft(text: string, agents: Array<{ id: string; name: string }>): Workflow {
	const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	let data: { name?: unknown; steps?: unknown };
	try {
		data = JSON.parse(fenced ? fenced[1] : text);
	} catch {
		throw new Error('The model did not return valid workflow JSON.');
	}
	if (!data || typeof data.name !== 'string' || !data.name.trim() || !Array.isArray(data.steps) || !data.steps.length) {
		throw new Error('The generated workflow needs a name and at least one step.');
	}
	const agentByName = new Map(agents.map(agent => [agent.name.toLowerCase(), agent.id]));
	const stepIds = new Map<string, string>();
	const drafts = (data.steps as DraftStep[]).map((draft, index) => {
		if (!draft || typeof draft.name !== 'string' || !draft.name.trim()) {
			throw new Error(`Generated step ${index + 1} is missing a name.`);
		}
		const id = randomUUID();
		stepIds.set(draft.name.trim().toLowerCase(), id);
		return { id, draft };
	});
	const steps: WorkflowStep[] = drafts.map(({ id, draft }, index) => {
		const kind: StepKind = typeof draft.kind === 'string' && kinds.includes(draft.kind as StepKind) ? draft.kind as StepKind : 'agent';
		const step: WorkflowStep = { id, name: (draft.name as string).trim(), kind, inputs: [], x: 24, y: 24 + index * 128 };
		if (kind === 'agent') {
			const agentId = typeof draft.agent === 'string' ? agentByName.get(draft.agent.toLowerCase()) : undefined;
			if (!agentId) {
				throw new Error(`Step "${step.name}" references an unknown agent "${String(draft.agent ?? '')}". Create that agent first or revise the description.`);
			}
			step.agentId = agentId;
		}
		const requested = typeof draft.outputType === 'string' && artifactTypes[draft.outputType] ? draft.outputType : defaultOutput[kind];
		step.outputType = requested && requested !== 'Text' ? requested : undefined;
		if (kind === 'tool') {
			step.command = typeof draft.command === 'string' ? draft.command : '';
		}
		if (Array.isArray(draft.inputs)) {
			step.inputs = draft.inputs
				.map(name => (typeof name === 'string' ? stepIds.get(name.trim().toLowerCase()) : undefined))
				.filter((value): value is string => Boolean(value) && value !== id);
		}
		return step;
	});
	return { id: randomUUID(), name: (data.name as string).trim(), steps };
}

/** The instruction given to the model so it returns a workflow this parser can accept. */
export function composeSystemPrompt(agents: Array<{ name: string }>): string {
	return [
		'You design agent workflows. Return exactly one JSON object and no prose.',
		'Shape: {"name": string, "steps": [{"name": string, "kind": string, "agent"?: string, "inputs"?: string[], "outputType"?: string, "command"?: string}]}.',
		`"kind" is one of: ${kinds.join(', ')}. For an "agent" step, "agent" must be one of the available agents by name.`,
		`Available agents: ${agents.map(agent => agent.name).join(', ') || '(none — avoid agent steps)'}.`,
		`"inputs" lists the names of upstream steps whose output feeds this step. "outputType" is one of: ${Object.keys(artifactTypes).join(', ')}.`,
		'Use a "tool" step with a "command" to run tests, a "condition" step as a quality gate, and a "human" step for a review decision.',
	].join('\n');
}
