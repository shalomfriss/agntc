const assert = require('node:assert/strict');
const http = require('node:http');
const vscode = require('vscode');
const { resolveModel } = require('../out-test/providers.js');

exports.run = async () => {
	const extension = vscode.extensions.getExtension('agentic-workbench.agentic-workbench');
	assert.ok(extension, 'Extension installed in development host');
	await extension.activate();
	const registered = await vscode.commands.getCommands();
	for (const contribution of extension.packageJSON.contributes.commands) {
		assert.ok(registered.includes(contribution.command), contribution.command);
	}

	const workspace = vscode.workspace.workspaceFolders[0].uri;
	const calls = [];
	const server = http.createServer(async (req, res) => {
		let body = '';
		for await (const chunk of req) {
			body += chunk;
		}
		try {
			assert.equal(req.url, '/v1/chat/completions');
			const { model, messages } = JSON.parse(body);
			const system = messages[0].content;
			const last = messages.at(-1).content;
			calls.push(model);
			let out;
			if (last === 'Connection check.') {
				out = 'OK';
			} else if (system.includes('Return an implementation plan')) {
				out = JSON.stringify({ output: 'Create message.txt with Hello there.' });
			} else if (system.includes('Apply the plan to the workspace')) {
				assert.match(messages[1].content, /Create message.txt with Hello there/);
				out = last.includes('created') ? JSON.stringify({ output: 'Implemented greeting.' })
					: JSON.stringify({ tool: 'create_file', args: { path: 'message.txt', content: 'Hello there.\n' } });
			} else if (system.includes('Review the actual change evidence')) {
				out = last.includes('returned')
					? JSON.stringify({ output: JSON.stringify({ verdict: 'approve', reason: 'Greeting is present.' }) })
					: JSON.stringify({ tool: 'diff', args: { path: 'message.txt' } });
			} else if (system.includes('Write a standalone human testing guide')) {
				assert.match(last, /Greeting is present/);
				out = JSON.stringify({ output: 'Open message.txt. Verify it contains Hello there.' });
			} else if (last.includes('Input from Upstream')) {
				assert.match(last, /Payload from the upstream step/);
				out = JSON.stringify({ output: 'Downstream received the payload.' });
			} else if (last.includes('workflow smoke request')) {
				out = JSON.stringify({ output: 'Payload from the upstream step' });
			} else {
				throw new Error('Unexpected model request');
			}
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ choices: [{ message: { content: out }, finish_reason: 'stop' }] }));
		} catch (error) {
			res.writeHead(500).end(String(error));
		}
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${server.address().port}/v1`;

	const answers = [];
	const errors = [];
	const previous = new Map();
	const fake = (name, callback) => {
		previous.set(name, vscode.window[name]);
		vscode.window[name] = callback;
	};
	fake('showQuickPick', async (items, options) => {
		const answer = answers.shift();
		const select = label => {
			const match = items.find(item => item.label === label);
			assert.ok(match, `Expected "${label}" from ${options?.title}: ${items.map(item => item.label).join(', ')}`);
			return match;
		};
		return Array.isArray(answer) ? answer.map(select) : select(answer);
	});
	fake('showInputBox', async () => {
		assert.ok(answers.length, 'Unexpected prompt');
		return answers.shift();
	});
	fake('showErrorMessage', async message => { errors.push(message); });
	fake('showInformationMessage', async () => undefined);

	const run = async (name, ...values) => {
		answers.push(...values);
		await vscode.commands.executeCommand(`agentic.${name}`);
		assert.deepEqual(errors, [], `Errors for ${name}`);
		assert.deepEqual(answers, [], `Unused answers for ${name}`);
	};
	try {
		await verifyAdapters();
		await run('connectProvider', 'OpenAI-compatible', 'Mock API', base, 'main-model', '');
		await run('runCodeFactory', 'Unstructure', 'Create the greeting');

		let report = vscode.window.activeTextEditor.document.getText();
		assert.match(report, /Status\*\* Succeeded/);
		const greeting = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspace, 'message.txt'));
		assert.equal(Buffer.from(greeting).toString(), 'Hello there.\n');
		assert.match(report, /Human testing plan[\s\S]*Verify it contains Hello there/);
		assert.match(report, /LLM Judge/);

		await run('createWorkflow', 'Linked workflow', 'Add step', 'LLM Judge', 'Upstream');
		await run('editWorkflow', 'Linked workflow', 'Add step', 'Testing Agent', 'Downstream');
		await run('editWorkflow', 'Linked workflow', 'Edit step or link inputs', 'Downstream', 'Link upstream outputs', ['Upstream']);
		await run('runWorkflow', 'Linked workflow', 'workflow smoke request');
		report = vscode.window.activeTextEditor.document.getText();
		assert.match(report, /Downstream received the payload/);
		assert.match(report, /Status\*\* Succeeded/);
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(workspace, 'host-ok.txt'),
			Buffer.from('Agentic host smoke passed: connection, Code Factory, and linked workflow.'));
	} catch (error) {
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(workspace, 'host-error.txt'), Buffer.from(
			JSON.stringify({ error: String(error), calls, errors }, null, 2)));
		throw error;
	} finally {
		for (const [name, method] of previous) {
			vscode.window[name] = method;
		}
		await new Promise(resolve => server.close(resolve));
	}
};

async function verifyAdapters() {
	const fetch = globalThis.fetch;
	const selectChatModels = vscode.lm.selectChatModels;
	const history = [{ role: 'user', content: 'probe' }];
	const signal = new AbortController().signal;
	try {
		for (const [kind, url, response] of [
			['openai', 'https://api.openai.com/v1/responses', {
				status: 'completed', output: [{ content: [{ type: 'output_text', text: 'ok' }] }],
			}],
			['anthropic', 'https://api.anthropic.com/v1/messages', {
				content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
			}],
			['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
				choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
			}],
		]) {
			globalThis.fetch = async (target, request) => {
				assert.equal(target, url);
				assert.equal(request.headers['x-api-key'] ?? request.headers.Authorization?.replace(/^Bearer /, ''), 'fake-key');
				const body = JSON.parse(request.body);
				assert.equal(body.model, 'fake-model');
				assert.match(JSON.stringify(body), /system-probe/);
				assert.match(JSON.stringify(body), /"role":"user","content":"probe"/);
				return new Response(JSON.stringify(response));
			};
			const model = await resolveModel({ id: kind, kind, name: kind, model: 'fake-model' }, 'fake-key');
			assert.equal(await model.request('system-probe', history, signal), 'ok');
		}
		vscode.lm.selectChatModels = async selector => {
			assert.deepEqual(selector, { vendor: 'copilot' });
			return [{ id: 'fake-copilot', name: 'Mock Copilot', sendRequest: async messages => {
				assert.match(messages[0].content[0].value, /system-probe[\s\S]*probe/);
				return { text: ['ok'] };
			} }];
		};
		const model = await resolveModel({ id: 'copilot', kind: 'copilot', name: 'Copilot', model: 'fake-copilot' });
		assert.equal(await model.request('system-probe', history, signal), 'ok');
	} finally {
		globalThis.fetch = fetch;
		vscode.lm.selectChatModels = selectChatModels;
	}
}
