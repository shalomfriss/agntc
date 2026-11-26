import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface Skill {
	id: string;
	name: string;
	description: string;
	source: string;
}

const skillContentLimit = 12_000;

function skillRoots(): Array<{ root: string; source: string }> {
	const home = os.homedir();
	const roots = [
		{ root: path.join(home, '.claude', 'skills'), source: 'Claude Code' },
		{ root: path.join(home, '.codex', 'skills'), source: 'Codex' },
	];
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (folder.uri.scheme === 'file') {
			roots.push({ root: path.join(folder.uri.fsPath, '.claude', 'skills'), source: 'Workspace' });
		}
	}
	return roots;
}

function frontmatter(text: string): { name?: string; description?: string } {
	const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
	const result: { name?: string; description?: string } = {};
	if (match) {
		for (const line of match[1].split('\n')) {
			const field = line.match(/^(name|description)\s*:\s*(.+?)\s*$/);
			if (field) {
				result[field[1] as 'name' | 'description'] = field[2].replace(/^["']|["']$/g, '');
			}
		}
	}
	return result;
}

async function scan(root: string, source: string): Promise<Map<string, { skill: Skill; file: string }>> {
	const found = new Map<string, { skill: Skill; file: string }>();
	let entries;
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const file = path.join(root, entry.name, 'SKILL.md');
		try {
			const text = await fs.readFile(file, 'utf8');
			const meta = frontmatter(text);
			found.set(entry.name, {
				file,
				skill: { id: entry.name, name: meta.name || entry.name, description: meta.description || '', source },
			});
		} catch {
			// Skip directories without a readable SKILL.md.
		}
	}
	return found;
}

async function collect(): Promise<Map<string, { skill: Skill; file: string }>> {
	const all = new Map<string, { skill: Skill; file: string }>();
	for (const { root, source } of skillRoots()) {
		for (const [id, value] of await scan(root, source)) {
			if (!all.has(id)) {
				all.set(id, value);
			}
		}
	}
	return all;
}

export async function discoverSkills(): Promise<Skill[]> {
	return [...(await collect()).values()].map(value => value.skill)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSkillContents(ids: string[]): Promise<string[]> {
	if (!ids.length) {
		return [];
	}
	const catalog = await collect();
	const contents: string[] = [];
	for (const id of ids) {
		const entry = catalog.get(id);
		if (!entry) {
			continue;
		}
		try {
			const text = await fs.readFile(entry.file, 'utf8');
			const trimmed = text.length > skillContentLimit ? `${text.slice(0, skillContentLimit)}\n…(truncated)` : text;
			contents.push(`### Skill: ${entry.skill.name}\n\n${trimmed}`);
		} catch {
			// Skip skills that can no longer be read.
		}
	}
	return contents;
}
