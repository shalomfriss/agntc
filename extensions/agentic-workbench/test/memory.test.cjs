const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadProjectMemory } = require('../out-test/memory.js');

async function folder(t) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-memory-'));
	t.after(() => fs.rm(cwd, { recursive: true, force: true }));
	return cwd;
}

test('project memory is read from a known location and absent when there is none', async t => {
	const cwd = await folder(t);
	assert.equal(await loadProjectMemory(cwd), undefined);
	await fs.mkdir(path.join(cwd, '.agentic'));
	await fs.writeFile(path.join(cwd, '.agentic', 'memory.md'), '# Conventions\n\nUse the Repository pattern.\n');
	assert.match(await loadProjectMemory(cwd), /Repository pattern/);
});

test('project memory falls back to AGENTS.md and truncates very large files', async t => {
	const cwd = await folder(t);
	await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'root guidance');
	assert.equal(await loadProjectMemory(cwd), 'root guidance');
	await fs.mkdir(path.join(cwd, '.agentic'));
	await fs.writeFile(path.join(cwd, '.agentic', 'memory.md'), 'x'.repeat(20_000));
	assert.match(await loadProjectMemory(cwd), /…\(truncated\)$/);
});
