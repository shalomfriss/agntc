const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createPlanning } = require('../out-test/planning.js');
const { Workspace } = require('../out-test/workspace.js');

const signal = new AbortController().signal;
const useCli = process.env.AGENTIC_FRAMEWORK_TESTS === '1';

async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-framework-test-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return new Workspace(root);
}

test('OpenSpec creates and validates real change artifacts before returning apply instructions', { skip: !useCli }, async t => {
	const workspace = await fixture(t);
	const planning = await createPlanning('OpenSpec', workspace, 'smoke', signal);
	const filenames = [];
	const content = {
		proposal: ['proposal.md', '# Proposal\n\n## Why\nThe demo needs a greeting.\n\n## What Changes\n- Add a greeting.\n\n## Capabilities\n\n### New Capabilities\n- `greeting`: Greet the user.\n\n### Modified Capabilities\n\n## Impact\nAdds a greeting module.\n'],
		specs: ['specs/greeting/spec.md', '## ADDED Requirements\n\n### Requirement: Provide greeting\nThe system SHALL return a greeting.\n\n#### Scenario: Default greeting\n- **WHEN** a user requests a greeting\n- **THEN** the system returns Hello\n'],
		design: ['design.md', '# Design\n\nReturn a greeting from a new module.\n'],
		tasks: ['tasks.md', '## 1. Implementation\n\n- [ ] 1.1 Add the greeting module\n'],
	};
	const plan = await planning.plan(async (_, __, stage, tools) => {
		const phase = stage.split(' ').at(-1);
		assert.ok(content[phase], `Unexpected OpenSpec stage: ${stage}`);
		const [file, text] = content[phase];
		await tools.write_artifact.run({ path: file, content: text }, signal);
		filenames.push(file);
		return 'Wrote the artifact';
	}, 'Add a greeting');
	assert.deepEqual(filenames, ['proposal.md', 'specs/greeting/spec.md', 'design.md', 'tasks.md']);
	assert.match(plan, /The system SHALL return a greeting/);
	assert.match(await planning.implementation(), /Add the greeting module/);
});

test('Spec Kit runs official setup scripts and uses generated command templates', { skip: !useCli }, async t => {
	const workspace = await fixture(t);
	const planning = await createPlanning('SpecKit', workspace, 'smoke', signal);
	t.after(() => planning.dispose());
	const seen = [];
	const plan = await planning.plan(async (input, _, stage, tools) => {
		const phase = stage.split(' ').at(-1);
		const files = { constitution: 'constitution.md', specify: 'spec.md', plan: 'plan.md', tasks: 'tasks.md' };
		assert.ok(files[phase], `Unexpected Spec Kit stage: ${stage}`);
		assert.match(input, /greeting/i);
		await tools.write_artifact.run({
			path: files[phase], content: `# Greeting ${phase}\n\nBuild a greeting.`,
		}, signal);
		seen.push(phase);
		return 'Wrote the artifact';
	}, 'Add a greeting');
	assert.deepEqual(seen, ['constitution', 'specify', 'plan', 'tasks']);
	assert.match(plan, /Greeting tasks/);
	assert.match(await planning.implementation(), /speckit/);
	assert.match(await workspace.read('.specify/memory/constitution.md'), /Greeting constitution/);
});
