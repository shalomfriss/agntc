import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { checkCancelled, requiredString, Tool } from './runner';

const fileLimit = 2_000_000;
const outputLimit = 20_000;
const excluded = new Set(['.git', 'node_modules', '.venv']);
const sensitive = /^(?:\.env(?:$|\.(?!example$|sample$|template$))|\.npmrc$|id_(?:rsa|ed25519)$)|\.(?:pem|pfx|key)$/i;

function within(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
	const value = args[key] ?? fallback;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
		throw new Error(`"${key}" must be an integer from 1 to ${max}.`);
	}
	return value;
}

function page(text: string, start: number, count: number): object {
	const lines = text.split('\n');
	const content = lines.slice(start - 1, start - 1 + count).join('\n');
	if (content.length > outputLimit) {
		throw new Error('This range is too large. Request fewer lines or use the search tool.');
	}
	return { startLine: start, totalLines: lines.length, text: content };
}

export class Workspace {
	private readonly original = new Map<string, string | undefined>();
	private readonly current = new Map<string, string | undefined>();
	private root?: Promise<string>;

	constructor(
		readonly cwd: string,
		private readonly guardWrite: (relative: string) => void = () => {},
		private readonly trashFile?: (relative: string) => Promise<void>,
	) {}

	private async resolve(relative: string): Promise<{ target: string; key: string }> {
		const root = await (this.root ??= fs.realpath(this.cwd));
		if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\')) {
			throw new Error('Use a workspace-relative path with forward slashes.');
		}
		const target = path.resolve(root, relative);
		const key = path.relative(root, target).split(path.sep).join('/');
		if (!within(root, target) || relative.split('/').includes('..') ||
			key.split('/').some(part => excluded.has(part.toLowerCase()) || sensitive.test(part))) {
			throw new Error('This path is outside the editable workspace files.');
		}
		let cursor = root;
		for (const part of key.split('/').filter(Boolean)) {
			cursor = path.join(cursor, part);
			try {
				if ((await fs.lstat(cursor)).isSymbolicLink()) {
					throw new Error('Symbolic links cannot be accessed through workspace tools.');
				}
			} catch (error) {
				if (missing(error)) {
					break;
				}
				throw error;
			}
		}
		return { target, key };
	}

	async read(relative: string): Promise<string> {
		const { target } = await this.resolve(relative);
		const stat = await fs.stat(target);
		if (!stat.isFile() || stat.size > fileLimit) {
			throw new Error('Expected a text file of at most 2 MB.');
		}
		try {
			const bytes = await fs.readFile(target);
			if (bytes.includes(0)) {
				throw new Error('Binary file.');
			}
			return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			throw new Error('Could not read a UTF-8 text file.');
		}
	}

	async exists(relative: string): Promise<boolean> {
		const { target } = await this.resolve(relative);
		try {
			await fs.stat(target);
			return true;
		} catch (error) {
			if (missing(error)) {
				return false;
			}
			throw error;
		}
	}

	async files(relative: string): Promise<Array<{ name: string; directory: boolean }>> {
		const { target } = await this.resolve(relative);
		const entries = await fs.readdir(target, { withFileTypes: true });
		return entries
			.filter(entry => (entry.isDirectory() || entry.isFile()) &&
				!excluded.has(entry.name.toLowerCase()) && !sensitive.test(entry.name))
			.map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
			.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
	}

	async search(relative: string, query: string, signal: AbortSignal): Promise<object> {
		const matches: Array<{ path: string; line: number; text: string }> = [];
		const directories = [relative];
		let scanned = 0;
		while (directories.length) {
			const dir = directories.shift()!;
			for (const entry of await this.files(dir)) {
				checkCancelled(signal);
				const name = path.posix.join(dir, entry.name);
				if (entry.directory) {
					directories.push(name);
					continue;
				}
				if (scanned++ >= 1000 || matches.length >= 40) {
					return { matches, truncated: true };
				}
				let source: string;
				try {
					source = await this.read(name);
				} catch {
					continue;
				}
				const lines = source.split('\n');
				for (let index = 0; index < lines.length && matches.length < 40; index++) {
					const offset = lines[index].indexOf(query);
					if (offset >= 0) {
						matches.push({ path: name, line: index + 1, text: lines[index].slice(Math.max(0, offset - 100), offset + 200) });
					}
				}
			}
		}
		return { matches, truncated: matches.length === 40 };
	}

	private async write(relative: string, value: string, existing: string | undefined, signal: AbortSignal, track: boolean): Promise<void> {
		const { target, key } = await this.resolve(relative);
		if (!key || Buffer.byteLength(value) > fileLimit) {
			throw new Error('Provide a file path and at most 2 MB of UTF-8 text.');
		}
		this.guardWrite(key);
		checkCancelled(signal);
		await fs.mkdir(path.dirname(target), { recursive: true });
		const temp = await fs.mkdtemp(path.join(path.dirname(target), '.agentic-'));
		try {
			const draft = path.join(temp, 'new');
			await fs.writeFile(draft, value, 'utf8');
			if (existing !== undefined) {
				await fs.chmod(draft, (await fs.stat(target)).mode);
				if (await this.read(key) !== existing) {
					throw new Error('The file changed during the edit. Read it again and retry.');
				}
			}
			this.guardWrite(key);
			checkCancelled(signal);
			if (existing === undefined) {
				await fs.link(draft, target);
			} else {
				await fs.rename(draft, target);
			}
			if (track) {
				this.track(key, existing, value);
			}
		} finally {
			await fs.rm(temp, { recursive: true, force: true });
		}
	}

	private track(key: string, before: string | undefined, after: string | undefined): void {
		if (!this.original.has(key)) {
			this.original.set(key, before);
		}
		this.current.set(key, after);
	}

	async writeArtifact(relative: string, value: string, signal: AbortSignal): Promise<void> {
		const existing = await this.exists(relative) ? await this.read(relative) : undefined;
		await this.write(relative, value, existing, signal, false);
	}

	tools(allowWrite: boolean): Record<string, Tool> {
		const tools: Record<string, Tool> = {
			list_files: {
				description: 'List entries in a workspace directory. Arguments: path (default "."), page (1-based, default 1).',
				run: async args => {
					const entries = await this.files(typeof args.path === 'string' ? args.path : '.');
					const page = numberArg(args, 'page', 1, 10000);
					return { entries: entries.slice((page - 1) * 100, page * 100), total: entries.length };
				},
			},
			read_file: {
				description: 'Read lines of a UTF-8 workspace file. Arguments: path, startLine (1-based, default 1), lines (default 120).',
				run: async args => page(await this.read(requiredString(args, 'path')),
					numberArg(args, 'startLine', 1, fileLimit), numberArg(args, 'lines', 120, 500)),
			},
			search: {
				description: 'Find case-sensitive literal text across workspace files. Arguments: query, path (directory, default ".").',
				run: (args, signal) => this.search(typeof args.path === 'string' ? args.path : '.', requiredString(args, 'query'), signal),
			},
		};
		if (allowWrite) {
			tools.create_file = {
				description: 'Create a UTF-8 workspace file. Arguments: path and content (string). Fails if the file already exists.',
				run: async (args, signal) => {
					const name = requiredString(args, 'path');
					if (typeof args.content !== 'string') {
						throw new Error('"content" must be a string.');
					}
					await this.write(name, args.content, undefined, signal, true);
					return { created: name };
				},
			};
			tools.edit_file = {
				description: 'Replace a unique exact text segment in an existing UTF-8 file. Arguments: path, oldText, newText. Match surrounding context for uniqueness.',
				run: async (args, signal) => {
					const name = requiredString(args, 'path');
					const oldText = requiredString(args, 'oldText');
					const existing = await this.read(name);
					const index = existing.indexOf(oldText);
					if (index < 0 || existing.indexOf(oldText, index + 1) >= 0) {
						throw new Error('The old text must match exactly once. Include surrounding context.');
					}
					if (typeof args.newText !== 'string') {
						throw new Error('"newText" must be a string.');
					}
					await this.write(name, existing.slice(0, index) + args.newText + existing.slice(index + oldText.length), existing, signal, true);
					return { edited: name };
				},
			};
			if (this.trashFile) {
				const trashFile = this.trashFile;
				tools.remove_file = {
					description: 'Move one existing UTF-8 workspace file to the Trash. Arguments: path. Only remove files the task requires removing.',
					run: async (args, signal) => {
						const { key } = await this.resolve(requiredString(args, 'path'));
						const before = await this.read(key);
						this.guardWrite(key);
						checkCancelled(signal);
						await trashFile(key);
						this.track(key, before, undefined);
						return { removed: key };
					},
				};
			}
		}
		return tools;
	}

	editCount(artifactRoot?: string): number {
		const paths = this.editPaths();
		return artifactRoot ? paths.filter(file => !file.startsWith(`${artifactRoot}/`)).length : paths.length;
	}

	editPaths(): string[] {
		return [...this.current].filter(([file, result]) => this.original.get(file) !== result).map(([file]) => file);
	}

	async summary(): Promise<string> {
		const files = this.editPaths();
		if (!files.length) {
			return 'No workspace edits recorded.';
		}
		return files.map(file => `- ${this.original.get(file) === undefined ? 'Added'
			: this.current.get(file) === undefined ? 'Removed' : 'Edited'} ${file}`).join('\n');
	}

	async reviewSummary(): Promise<string> {
		const preview: string[] = [];
		let remaining = 16_000;
		for (const file of this.editPaths()) {
			const change = await this.diff(file);
			if (change.length <= remaining) {
				preview.push(change);
				remaining -= change.length;
			}
		}
		const summary = await this.summary();
		return [summary, ...preview].join('\n\n');
	}

	private async diff(key: string): Promise<string> {
		const before = this.original.get(key);
		const after = await this.exists(key) ? await this.read(key) : undefined;
		return createTwoFilesPatch(before === undefined ? '/dev/null' : key, after === undefined ? '/dev/null' : key,
			before ?? '', after ?? '', undefined, undefined, { timeout: 1000 }) ?? 'Diff exceeded the time limit. Inspect the live file.';
	}

	evidenceTools(): Record<string, Tool> {
		return {
			diff: {
				description: 'Read the unified diff against the version before the run. Arguments: path, startLine (1-based, default 1), lines (default 120).',
				run: async args => {
					const name = requiredString(args, 'path');
					const { key } = await this.resolve(name);
					if (!this.original.has(key)) {
						throw new Error('There are no run edits for this path.');
					}
					return page(await this.diff(key), numberArg(args, 'startLine', 1, fileLimit), numberArg(args, 'lines', 120, 500));
				},
			},
		};
	}
}
