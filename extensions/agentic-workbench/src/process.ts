import { spawn } from 'node:child_process';
import { checkCancelled } from './runner';

interface ProcessOptions {
	cwd?: string;
	input?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export async function runProcess(
	executable: string, args: string[], signal: AbortSignal, options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string }> {
	checkCancelled(signal);
	const limit = 8_000_000;
	const abort = AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 180_000)]);
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd, env: options.env, signal: abort, shell: false, windowsHide: true,
			stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout!.setEncoding('utf8').on('data', (data: string) => {
			stdout += data;
			if (stdout.length + stderr.length > limit) {
				child.kill();
			}
		});
		child.stderr!.setEncoding('utf8').on('data', (data: string) => {
			stderr += data;
			if (stdout.length + stderr.length > limit) {
				child.kill();
			}
		});
		child.once('error', (error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') {
				reject(new Error(`Could not find "${executable}". Install it and make it available on VS Code's PATH.`));
			} else if (abort.aborted) {
				reject(new Error(signal.aborted ? 'Run cancelled.' : `${executable} timed out.`));
			} else {
				reject(error);
			}
		});
		child.once('close', code => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(new ProcessError(executable, code, stderr || stdout));
			}
		});
		child.stdin?.on('error', () => {});
		if (options.input !== undefined) {
			child.stdin!.end(options.input);
		}
	});
}

export class ProcessError extends Error {
	constructor(executable: string, readonly code: number | null, readonly output: string) {
		super(`${executable} exited with ${code ?? 'a signal'}.`);
	}
}
