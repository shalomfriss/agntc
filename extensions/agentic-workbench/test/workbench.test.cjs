const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { defaultWorkbench, orderedSteps, validateSubagents } = require('../out-test/model.js');
const { createPlanning } = require('../out-test/planning.js');
const { AgentRunner, runCodeFactory, runWorkflow } = require('../out-test/runner.js');
const { Workspace } = require('../out-test/workspace.js');

const signal = new AbortController().signal;
const tool = (name, args) => JSON.stringify({ tool: name, args });
const output = content => JSON.stringify({ output: content });

function agent(id, subagents = [], access = 'read') {
	return { id, name: id, subagents, access, instructions: id, providerId: `provider-${id}` };
}

function mocks(agents, workspace, requests) {
	const stages = [];
	const runner = new AgentRunner(agents, async agent => ({
		id: agent.providerId ?? agent.id, label: agent.providerId ?? agent.name,
		request: async (system, history) => {
			assert.ok(requests[agent.id]?.length, `Unexpected request to ${agent.id}: ${history.at(-1).content}`);
			return requests[agent.id].shift()(system, history);
		},
	}), access => workspace?.tools(access) ?? {}, stage => stages.push({ ...stage }), signal);
	return { runner, stages };
}

async function folder(t) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-test-'));
	t.after(() => fs.rm(cwd, { recursive: true, force: true }));
	return cwd;
}

test('a workflow routes multiple upstream outputs by step ID and rejects cycles', async () => {
	const workflow = {
		id: 'pipeline', name: 'Pipeline',
		steps: [
			{ id: 'combined', name: 'Combine', agentId: 'joiner', inputs: ['first', 'second'] },
			{ id: 'second', name: 'Second', agentId: 'writer', inputs: [] },
			{ id: 'first', name: 'First', agentId: 'researcher', inputs: [] },
		],
	};
	const { runner } = mocks(['researcher', 'writer', 'joiner'].map(id => agent(id)), undefined, {
		researcher: [() => output('facts')],
		writer: [() => output('prose')],
		joiner: [(_, history) => {
			assert.match(history[0].content, /Input from First\n\nfacts[\s\S]*Input from Second\n\nprose/);
			return output('combined result');
		}],
	});
	assert.equal(await runWorkflow(workflow, 'Build an answer', runner), '## Combine\n\ncombined result');
	workflow.steps[1].inputs = ['combined'];
	assert.throws(() => orderedSteps(workflow), /cycle/);
});

test('nested subagents use independently selected providers and inherit the parent write limit', async () => {
	const agents = [agent('parent', ['child']), agent('child', ['grandchild'], 'write'), agent('grandchild', [], 'write')];
	const { runner, stages } = mocks(agents, { tools: access => access ? { create_file: {} } : {} }, {
		parent: [
			() => tool('delegate', { agent: 'child', task: 'Delegate this analysis' }),
			(_, history) => {
				assert.match(history.at(-1).content, /child result/);
				return output('parent result');
			},
		],
		child: [
			(system, history) => {
				assert.match(history[0].content, /Delegate this analysis/);
				assert.doesNotMatch(system, /create_file/);
				return tool('delegate', { agent: 'grandchild', task: 'Inspect this fact' });
			},
			(_, history) => {
				assert.match(history.at(-1).content, /fact checked/);
				return output('child result');
			},
		],
		grandchild: [(system, history) => {
			assert.match(history[0].content, /Inspect this fact/);
			assert.doesNotMatch(system, /create_file/);
			return output('fact checked');
		}],
	});
	assert.equal(await runner.run({ name: 'Main', agentId: 'parent', input: 'Task', allowWrite: true }), 'parent result');
	assert.deepEqual(stages.map(stage => stage.model), ['provider-grandchild', 'provider-child', 'provider-parent']);
	agents[2].subagents.push('parent');
	assert.throws(() => validateSubagents(agents), /cycle/);
});

test('an input node feeds connected agents while downstream agents keep the original request', async () => {
	const workflow = {
		id: 'wf', name: 'WF',
		steps: [
			{ id: 'ask', name: 'Ask', kind: 'input', inputs: [] },
			{ id: 'first', name: 'First', agentId: 'alpha', inputs: ['ask'] },
			{ id: 'second', name: 'Second', agentId: 'beta', inputs: ['first'] },
		],
	};
	const { runner } = mocks([agent('alpha'), agent('beta')], undefined, {
		alpha: [(_, history) => {
			assert.match(history[0].content, /Input from Ask\n\nmy task/);
			assert.doesNotMatch(history[0].content, /Original request/);
			return output('alpha out');
		}],
		beta: [(_, history) => {
			assert.match(history[0].content, /Original request\n\nmy task/);
			assert.match(history[0].content, /Input from First\n\nalpha out/);
			return output('beta out');
		}],
	});
	assert.equal(await runWorkflow(workflow, 'my task', runner), '## Second\n\nbeta out');
});

test('input node values can be supplied per node and override the launch task', async () => {
	const workflow = {
		id: 'wf2', name: 'WF2',
		steps: [
			{ id: 'ask', name: 'Ask', kind: 'input', inputs: [] },
			{ id: 'only', name: 'Only', agentId: 'alpha', inputs: ['ask'] },
		],
	};
	const { runner } = mocks([agent('alpha')], undefined, {
		alpha: [(_, history) => {
			assert.match(history[0].content, /Input from Ask\n\noverride text/);
			return output('ok');
		}],
	});
	assert.equal(await runWorkflow(workflow, 'launch', runner, { ask: 'override text' }), '## Only\n\nok');
});

test('an agent dynamically spawns ad-hoc worker subagents up to its max', async () => {
	const lead = { id: 'lead', name: 'lead', subagents: [], access: 'read', instructions: 'lead', providerId: 'provider-lead', maxSubagents: 2 };
	const { runner, stages } = mocks([lead], undefined, {
		lead: [
			system => {
				assert.match(system, /spawn_subagent/);
				return tool('spawn_subagent', { name: 'Worker A', instructions: 'analyze', task: 'piece 1' });
			},
			(system, history) => {
				assert.match(history[0].content, /piece 1/);
				assert.doesNotMatch(system, /spawn_subagent/);
				return output('done 1');
			},
			(_, history) => {
				assert.match(history.at(-1).content, /done 1/);
				return tool('spawn_subagent', { name: 'Worker B', instructions: 'analyze', task: 'piece 2' });
			},
			(_, history) => {
				assert.match(history[0].content, /piece 2/);
				return output('done 2');
			},
			(_, history) => {
				assert.match(history.at(-1).content, /done 2/);
				return tool('spawn_subagent', { name: 'Worker C', instructions: 'analyze', task: 'piece 3' });
			},
			(_, history) => {
				assert.match(history.at(-1).content, /limit of 2 is reached/);
				return output('final result');
			},
		],
	});
	assert.equal(await runner.run({ name: 'Main', agentId: 'lead', input: 'coordinate', allowWrite: false }), 'final result');
	assert.deepEqual(stages.map(stage => stage.name), ['Main → Worker A', 'Main → Worker B', 'Main']);
	assert.deepEqual(stages.map(stage => stage.model), ['provider-lead', 'provider-lead', 'provider-lead']);
});

test('Code Factory revises the plan with judge feedback, edits files, and creates a human plan after approval', async t => {
	const cwd = await folder(t);
	const workspace = new Workspace(cwd);
	const { agents, factory } = defaultWorkbench();
	const { runner, stages } = mocks(agents, workspace, {
		planner: [
			() => output('Add greet.js, returning a greeting.'),
			(_, history) => {
				assert.match(history[0].content, /Judge feedback to resolve[\s\S]*missing parameter/);
				assert.match(history[0].content, /Previous plan[\s\S]*Add greet.js/);
				return output('Accept a name and include it in the greeting.');
			},
		],
		coder: [
			() => output('I would add greet.js.'),
			(_, history) => {
				assert.match(history.at(-1).content, /There are no workspace edits/);
				return tool('create_file', { path: 'greet.js', content: "exports.greet = () => 'Hello';\n" });
			},
			(_, history) => {
				assert.match(history.at(-1).content, /created/);
				return output('Added greet.js');
			},
			(_, history) => {
				assert.match(history[0].content, /Accept a name/);
				return tool('edit_file', { path: 'greet.js', oldText: "() => 'Hello'", newText: "(name) => 'Hello, ' + name" });
			},
			() => output('Updated greet.js to accept a name'),
		],
		judge: [
			(system, history) => {
				assert.doesNotMatch(system, /Tool edit_file/);
				assert.match(history[0].content, /Add greet.js[\s\S]*Added greet.js/);
				return tool('diff', { path: 'greet.js' });
			},
			(_, history) => {
				assert.match(history.at(-1).content, /exports.greet/);
				return output('{"verdict":"revise","reason":"missing parameter"}');
			},
			() => tool('diff', { path: 'greet.js' }),
			(_, history) => {
				assert.match(history.at(-1).content, /Hello, ' \+ name/);
				return output('{"verdict":"approve","reason":"matches revised plan"}');
			},
		],
		tester: [
			(system, history) => {
				assert.match(system, /pass\/fail criteria/);
				assert.match(history[0].content, /matches revised plan/);
				return output('### Human checks\nRun greet("Sam"). Expect Hello, Sam.');
			},
		],
	});
	const plan = await runCodeFactory(factory, 'Create a personalized greeting', runner,
		() => createPlanning('Unstructure', workspace, 'sample', signal), {
			summary: () => workspace.summary(), tools: () => workspace.evidenceTools(), editCount: () => workspace.editCount(),
		});
	assert.match(plan, /Hello, Sam/);
	assert.equal(require(path.join(cwd, 'greet.js')).greet('Sam'), 'Hello, Sam');
	assert.deepEqual(stages.map(stage => [stage.name, stage.attempt]), [
		['Planning Agent', 1], ['Coding Agent', 1], ['LLM Judge', 1],
		['Planning Agent', 2], ['Coding Agent', 2], ['LLM Judge', 2], ['Testing Agent', 2],
	]);
});

test('Code Factory reports exhausted revisions without asking the testing agent', async t => {
	const workspace = new Workspace(await folder(t));
	const { agents, factory } = defaultWorkbench();
	factory.maxRevisions = 0;
	const { runner, stages } = mocks(agents, workspace, {
		planner: [() => output('write a file')],
		coder: [() => tool('create_file', { path: 'example', content: 'file' }), () => output('created example')],
		judge: [() => output('{"verdict":"revise","reason":"file is incomplete"}')],
	});
	await assert.rejects(runCodeFactory(factory, 'write content', runner,
		() => createPlanning('Unstructure', workspace, 'sample', signal), {
			summary: () => workspace.summary(), tools: () => workspace.evidenceTools(), editCount: () => workspace.editCount(),
		}), /file is incomplete/);
	assert.ok(!stages.some(stage => stage.name === 'Testing Agent'));
});

test('workspace file tools constrain paths, preserve existing files, and report net changes', async t => {
	const cwd = await folder(t);
	const workspace = new Workspace(cwd);
	const { create_file, edit_file, read_file } = workspace.tools(true);
	await fs.symlink(os.tmpdir(), path.join(cwd, 'link'), 'dir');
	await assert.rejects(read_file.run({ path: '../outside' }, signal), /outside/);
	await assert.rejects(create_file.run({ path: 'link/file', content: 'file' }, signal), /Symbolic links/);
	await fs.writeFile(path.join(cwd, 'current.txt'), 'original\n');
	await assert.rejects(create_file.run({ path: 'current.txt', content: 'reset' }, signal), /EEXIST/);
	await edit_file.run({ path: 'current.txt', oldText: 'original', newText: 'changed' }, signal);
	assert.equal(workspace.editCount(), 1);
	await edit_file.run({ path: 'current.txt', oldText: 'changed', newText: 'original' }, signal);
	assert.equal(workspace.editCount(), 0);
});
