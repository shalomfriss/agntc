/* global acquireVsCodeApi */
'use strict';

const vscode = acquireVsCodeApi();

function showError(message) {
	let banner = document.getElementById('error-banner');
	if (!banner) {
		banner = document.createElement('div');
		banner.id = 'error-banner';
		banner.setAttribute('role', 'alert');
		(document.getElementById('root') ?? document.body).prepend(banner);
	}
	banner.textContent = message;
	banner.hidden = false;
}

window.addEventListener('error', event => {
	const where = event.filename ? ` (${event.filename.split('/').pop()}:${event.lineno})` : '';
	showError(`Canvas script error: ${event.message}${where}`);
});
window.addEventListener('unhandledrejection', event => {
	const reason = event.reason;
	showError(`Canvas error: ${(reason && reason.message) || reason}`);
});

const svgNs = 'http://www.w3.org/2000/svg';
const wording = JSON.parse(document.body.dataset.localized);
const element = id => document.getElementById(id);
const interpolate = (pattern, value) => pattern.replace('{0}', () => value);

const workflowSelect = element('workflow');
const nodesLayer = element('nodes');
const wires = element('wires');
const viewport = element('viewport');
const placeholder = element('placeholder');
const status = element('status');

let snapshot = { workflows: [], agents: [], workflow: undefined };
let agentsById = new Map();
let drag;
let readOnly = false;
let nodeMoved = false;
let clickTimer;
let selectedId;

function highlight(id) {
	selectedId = id;
	for (const node of nodesLayer.children) {
		node.classList.toggle('selected', node.dataset.id === id);
	}
}

function openNode(step) {
	if (step.kind !== 'input') {
		post({ type: 'openNode', id: step.id });
	}
}

function post(message) {
	vscode.postMessage(message);
}

function renderStatus(text = '', error = false) {
	status.textContent = text;
	status.classList.toggle('error', error);
	status.hidden = !text;
}

function agentMeta(agent) {
	if (!agent) {
		return { name: wording.missingAgent, access: '', missing: true };
	}
	return { name: agent.name, access: agent.access === 'write' ? wording.readWrite : wording.readOnly };
}

function subagentTree(agent, seen) {
	if (!agent || !agent.subagents || !agent.subagents.length || seen.has(agent.id)) {
		return undefined;
	}
	const next = new Set(seen).add(agent.id);
	const list = document.createElement('ul');
	list.className = 'subagents';
	for (const id of agent.subagents) {
		const child = agentsById.get(id);
		const item = document.createElement('li');
		const name = document.createElement('span');
		name.className = 'chip';
		name.textContent = child ? child.name : wording.missingAgent;
		item.append(name);
		const nested = subagentTree(child, next);
		if (nested) {
			item.append(nested);
		}
		list.append(item);
	}
	return list;
}

function makePort(kind) {
	const port = document.createElement('div');
	port.className = `port ${kind}`;
	port.dataset.port = kind;
	return port;
}

function iconButton(label, className, handler) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = `text-button ${className}`;
	button.textContent = label;
	button.addEventListener('click', event => {
		event.stopPropagation();
		handler();
	});
	return button;
}

function startRename(step) {
	post({ type: 'renameNode', id: step.id });
}

function renderNode(step) {
	const node = document.createElement('div');
	const input = step.kind === 'input';
	node.className = `node ${input ? 'input' : 'agent'}`;
	node.dataset.id = step.id;
	node.style.left = `${step.x ?? 24}px`;
	node.style.top = `${step.y ?? 24}px`;

	if (!input) {
		node.append(makePort('in'));
	}

	node.classList.toggle('readonly', readOnly);
	node.classList.toggle('selected', step.id === selectedId);

	const header = document.createElement('header');
	const title = document.createElement('span');
	title.className = 'title';
	title.textContent = step.name;
	if (!readOnly) {
		title.title = wording.rename;
		title.addEventListener('dblclick', () => { clearTimeout(clickTimer); startRename(step); });
	}
	header.append(title);
	if (!readOnly) {
		header.append(iconButton(wording.remove, 'remove', () => post({ type: 'remove', id: step.id })));
	}
	node.append(header);

	if (input) {
		const hint = document.createElement('p');
		hint.className = 'node-hint';
		hint.textContent = wording.inputHint;
		node.append(hint);
	} else {
		const agent = step.agentId ? agentsById.get(step.agentId) : undefined;
		const meta = agentMeta(agent);
		const select = document.createElement('select');
		select.className = 'agent-select';
		const choices = snapshot.agents.length
			? snapshot.agents
			: [];
		const placeholderOption = new Option(choices.length ? wording.chooseAgent : wording.noAgents, '');
		placeholderOption.disabled = choices.length > 0;
		select.append(placeholderOption);
		for (const value of choices) {
			select.append(new Option(value.name, value.id));
		}
		if (agent) {
			select.value = agent.id;
		} else if (step.agentId) {
			const orphan = new Option(wording.missingAgent, step.agentId);
			select.append(orphan);
			select.value = step.agentId;
		} else {
			select.value = '';
		}
		select.disabled = readOnly;
		select.addEventListener('pointerdown', event => event.stopPropagation());
		select.addEventListener('change', () => {
			if (select.value) {
				post({ type: 'setAgent', id: step.id, agentId: select.value });
			}
		});
		node.append(select);

		const detail = document.createElement('div');
		detail.className = 'meta';
		if (meta.access) {
			const access = document.createElement('span');
			access.className = 'badge';
			access.textContent = meta.access;
			detail.append(access);
		}
		if (agent && agent.maxSubagents) {
			const badge = document.createElement('span');
			badge.className = 'badge dynamic';
			badge.textContent = interpolate(wording.dynamic, agent.maxSubagents);
			detail.append(badge);
		}
		if (detail.childElementCount) {
			node.append(detail);
		}

		const tree = subagentTree(agent, new Set());
		if (tree) {
			const label = document.createElement('p');
			label.className = 'subagents-label';
			label.textContent = wording.subagents;
			node.append(label);
			node.append(tree);
		}
		node.append(makePort('out'));
	}

	if (input) {
		node.append(makePort('out'));
	}

	node.addEventListener('pointerdown', event => beginDrag(event, node, step));
	node.addEventListener('click', event => {
		if (event.target.closest('button, select, .port')) {
			return;
		}
		if (nodeMoved) {
			nodeMoved = false;
			return;
		}
		if (step.kind !== 'input') {
			highlight(step.id);
		}
		clearTimeout(clickTimer);
		clickTimer = setTimeout(() => openNode(step), 250);
	});
	return node;
}

function portCenter(nodeId, kind) {
	const node = nodesLayer.querySelector(`.node[data-id="${CSS.escape(nodeId)}"]`);
	const port = node?.querySelector(`.port.${kind}`);
	if (!node || !port) {
		return undefined;
	}
	return {
		x: node.offsetLeft + port.offsetLeft + port.offsetWidth / 2,
		y: node.offsetTop + port.offsetTop + port.offsetHeight / 2,
	};
}

function wirePath(from, to) {
	const curve = Math.max(24, Math.abs(to.y - from.y) / 2);
	return `M ${from.x} ${from.y} C ${from.x} ${from.y + curve}, ${to.x} ${to.y - curve}, ${to.x} ${to.y}`;
}

function renderWires() {
	wires.replaceChildren();
	const steps = snapshot.workflow?.steps ?? [];
	let maxX = viewport.clientWidth;
	let maxY = viewport.clientHeight;
	for (const node of nodesLayer.children) {
		maxX = Math.max(maxX, node.offsetLeft + node.offsetWidth + 40);
		maxY = Math.max(maxY, node.offsetTop + node.offsetHeight + 60);
	}
	nodesLayer.style.width = wires.style.width = `${maxX}px`;
	nodesLayer.style.height = wires.style.height = `${maxY}px`;
	wires.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);
	for (const step of steps) {
		for (const sourceId of step.inputs) {
			const from = portCenter(sourceId, 'out');
			const to = portCenter(step.id, 'in');
			if (!from || !to) {
				continue;
			}
			const path = document.createElementNS(svgNs, 'path');
			path.setAttribute('d', wirePath(from, to));
			path.setAttribute('class', 'wire');
			path.dataset.from = sourceId;
			path.dataset.to = step.id;
			const title = document.createElementNS(svgNs, 'title');
			title.textContent = wording.disconnect;
			path.append(title);
			path.addEventListener('pointerdown', event => {
				if (readOnly) {
					return;
				}
				event.stopPropagation();
				post({ type: 'unlink', from: sourceId, to: step.id });
			});
			wires.append(path);
		}
	}
}

function render() {
	const workflow = snapshot.workflow;
	readOnly = Boolean(workflow && workflow.readOnly);
	workflowSelect.replaceChildren(...snapshot.workflows.map(value => new Option(value.name, value.id)));
	if (workflow) {
		workflowSelect.value = workflow.id;
	}
	element('actions').hidden = !workflow;
	const editable = Boolean(workflow) && !readOnly;
	for (const id of ['add-input', 'add-agent', 'rename', 'delete', 'save']) {
		element(id).hidden = !editable;
	}
	const steps = workflow?.steps ?? [];
	nodesLayer.replaceChildren(...steps.map(renderNode));
	placeholder.hidden = Boolean(workflow && steps.length);
	placeholder.textContent = !workflow ? wording.noWorkflows : wording.emptyWorkflow;
	element('hint').textContent = readOnly ? wording.readOnlyHint
		: workflow && steps.length ? wording.linkHint : '';
	requestAnimationFrame(renderWires);
}

function pointAt(event) {
	const rect = nodesLayer.getBoundingClientRect();
	return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function beginDrag(event, node, step) {
	nodeMoved = false;
	if (readOnly || event.button !== 0 || event.target.closest('button, select, .port')) {
		return;
	}
	event.preventDefault();
	const start = pointAt(event);
	drag = {
		kind: 'move', node, step, dx: start.x - node.offsetLeft, dy: start.y - node.offsetTop,
		originX: node.offsetLeft, originY: node.offsetTop, startX: start.x, startY: start.y,
	};
	node.classList.add('dragging');
	node.setPointerCapture(event.pointerId);
}

function beginLink(event, port) {
	if (event.button !== 0) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	const node = port.closest('.node');
	const temp = document.createElementNS(svgNs, 'path');
	temp.setAttribute('class', 'wire pending');
	wires.append(temp);
	drag = { kind: 'link', from: node.dataset.id, temp };
	port.setPointerCapture(event.pointerId);
	drag.release = port;
}

function onPointerMove(event) {
	if (!drag) {
		return;
	}
	const point = pointAt(event);
	if (drag.kind === 'move') {
		if (!nodeMoved && Math.hypot(point.x - drag.startX, point.y - drag.startY) < 3) {
			return;
		}
		nodeMoved = true;
		drag.node.style.left = `${Math.max(0, Math.round(point.x - drag.dx))}px`;
		drag.node.style.top = `${Math.max(0, Math.round(point.y - drag.dy))}px`;
		renderWires();
	} else {
		const from = portCenter(drag.from, 'out');
		if (from) {
			drag.temp.setAttribute('d', wirePath(from, point));
		}
	}
}

function onPointerUp(event) {
	if (!drag) {
		return;
	}
	if (drag.kind === 'move') {
		drag.node.classList.remove('dragging');
		if (drag.node.offsetLeft !== drag.originX || drag.node.offsetTop !== drag.originY) {
			post({ type: 'move', id: drag.step.id, x: drag.node.offsetLeft, y: drag.node.offsetTop });
		}
	} else {
		drag.temp.remove();
		const target = document.elementFromPoint(event.clientX, event.clientY);
		const port = target?.closest('.port.in');
		const node = port?.closest('.node');
		if (node && node.dataset.id !== drag.from) {
			post({ type: 'link', from: drag.from, to: node.dataset.id });
		}
	}
	drag = undefined;
}

nodesLayer.addEventListener('pointerdown', event => {
	if (readOnly) {
		return;
	}
	const port = event.target.closest('.port.out');
	if (port) {
		beginLink(event, port);
	}
});
document.addEventListener('pointermove', onPointerMove);
document.addEventListener('pointerup', onPointerUp);

workflowSelect.addEventListener('change', () => post({ type: 'select', id: workflowSelect.value }));
element('new').addEventListener('click', () => post({ type: 'create' }));
element('rename').addEventListener('click', () => post({ type: 'rename' }));
element('delete').addEventListener('click', () => post({ type: 'delete' }));
element('add-input').addEventListener('click', () => post({ type: 'addNode', kind: 'input' }));
element('add-agent').addEventListener('click', () => {
	if (!snapshot.agents.length) {
		post({ type: 'createAgent' });
		return;
	}
	post({ type: 'addNode', kind: 'agent', agentId: snapshot.agents[0].id });
});
element('save').addEventListener('click', () => {
	if (!snapshot.workflow) {
		return;
	}
	const positions = [...nodesLayer.children].map(node => ({
		id: node.dataset.id, x: node.offsetLeft, y: node.offsetTop,
	}));
	post({ type: 'saveLayout', positions });
});
element('run').addEventListener('click', () => post({ type: 'run' }));

window.addEventListener('message', ({ data }) => {
	if (data.type === 'snapshot') {
		snapshot = data;
		agentsById = new Map(data.agents.map(agent => [agent.id, agent]));
		renderStatus();
		render();
	} else if (data.type === 'error') {
		renderStatus(data.text, true);
	} else if (data.type === 'status') {
		renderStatus(data.text);
	}
});

for (const tab of document.querySelectorAll('.panel-tab')) {
	tab.addEventListener('click', () => {
		if (!tab.classList.contains('active')) {
			post({ type: 'switchPanel', panel: tab.dataset.panel });
		}
	});
}

post({ type: 'ready' });
