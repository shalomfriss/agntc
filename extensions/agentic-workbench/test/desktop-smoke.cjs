const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

async function main() {
  const source = path.resolve(__dirname, '../../..');
  const bundle = process.argv[2] ?? path.join(source, 'release', `VSCode-darwin-${process.arch}`, 'Agentic Workbench.app');
  const executablePath = path.resolve(bundle, 'Contents', 'MacOS', 'Agentic Workbench');
  const { _electron } = require(path.join(source, 'node_modules', 'playwright'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-desktop-smoke-'));
  const workspace = path.join(root, 'project');
  const data = path.join(root, 'profile');
  const extensions = path.join(root, 'extensions');
  await fs.mkdir(workspace);
  await fs.mkdir(extensions);
  await fs.mkdir(path.join(data, 'User'), { recursive: true });
  await fs.writeFile(path.join(data, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'welcomePage', 'security.workspace.trust.enabled': false,
    'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
  }));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      if (req.url === '/v1/models') {
        assert.equal(req.method, 'GET');
        calls.push('catalog');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'fixture-review', display_name: 'Fixture Review' }] }));
        return;
      }
      assert.equal(req.url, '/v1/chat/completions');
      const { model, messages } = JSON.parse(raw);
      const system = messages[0].content;
      const last = messages.at(-1).content;
      let response;
      if (last === 'Connection check.') {
        calls.push('connect');
        response = 'OK';
      } else if (system.includes('Review the smoke fixture.')) {
        assert.equal(model, 'fixture-review');
        calls.push('reviewer');
        response = JSON.stringify({ output: 'Reviewer used its selected model.' });
      } else if (system.includes('Return an implementation plan')) {
        calls.push('plan');
        response = JSON.stringify({ output: 'Write hello.txt with Hello, native editor!' });
      } else if (system.includes('Apply the plan to the workspace')) {
        calls.push('code');
        response = last.includes('created') ? JSON.stringify({ output: 'Wrote hello.txt.' })
          : JSON.stringify({ tool: 'create_file', args: { path: 'hello.txt', content: 'Hello, native editor!\n' } });
      } else if (system.includes('Review the actual change evidence')) {
        calls.push('judge');
        assert.match(last, /Hello, native editor!/);
        response = JSON.stringify({ output: '{"verdict":"approve","reason":"The requested file exists with the expected content."}' });
      } else if (system.includes('Write a standalone human testing guide')) {
        calls.push('test');
        response = JSON.stringify({ output: 'Open hello.txt. Verify it contains Hello, native editor! This tests the desktop Code Factory handoff.' });
      } else {
        throw new Error('Unexpected provider request');
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: response }, finish_reason: 'stop' }] }));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let app;
  let window;
  let passed = false;
  try {
    app = await _electron.launch({
      executablePath,
      args: ['--use-mock-keychain', '--new-window', '--skip-release-notes', '--user-data-dir', data, '--extensions-dir', extensions, workspace],
      timeout: 45_000,
    });
    const appIdentity = await app.evaluate(({ app }) => ({ name: app.getName(), version: app.getVersion() }));
    assert.match(appIdentity.name, /Agentic Workbench/);
    window = await app.firstWindow();
    window.setDefaultTimeout(25_000);
    const welcome = window.getByText('Open Agentic Workbench', { exact: true });
    await welcome.click();
    await window.getByText('Code Factory', { exact: true }).waitFor();
    console.log('Welcome entry opened the built-in Code Factory view.');
    const quick = window.locator('.quick-input-widget:visible');
    const field = quick.locator('input').first();
    const command = async name => {
      await window.keyboard.press('Meta+Shift+p');
      await field.fill('>' + name);
      await quick.locator('.quick-input-list .monaco-list-row').filter({ hasText: name.split(': ').at(-1) }).first().waitFor();
      await window.keyboard.press('Enter');
    };
    const pick = async (title, label) => {
      await quick.getByText(title, { exact: true }).waitFor();
      await field.fill(label);
      await quick.locator('.quick-input-list .monaco-list-row').filter({ hasText: label }).first().waitFor();
      await window.keyboard.press('Enter');
    };
    const input = async (prompt, value) => {
      await quick.getByText(prompt, { exact: false }).first().waitFor();
      await field.fill(value);
      await window.keyboard.press('Enter');
    };
    await window.getByRole('treeitem', { name: /^Planning Agent/ }).first().click();
    // Clicking an agent opens Agent Details in the secondary (right) sidebar.
    await window.locator('.part.auxiliarybar').getByRole('tab', { name: 'Agent Details', selected: true }).waitFor();
    const details = window.locator('.part.auxiliarybar').frameLocator('iframe.webview').frameLocator('iframe#active-frame');
    const agentSelect = details.getByLabel('Agent', { exact: true });
    const name = details.getByLabel('Name', { exact: true });
    const instructions = details.getByLabel('Instructions', { exact: true });
    const subagents = details.getByLabel('Add a subagent', { exact: true });
    const provider = details.getByLabel('Provider', { exact: true });
    const model = details.getByLabel('Model', { exact: true });
    const access = details.getByLabel('Workspace access', { exact: true });
    await details.getByRole('heading', { name: 'Planning Agent', exact: true }).waitFor();
    assert.equal(await name.inputValue(), 'Planning Agent');
    assert.equal(await access.inputValue(), 'read');
    assert.equal(await quick.count(), 0);
    const originalInstructions = await instructions.inputValue();
    await details.getByRole('button', { name: 'New Agent', exact: true }).click();
    await details.getByRole('heading', { name: 'New agent', exact: true }).waitFor();
    await name.fill('Fixture Reviewer');
    await instructions.fill('Review the smoke fixture.\nSummarize the result.');
    await details.getByRole('button', { name: 'Connect a Provider', exact: true }).click();
    await pick('Connect AI provider', 'OpenAI-compatible');
    await input('Name for this connection', 'Desktop Smoke API');
    await input('OpenAI-compatible base URL', `http://127.0.0.1:${server.address().port}/v1`);
    await input('Model ID from your provider', 'fixture');
    await input('Enter an API key if your endpoint requires one.', '');
    await window.getByText('Connected Desktop Smoke API.', { exact: true }).waitFor();
    assert.equal(await name.inputValue(), 'Fixture Reviewer');
    await provider.selectOption({ label: 'Desktop Smoke API' });
    await details.getByRole('button', { name: 'Load Models', exact: true }).click();
    await model.selectOption({ label: 'Fixture Review' });
    await access.selectOption({ label: 'Read and Edit Files' });
    await details.getByRole('button', { name: 'Save Agent', exact: true }).click();
    await details.getByRole('heading', { name: 'Fixture Reviewer', exact: true }).waitFor();
    await details.getByText('Agent saved.', { exact: true }).waitFor();
    await window.getByRole('treeitem', { name: /^Fixture Reviewer/ }).waitFor();

    await agentSelect.selectOption({ label: 'Planning Agent' });
    await details.getByRole('heading', { name: 'Planning Agent', exact: true }).waitFor();
    await subagents.selectOption({ label: 'Fixture Reviewer' });
    await details.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await details.getByText('Agent saved.', { exact: true }).waitFor();
    assert.equal(await details.getByRole('heading', { name: 'Used by', exact: true }).count(), 1);
    assert.equal(await details.getByText('Code Factory', { exact: true }).count(), 1);

    await instructions.fill(originalInstructions + '\nTemporary edit.');
    await details.getByRole('button', { name: 'Fixture Reviewer', exact: true }).click();
    await details.getByRole('heading', { name: 'Fixture Reviewer', exact: true }).waitFor();
    assert.equal(await model.inputValue(), 'model:fixture-review');
    assert.equal(await access.inputValue(), 'write');
    assert.equal(await instructions.inputValue(), 'Review the smoke fixture.\nSummarize the result.');
    assert.equal(await subagents.locator('option', { hasText: 'Planning Agent (circular link)' }).isDisabled(), true);
    assert.equal(await details.getByRole('button', { name: 'Delete', exact: true }).isDisabled(), true);
    assert.equal(await details.getByRole('button', { name: 'Planning Agent', exact: true }).count(), 1);
    await model.selectOption('custom');
    await details.getByLabel('Model ID', { exact: true }).fill('model-entered-by-id');
    assert.equal(await details.getByRole('button', { name: 'Run Agent', exact: true }).isDisabled(), true);
    await details.getByRole('button', { name: 'Discard', exact: true }).click();
    assert.equal(await model.inputValue(), 'model:fixture-review');

    await agentSelect.selectOption({ label: 'Planning Agent' });
    await details.getByRole('heading', { name: 'Planning Agent', exact: true }).waitFor();
    assert.equal(await instructions.inputValue(), originalInstructions + '\nTemporary edit.');
    await details.getByRole('button', { name: 'Discard', exact: true }).click();
    assert.equal(await instructions.inputValue(), originalInstructions);
    const screenshot = process.env.AGENTIC_DETAILS_SCREENSHOT;
    if (screenshot) {
      await window.screenshot({ path: screenshot });
    }
    await details.getByRole('button', { name: 'Fixture Reviewer', exact: true }).click();
    await details.getByRole('heading', { name: 'Fixture Reviewer', exact: true }).waitFor();
    await details.getByRole('button', { name: 'Run Agent', exact: true }).click();
    await input('Describe the task to run', 'Review the sample.');
    await window.getByText('Reviewer used its selected model.', { exact: false }).first().waitFor();
    console.log('Agent Details created and saved an agent, loaded models, linked a subagent and preserved a draft.');
    await command('Agentic: Run Code Factory');
    await pick('Code Factory planning mode', 'Unstructure');
    await input('Describe the task to run', 'Create a text file with a greeting for the desktop smoke test.');
    await window.getByText('Human testing plan', { exact: false }).first().waitFor({ timeout: 30_000 });
    assert.equal(await fs.readFile(path.join(workspace, 'hello.txt'), 'utf8'), 'Hello, native editor!\n');
    assert.deepEqual(calls, ['connect', 'catalog', 'reviewer', 'plan', 'code', 'code', 'judge', 'test']);
    assert.equal((await fs.readdir(extensions)).filter(name => !name.endsWith('.json')).length, 0);
    console.log(`${appIdentity.name} ${appIdentity.version} ran Code Factory in a clean profile with no user extensions.`);
    passed = true;
  } catch (error) {
    if (window) {
      const screen = path.join(root, 'diagnostic.png');
      await window.screenshot({ path: screen, timeout: 3000 }).catch(() => {});
      console.error('Smoke diagnostic', screen);
    }
    throw error;
  } finally {
    if (app) {
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          app.process().kill('SIGKILL');
          resolve();
        }, 5000);
        void app.close().catch(() => {}).finally(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (passed) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
