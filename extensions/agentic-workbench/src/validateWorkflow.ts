import { orderedSteps, stepKind, Workflow } from './model';

const runnable = new Set(['agent', 'condition', 'tool', 'human', 'subworkflow']);

/** Returns a list of problems that would stop a workflow from running; empty means it is ready. */
export function validateWorkflow(workflow: Workflow, agentIds: Set<string>): string[] {
	const issues: string[] = [];
	const ids = new Set(workflow.steps.map(step => step.id));
	for (const step of workflow.steps) {
		const kind = stepKind(step);
		if (kind === 'agent' && (!step.agentId || !agentIds.has(step.agentId))) {
			issues.push(`"${step.name}" needs a valid agent.`);
		}
		if (kind === 'tool' && !step.command?.trim()) {
			issues.push(`"${step.name}" needs a command.`);
		}
		if (kind === 'subworkflow' && !step.workflowId) {
			issues.push(`"${step.name}" needs a workflow to run.`);
		}
		if (kind === 'condition' && step.inputs.length === 0) {
			issues.push(`"${step.name}" has no inputs to evaluate.`);
		}
		if (step.inputs.some(id => !ids.has(id))) {
			issues.push(`"${step.name}" has a dangling connection.`);
		}
	}
	try {
		orderedSteps(workflow);
	} catch (error) {
		issues.push((error as Error).message);
	}
	if (!workflow.steps.some(step => runnable.has(stepKind(step)))) {
		issues.push('Add at least one runnable step.');
	}
	return [...new Set(issues)];
}
