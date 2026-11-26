const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateWorkflow } = require('../out-test/validateWorkflow.js');

test('validateWorkflow flags missing agents, commands, workflows, and dangling links', () => {
	const agents = new Set(['a1']);
	const issues = validateWorkflow({
		id: 'w', name: 'W',
		steps: [
			{ id: 's1', name: 'Plan', kind: 'agent', agentId: 'a1', inputs: [] },
			{ id: 's2', name: 'Build', kind: 'agent', inputs: ['s1'] },
			{ id: 's3', name: 'Tests', kind: 'tool', command: '', inputs: ['s2'] },
			{ id: 's4', name: 'Sub', kind: 'subworkflow', inputs: ['s3'] },
			{ id: 's5', name: 'Gate', kind: 'condition', inputs: ['ghost'] },
		],
	}, agents);
	assert.ok(issues.some(issue => /Build.*agent/.test(issue)));
	assert.ok(issues.some(issue => /Tests.*command/.test(issue)));
	assert.ok(issues.some(issue => /Sub.*workflow/.test(issue)));
	assert.ok(issues.some(issue => /Gate.*dangling/.test(issue)));
});

test('validateWorkflow passes a well-formed workflow and catches cycles', () => {
	const agents = new Set(['a1']);
	assert.deepEqual(validateWorkflow({
		id: 'ok', name: 'OK', steps: [{ id: 's1', name: 'Plan', kind: 'agent', agentId: 'a1', inputs: [] }],
	}, agents), []);
	const cyclic = validateWorkflow({
		id: 'c', name: 'C',
		steps: [
			{ id: 'a', name: 'A', kind: 'agent', agentId: 'a1', inputs: ['b'] },
			{ id: 'b', name: 'B', kind: 'agent', agentId: 'a1', inputs: ['a'] },
		],
	}, agents);
	assert.ok(cyclic.some(issue => /cycle/.test(issue)));
});
