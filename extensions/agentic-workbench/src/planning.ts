import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PlanningMode } from './model';
import { ProcessError, runProcess } from './process';
import { checkCancelled, PlanningContext, requiredString, Tool } from './runner';
import { Workspace } from './workspace';

interface PlanRun {
	(input: string, instructions: string, name?: string, tools?: Record<string, Tool>): Promise<string>;
}

const specCommands = '.agentic-spec-kit';

function artifactTools(
	workspace: Workspace, base: string, allowed: (name: string) => boolean, written: Set<string>,
): Record<string, Tool> {
	return {
		write_artifact: {
			description: `Write a planning artifact in ${base}. Arguments: path relative to that folder and content (UTF-8 string).`,
			run: async (args, signal) => {
				const name = requiredString(args, 'path');
				if (!allowed(name)) {
					throw new Error('That artifact path is unavailable in this planning stage.');
				}
				const target = `${base}/${name}`;
				await workspace.writeArtifact(target, requiredString(args, 'content'), signal);
				written.add(name);
				return { written: target };
			},
		},
	};
}

function cliFailure(error: unknown): never {
	if (error instanceof ProcessError) {
		throw new Error(`${error.message}\n${error.output.trim().slice(0, 4000)}`);
	}
	throw error;
}

async function openSpec(
	workspace: Workspace, id: string, signal: AbortSignal,
): Promise<PlanningContext> {
	const root = await fs.realpath(workspace.cwd);
	const change = `agentic-${id}`;
	const base = `openspec/changes/${change}`;
	const invoke = async (args: string[]) =>
		(await runProcess('openspec', args, signal, {
			cwd: root, env: { ...process.env, OPENSPEC_TELEMETRY: '0', NO_COLOR: '1' },
		})).stdout;
	try {
		if (!await workspace.exists('openspec')) {
			await invoke(['init', '--tools', 'none']);
		}
		if (await workspace.exists('openspec/config.yaml') &&
			/^\s*store\s*:/m.test(await workspace.read('openspec/config.yaml'))) {
			throw new Error('OpenSpec is configured for an external store. Select the store as the run folder or use another planning mode.');
		}
		await workspace.exists('openspec/changes');
		const context = JSON.parse(await invoke(['context', '--json'])) as { root?: { path: string } };
		if (context.root?.path !== root) {
			throw new Error('OpenSpec resolved a different project root. Select that workspace folder and retry.');
		}
		await invoke(['new', 'change', change, '--schema', 'spec-driven']);
	} catch (error) {
		cliFailure(error);
	}
	const artifacts = [
		{ name: 'proposal', output: 'proposal.md' }, { name: 'specs', output: 'specs/<capability>/spec.md' },
		{ name: 'design', output: 'design.md' }, { name: 'tasks', output: 'tasks.md' },
	];
	const specPath = /^specs\/(?:[a-z0-9][a-z0-9-]*\/)+spec\.md$/;
	const canWrite = (artifact: typeof artifacts[number], name: string) =>
		artifact.name === 'specs' ? specPath.test(name)
			: name === artifact.output || (artifact.name === 'proposal' && name === '.openspec.yaml');
	const listArtifacts = async () => {
		const status = JSON.parse(await invoke(['status', '--change', change, '--json'])) as {
			artifactPaths: Record<string, { existingOutputPaths: string[] }>;
		};
		return Object.values(status.artifactPaths).flatMap(artifact => artifact.existingOutputPaths)
			.map(file => path.relative(root, file).split(path.sep).join('/'))
			.filter(file => file.startsWith(`${base}/`));
	};
	return {
		artifactRoot: base,
		plan: async (run, input) => {
			try {
				for (const artifact of artifacts) {
					const instructions = JSON.parse(await invoke(['instructions', artifact.name, '--change', change, '--json'])) as { skipped?: boolean };
					if (instructions.skipped) {
						continue;
					}
					const written = new Set<string>();
					await run(`${input}\n\n## OpenSpec instructions\n\n${JSON.stringify(instructions)}`, [
						`Create or revise ${artifact.output} using write_artifact. Follow the OpenSpec template and read prior artifacts in ${base} as needed.`,
						'For a change with no spec-level behavior change, you may write .openspec.yaml containing skip_specs: true during the proposal stage.',
						'Use read_file and list_files to inspect any local specs the instructions reference.',
					].join(' '), `Planning Agent · OpenSpec ${artifact.name}`,
					artifactTools(workspace, base, name => canWrite(artifact, name), written));
					if (![...written].some(name => name !== '.openspec.yaml')) {
						throw new Error(`The Planning Agent did not write the OpenSpec ${artifact.name} artifact.`);
					}
				}
				for (let correction = 0; ; correction++) {
					try {
						await invoke(['validate', change, '--type', 'change', '--strict', '--no-interactive']);
						break;
					} catch (error) {
						if (!(error instanceof ProcessError) || correction >= 2) {
							throw error;
						}
						await run(`${input}\n\n## OpenSpec validation findings\n\n${error.output.slice(0, 10_000)}`,
							`Read and repair the artifacts under ${base} using write_artifact. Address the CLI findings.`,
							'Planning Agent · Repair OpenSpec artifacts',
							artifactTools(workspace, base, name => artifacts.some(artifact => canWrite(artifact, name)), new Set()));
					}
				}
				const files = await listArtifacts();
				return [`# OpenSpec change ${change}`, ...(await Promise.all(files.map(async file =>
					`## ${file}\n\n${await workspace.read(file)}`)))].join('\n\n');
			} catch (error) {
				cliFailure(error);
			}
		},
		implementation: async () => {
			try {
				return `## OpenSpec apply instructions\n\n${await invoke(['instructions', 'apply', '--change', change, '--json'])}`;
			} catch (error) {
				cliFailure(error);
			}
		},
	};
}

async function specKit(
	workspace: Workspace, id: string, signal: AbortSignal,
): Promise<PlanningContext> {
	const root = await fs.realpath(workspace.cwd);
	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-speckit-'));
	const dispose = () => fs.rm(scratch, { recursive: true, force: true });
	try {
		await runProcess('specify', [
			'init', '--here', '--integration', 'generic', `--integration-options=--commands-dir ${specCommands}`,
			'--script', 'py', '--non-interactive', '--ignore-agent-tools',
		], signal, { cwd: scratch });
		if (!await workspace.exists('.specify')) {
			if (await workspace.exists(specCommands)) {
				throw new Error(`Resolve the existing ${specCommands} directory before initializing Spec Kit.`);
			}
			for (const directory of ['.specify', specCommands]) {
				checkCancelled(signal);
				await fs.cp(path.join(scratch, directory), path.join(root, directory), { recursive: true, errorOnExist: true, force: false });
			}
		}
		await workspace.exists('specs');
		const env: NodeJS.ProcessEnv = {
			...process.env, SPECIFY_INIT_DIR: root, SPECIFY_FEATURE_DIRECTORY: undefined, SPECIFY_FEATURE: undefined,
			PYTHONDONTWRITEBYTECODE: '1',
		};
		const invoke = async (script: string, args: string[] = []) =>
			JSON.parse((await runProcess(process.platform === 'win32' ? 'python' : 'python3', [
				path.join(scratch, '.specify', 'scripts', 'python', `${script}.py`), '--json', ...args,
			], signal, { cwd: root, env })).stdout);
		const state = await invoke('create_new_feature', ['--short-name', `agentic-${id}`, 'Code Factory change']) as { SPEC_FILE: string };
		const featureDir = path.dirname(state.SPEC_FILE);
		const base = path.relative(root, featureDir).split(path.sep).join('/');
		if (!/^specs\/[a-zA-Z0-9-]+$/.test(base)) {
			throw new Error('Spec Kit returned an unexpected feature directory.');
		}
		env.SPECIFY_FEATURE_DIRECTORY = featureDir;
		const command = (name: string) => fs.readFile(path.join(scratch, specCommands, `speckit.${name}.md`), 'utf8');
		const draft = async (
			run: PlanRun, input: string, name: string, file: string, template: string,
			allowed: (target: string) => boolean = target => target === file,
		) => {
			const written = new Set<string>();
			const artifacts = `\n\n## Spec Kit feature folder\n\n${base}`;
			await run(`${input}${artifacts}\n\n## Spec Kit command\n\n${await command(name)}\n\n## Template\n\n${template}`, [
				`Follow the Spec Kit instructions and write ${file} with write_artifact. The host has already set up the feature directory and resolved the template.`,
				'Read the project constitution, existing feature documents and source as needed. Write supplemental design artifacts when the plan calls for them.',
				'Use workspace tools to inspect and write files.',
			].join(' '), `Planning Agent · Spec Kit ${name}`, artifactTools(workspace, base, allowed, written));
			if (!written.has(file)) {
				throw new Error(`The Planning Agent did not write ${base}/${file}.`);
			}
			return written;
		};
		const constitution = '.specify/memory/constitution.md';
		const template = async (file: string) => {
			if (await workspace.exists(`.specify/templates/overrides/${file}-template.md`)) {
				return workspace.read(`.specify/templates/overrides/${file}-template.md`);
			}
			const source = `.specify/templates/${file}-template.md`;
			return await workspace.exists(source) ? workspace.read(source) : fs.readFile(path.join(scratch, source), 'utf8');
		};
		let setup = false;
		return {
			artifactRoot: base,
			dispose,
			plan: async (run, input) => {
				try {
					if (!setup) {
						const current = await workspace.exists(constitution) ? await workspace.read(constitution) : '';
						if (!current || current.includes('[PROJECT_NAME]')) {
							const written = new Set<string>();
							await run(`${input}\n\n${await command('constitution')}\n\n${current || await template('constitution')}`,
								'Fill the constitution with principles supported by the workspace. Write constitution.md with write_artifact.',
								'Planning Agent · Spec Kit constitution',
								artifactTools(workspace, '.specify/memory', name => name === 'constitution.md', written));
							if (!written.has('constitution.md')) {
								throw new Error('The Planning Agent did not establish a Spec Kit constitution.');
							}
						}
					}
					await draft(run, input, 'specify', 'spec.md', await template('spec'),
						name => name === 'spec.md' || name === 'checklists/requirements.md');
					if (!setup) {
						await invoke('setup_plan');
					}
					const allowedPlanFile = (name: string) => ['plan.md', 'research.md', 'data-model.md', 'quickstart.md'].includes(name) ||
						/^contracts\/[\w./-]+$/.test(name) && !name.split('/').includes('..');
					const designFiles = await draft(run, input, 'plan', 'plan.md', await template('plan'), allowedPlanFile);
					const tasks = await invoke('setup_tasks') as { TASKS_TEMPLATE_CONTENT?: string };
					await draft(run, input, 'tasks', 'tasks.md', tasks.TASKS_TEMPLATE_CONTENT ?? await template('tasks'));
					setup = true;
					return [`# Spec Kit feature ${base}`, ...(await Promise.all(['spec.md', ...designFiles, 'tasks.md'].map(async file =>
						`## ${base}/${file}\n\n${await workspace.read(`${base}/${file}`)}`)))].join('\n\n');
				} catch (error) {
					cliFailure(error);
				}
			},
			implementation: async () => `## Spec Kit implementation instructions\n\nFeature folder: ${base}\n\n${await command('implement')}`,
		};
	} catch (error) {
		await dispose();
		cliFailure(error);
	}
}

export function createPlanning(
	mode: PlanningMode, workspace: Workspace, id: string, signal: AbortSignal,
): Promise<PlanningContext> {
	if (mode === 'OpenSpec') {
		return openSpec(workspace, id, signal);
	}
	if (mode === 'SpecKit') {
		return specKit(workspace, id, signal);
	}
	return Promise.resolve({
		plan: (run, input) => run(input,
			'Inspect the workspace. Return an implementation plan with the user goal, affected paths, ordered changes, risks and verification steps.'),
		implementation: async () => '',
	});
}
