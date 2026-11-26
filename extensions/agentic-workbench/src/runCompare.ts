import { PersistedRun } from './output';

function stageMap(run: PersistedRun): Map<string, string> {
	return new Map(run.stages.map(stage => [stage.name, stage.error ?? stage.output ?? '']));
}

/** Produces a Markdown comparison of two saved runs: status, request, per-stage changes, and result. */
export function compareRuns(a: PersistedRun, b: PersistedRun): string {
	const lines = [
		'# Run comparison', '',
		`**A** ${a.name} · ${a.status}`, `**B** ${b.name} · ${b.status}`, '',
	];
	if ((a.task ?? '') !== (b.task ?? '')) {
		lines.push('## Request', '', `- A: ${a.task ?? '—'}`, `- B: ${b.task ?? '—'}`, '');
	}
	const left = stageMap(a);
	const right = stageMap(b);
	const names = [...new Set([...left.keys(), ...right.keys()])];
	lines.push('## Stages', '');
	for (const name of names) {
		const hasLeft = left.has(name);
		const hasRight = right.has(name);
		const state = !hasLeft ? 'only in B' : !hasRight ? 'only in A'
			: left.get(name) === right.get(name) ? 'unchanged' : 'changed';
		lines.push(`- **${name}** — ${state}`);
	}
	lines.push('');
	const resultA = a.failure ?? a.result ?? '';
	const resultB = b.failure ?? b.result ?? '';
	lines.push('## Result', '', resultA === resultB ? 'Identical final result.' : 'Final results differ.', '');
	if (resultA !== resultB) {
		lines.push('### A', '', resultA || '—', '', '### B', '', resultB || '—');
	}
	return `${lines.join('\n')}\n`;
}
