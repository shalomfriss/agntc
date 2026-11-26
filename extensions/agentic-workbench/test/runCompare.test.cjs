const assert = require('node:assert/strict');
const { test } = require('node:test');
const { compareRuns } = require('../out-test/runCompare.js');

test('compareRuns reports status, stage, and result differences', () => {
	const a = {
		name: 'Run 1', status: 'Succeeded', task: 'Add offline support',
		stages: [{ name: 'Plan', output: 'spec' }, { name: 'Code', output: 'v1' }], result: 'done',
	};
	const b = {
		name: 'Run 2', status: 'Failed', task: 'Add offline support',
		stages: [{ name: 'Plan', output: 'spec' }, { name: 'Code', output: 'v2' }, { name: 'Review', output: 'r' }], failure: 'oops',
	};
	const md = compareRuns(a, b);
	assert.match(md, /\*\*A\*\* Run 1 · Succeeded/);
	assert.match(md, /\*\*Plan\*\* — unchanged/);
	assert.match(md, /\*\*Code\*\* — changed/);
	assert.match(md, /\*\*Review\*\* — only in B/);
	assert.match(md, /Final results differ/);
});
