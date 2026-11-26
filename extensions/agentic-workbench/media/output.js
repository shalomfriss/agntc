/* global acquireVsCodeApi */
'use strict';

const vscode = acquireVsCodeApi();
const wording = JSON.parse(document.body.dataset.localized);
const element = id => document.getElementById(id);
const interpolate = (pattern, value) => pattern.replace('{0}', () => value);

const runName = element('run-name');
const runStatus = element('run-status');
const runMode = element('run-mode');
const stream = element('stream');
const empty = element('empty');

function block(heading, detail, body, kind) {
	const section = document.createElement('section');
	section.className = `stage${kind ? ` ${kind}` : ''}`;
	const title = document.createElement('div');
	title.className = 'stage-head';
	const name = document.createElement('span');
	name.className = 'stage-name';
	name.textContent = heading;
	title.append(name);
	if (detail) {
		const meta = document.createElement('span');
		meta.className = 'stage-meta';
		meta.textContent = detail;
		title.append(meta);
	}
	section.append(title);
	if (body !== undefined) {
		const pre = document.createElement('pre');
		pre.className = 'stage-body';
		pre.textContent = body;
		section.append(pre);
	}
	return section;
}

function render(data) {
	const running = data.status === 'Running';
	runName.textContent = data.name || '';
	runStatus.textContent = data.status || '';
	runStatus.className = `status-badge ${String(data.status || '').toLowerCase()}`;
	runStatus.hidden = !data.name;
	runMode.textContent = data.mode ? data.mode : '';
	runMode.hidden = !data.mode;

	const hasContent = Boolean(data.name) && (data.stages.length || data.result || data.failure || running);
	empty.hidden = hasContent;
	empty.textContent = data.name ? '' : wording.idle;

	const blocks = [];
	if (data.task) {
		blocks.push(block(wording.request, '', data.task));
	}
	for (const stage of data.stages) {
		const detail = [stage.agent, stage.model, stage.attempt ? interpolate(wording.attempt, stage.attempt) : '']
			.filter(Boolean).join(' · ');
		if (stage.error) {
			blocks.push(block(stage.name, detail, stage.error, 'error'));
		} else {
			blocks.push(block(stage.name, detail, stage.output || wording.noOutput));
		}
	}
	if (running) {
		blocks.push(block(data.current || wording.running, '', wording.waiting, 'active'));
	}
	if (data.failure && !running) {
		blocks.push(block(wording.runEnded, '', data.failure, 'error'));
	}
	if (data.result && !running) {
		blocks.push(block(wording.result, '', data.result, 'result'));
	}
	stream.replaceChildren(...blocks);
	const last = stream.lastElementChild;
	if (last && running) {
		last.scrollIntoView({ block: 'nearest' });
	}
}

window.addEventListener('message', ({ data }) => {
	if (data.type === 'snapshot') {
		render(data);
	}
});

for (const tab of document.querySelectorAll('.panel-tab')) {
	tab.addEventListener('click', () => {
		if (!tab.classList.contains('active')) {
			vscode.postMessage({ type: 'switchPanel', panel: tab.dataset.panel });
		}
	});
}

vscode.postMessage({ type: 'ready' });
