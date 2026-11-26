import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Scoped project memory: architecture decisions, conventions, and verified facts kept
// alongside the code. When present, it is injected into every agent's instructions for a run.

const memoryFiles = ['.agentic/memory.md', '.agentic/MEMORY.md', 'AGENTS.md'];
const memoryLimit = 12_000;

export async function loadProjectMemory(cwd: string): Promise<string | undefined> {
	for (const relative of memoryFiles) {
		try {
			const text = await fs.readFile(path.join(cwd, ...relative.split('/')), 'utf8');
			if (text.trim()) {
				return text.length > memoryLimit ? `${text.slice(0, memoryLimit)}\n…(truncated)` : text;
			}
		} catch {
			// Try the next candidate location.
		}
	}
	return undefined;
}
