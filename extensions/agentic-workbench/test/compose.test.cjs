const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseWorkflowDraft, composeSystemPrompt } = require('../out-test/compose.js');

const agents = [{ id: 'a1', name: 'Planner' }, { id: 'a2', name: 'Coder' }];

test('parseWorkflowDraft builds a workflow, resolving agents and input references by name', () => {
	const text = '```json\n' + JSON.stringify({
		name: 'Feature delivery',
		steps: [
			{ name: 'Plan', kind: 'agent', agent: 'Planner', outputType: 'FeatureSpec', inputs: [] },
			{ name: 'Build', kind: 'agent', agent: 'Coder', outputType: 'ChangeSet', inputs: ['Plan'] },
			{ name: 'Tests', kind: 'tool', command: 'swift test', inputs: ['Build'] },
			{ name: 'Gate', kind: 'condition', inputs: ['Tests'] },
		],
	}) + '\n```';
	const workflow = parseWorkflowDraft(text, agents);
	assert.equal(workflow.name, 'Feature delivery');
	assert.equal(workflow.steps.length, 4);
	const build = workflow.steps.find(step => step.name === 'Build');
	assert.equal(build.agentId, 'a2');
	assert.equal(build.outputType, 'ChangeSet');
	assert.equal(build.inputs.length, 1);
	assert.equal(workflow.steps.find(step => step.name === 'Tests').command, 'swift test');
	assert.equal(workflow.steps.find(step => step.name === 'Gate').outputType, 'GateResult');
});

test('parseWorkflowDraft rejects invalid JSON and unknown agents', () => {
	assert.throws(() => parseWorkflowDraft('sorry, here is a plan', agents), /valid workflow JSON/);
	assert.throws(() => parseWorkflowDraft(JSON.stringify({
		name: 'X', steps: [{ name: 'S', kind: 'agent', agent: 'Nobody', inputs: [] }],
	}), agents), /unknown agent/);
});

test('composeSystemPrompt lists the available agents and step kinds', () => {
	const prompt = composeSystemPrompt(agents);
	assert.match(prompt, /Planner, Coder/);
	assert.match(prompt, /subworkflow/);
});
