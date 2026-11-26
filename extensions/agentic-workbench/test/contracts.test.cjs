const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validate, checkArtifact, contractInstruction, artifactTypes } = require('../out-test/contracts.js');

test('the schema validator reports type, required, enum, and array errors', () => {
	const spec = artifactTypes.FeatureSpec.schema;
	assert.deepEqual(validate(spec, { goal: 'Offline mode', acceptanceCriteria: ['Persist locally'] }), []);
	assert.match(validate(spec, { acceptanceCriteria: ['x'] }).join(' '), /goal is required/);
	assert.match(validate(spec, { goal: 'g', acceptanceCriteria: [] }).join(' '), /at least 1/);
	assert.match(validate(spec, { goal: 7, acceptanceCriteria: ['x'] }).join(' '), /goal must be a string/);
	const review = artifactTypes.ReviewReport.schema;
	assert.match(validate(review, { verdict: 'maybe', reason: 'x' }).join(' '), /must be one of/);
	const report = artifactTypes.TestReport.schema;
	assert.match(validate(report, { passed: true, total: 1.5 }).join(' '), /total must be a integer/);
});

test('checkArtifact passes freeform text and validates JSON payloads, including fenced JSON', () => {
	assert.equal(checkArtifact('Text', 'anything at all').valid, true);
	const good = checkArtifact('ChangeSet', JSON.stringify({ baseRevision: 'abc', files: ['a.swift'], summary: 'add' }));
	assert.equal(good.valid, true);
	assert.deepEqual(good.value.files, ['a.swift']);
	assert.equal(checkArtifact('ChangeSet', 'not json').valid, false);
	assert.match(checkArtifact('ChangeSet', '{"files":[]}').errors.join(' '), /baseRevision is required/);
	const fenced = checkArtifact('TestReport', '```json\n{"passed":true,"total":3}\n```');
	assert.equal(fenced.valid, true);
});

test('contractInstruction only describes typed artifacts', () => {
	assert.equal(contractInstruction('Text'), undefined);
	assert.match(contractInstruction('FeatureSpec'), /validates against this schema[\s\S]*acceptanceCriteria/);
});
