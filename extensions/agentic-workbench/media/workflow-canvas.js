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
	renderInspector();
}

function row(label, value) {
	const line = document.createElement('div');
	line.className = 'inspect-row';
	const key = document.createElement('span');
	key.className = 'inspect-key';
	key.textContent = label;
	const val = document.createElement('span');
	val.className = 'inspect-value';
	val.textContent = value;
	line.append(key, val);
	return line;
}

function renderInspector() {
	const inspector = element('inspector');
	const steps = snapshot.workflow && snapshot.workflow.steps;
	const step = steps && steps.find(value => value.id === selectedId);
	if (!step) {
		inspector.hidden = true;
		inspector.replaceChildren();
		return;
	}
	const kindLabel = {
		agent: 'Agent', input: 'Input', condition: 'Condition', tool: 'Tool', human: 'Human decision', subworkflow: 'Subworkflow',
	}[step.kind || 'agent'] || 'Agent';
	const title = document.createElement('div');
	title.className = 'inspect-title';
	title.textContent = `${step.name} · ${wording.inspector}`;
	const body = document.createElement('div');
	body.append(row(wording.inspectKind, kindLabel));
	if (step.kind !== 'input' && step.kind !== 'condition' && step.kind !== 'human') {
		const outputType = (snapshot.artifactTypes || []).find(value => value.id === (step.outputType || 'Text'));
		body.append(row(wording.inspectProduces, outputType ? outputType.name : (step.outputType || 'Text')));
		if (outputType && outputType.fields && outputType.fields.length) {
			body.append(row(wording.inspectContract, outputType.fields.join(', ')));
		}
	} else if (step.outputType) {
		body.append(row(wording.inspectProduces, typeName(step.outputType)));
	}
	const sources = (step.inputs || []).map(id => {
		const source = steps.find(value => value.id === id);
		if (!source) {
			return undefined;
		}
		const type = source.outputType && source.outputType !== 'Text' ? ` (${typeName(source.outputType)})` : '';
		return `${source.name}${type}`;
	}).filter(Boolean);
	body.append(row(wording.inspectInputs, sources.length ? sources.join(', ') : wording.inspectNone));
	inspector.replaceChildren(title, body);
	if (!readOnly && step.kind !== 'input') {
		const runTo = document.createElement('button');
		runTo.type = 'button';
		runTo.className = 'secondary inspect-run';
		runTo.textContent = wording.runToHere;
		runTo.addEventListener('click', () => post({ type: 'runTo', id: step.id }));
		inspector.append(runTo);
		const bp = document.createElement('button');
		bp.type = 'button';
		bp.className = 'text-button inspect-bp';
		bp.textContent = step.breakpoint ? wording.removeBreakpoint : wording.addBreakpoint;
		bp.addEventListener('click', () => post({ type: 'setBreakpoint', id: step.id, on: !step.breakpoint }));
		inspector.append(bp);
	}
	inspector.hidden = false;
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

function typeName(id) {
	const type = (snapshot.artifactTypes || []).find(value => value.id === id);
	return type ? type.name : id;
}

function typeBadge(id) {
	const badge = document.createElement('span');
	badge.className = 'badge type';
	badge.textContent = typeName(id);
	return badge;
}

function producesSelect(step) {
	const field = document.createElement('div');
	field.className = 'produces';
	const label = document.createElement('span');
	label.className = 'produces-label';
	label.textContent = wording.outputType;
	const select = document.createElement('select');
	select.className = 'type-select';
	for (const type of (snapshot.artifactTypes || [])) {
		select.append(new Option(type.name, type.id));
	}
	select.value = step.outputType || 'Text';
	select.disabled = readOnly;
	select.addEventListener('pointerdown', event => event.stopPropagation());
	select.addEventListener('change', () => post({ type: 'setOutputType', id: step.id, outputType: select.value }));
	field.append(label, select);
	return field;
}

function renderNode(step) {
	const node = document.createElement('div');
	const input = step.kind === 'input';
	const condition = step.kind === 'condition';
	const tool = step.kind === 'tool';
	const human = step.kind === 'human';
	const subworkflow = step.kind === 'subworkflow';
	node.className = `node ${input ? 'input' : condition ? 'condition' : tool ? 'tool' : human ? 'human' : subworkflow ? 'subworkflow' : 'agent'}`;
	node.dataset.id = step.id;
	node.style.left = `${step.x ?? 24}px`;
	node.style.top = `${step.y ?? 24}px`;

	if (!input) {
		node.append(makePort('in'));
	}

	node.classList.toggle('readonly', readOnly);
	node.classList.toggle('selected', step.id === selectedId);
	if (step.breakpoint) {
		const dot = document.createElement('span');
		dot.className = 'breakpoint-dot';
		dot.title = wording.removeBreakpoint;
		node.append(dot);
	}

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
		node.append(makePort('out'));
	} else if (condition) {
		const hint = document.createElement('p');
		hint.className = 'node-hint';
		hint.textContent = wording.condition;
		node.append(hint);
		const detail = document.createElement('div');
		detail.className = 'meta';
		detail.append(typeBadge('GateResult'));
		node.append(detail);
		node.append(makePort('out'));
	} else if (tool) {
		const command = document.createElement('input');
		command.className = 'command-input';
		command.type = 'text';
		command.spellcheck = false;
		command.placeholder = wording.commandPlaceholder;
		command.value = step.command || '';
		command.disabled = readOnly;
		command.addEventListener('pointerdown', event => event.stopPropagation());
		command.addEventListener('change', () => post({ type: 'setCommand', id: step.id, command: command.value.trim() }));
		node.append(command);
		const detail = document.createElement('div');
		detail.className = 'meta';
		detail.append(typeBadge('TestReport'));
		node.append(detail);
		const hint = document.createElement('p');
		hint.className = 'node-hint';
		hint.textContent = wording.toolHint;
		node.append(hint);
		node.append(makePort('out'));
	} else if (human) {
		const detail = document.createElement('div');
		detail.className = 'meta';
		detail.append(typeBadge('ReviewReport'));
		node.append(detail);
		const hint = document.createElement('p');
		hint.className = 'node-hint';
		hint.textContent = wording.humanHint;
		node.append(hint);
		node.append(makePort('out'));
	} else if (subworkflow) {
		const select = document.createElement('select');
		select.className = 'agent-select';
		const choices = (snapshot.workflows || []).filter(value => value.id !== step.id && value.id !== snapshot.selection && value.id !== 'code-factory');
		select.append(new Option(wording.chooseWorkflow, ''));
		for (const value of choices) {
			select.append(new Option(value.name, value.id));
		}
		select.value = step.workflowId || '';
		select.disabled = readOnly;
		select.addEventListener('pointerdown', event => event.stopPropagation());
		select.addEventListener('change', () => { if (select.value) { post({ type: 'setWorkflowRef', id: step.id, workflowId: select.value }); } });
		node.append(select);
		const hint = document.createElement('p');
		hint.className = 'node-hint';
		hint.textContent = wording.subHint;
		node.append(hint);
		node.append(makePort('out'));
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
		node.append(producesSelect(step));

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

	node.addEventListener('pointerdown', event => beginDrag(event, node, step));
	node.addEventListener('click', event => {
		if (event.target.closest('button, select, input, .port')) {
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
	const byId = new Map(steps.map(value => [value.id, value]));
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
			const source = byId.get(sourceId);
			const outputType = source && source.outputType;
			if (outputType && outputType !== 'Text') {
				const text = document.createElementNS(svgNs, 'text');
				text.setAttribute('x', (from.x + to.x) / 2);
				text.setAttribute('y', (from.y + to.y) / 2);
				text.setAttribute('class', 'wire-label');
				text.textContent = typeName(outputType);
				wires.append(text);
			}
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
	for (const id of ['add-input', 'add-agent', 'add-condition', 'add-tool', 'add-human', 'add-sub', 'rename', 'delete', 'save', 'validate']) {
		element(id).hidden = !editable;
	}
	const steps = workflow?.steps ?? [];
	nodesLayer.replaceChildren(...steps.map(renderNode));
	placeholder.hidden = Boolean(workflow && steps.length);
	placeholder.textContent = !workflow ? wording.noWorkflows : wording.emptyWorkflow;
	element('hint').textContent = readOnly ? wording.readOnlyHint
		: workflow && steps.length ? wording.linkHint : '';
	renderInspector();
	requestAnimationFrame(renderWires);
}

function pointAt(event) {
	const rect = nodesLayer.getBoundingClientRect();
	return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function beginDrag(event, node, step) {
	nodeMoved = false;
	if (readOnly || event.button !== 0 || event.target.closest('button, select, input, .port')) {
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
element('add-condition').addEventListener('click', () => post({ type: 'addNode', kind: 'condition' }));
element('add-tool').addEventListener('click', () => post({ type: 'addNode', kind: 'tool' }));
element('add-human').addEventListener('click', () => post({ type: 'addNode', kind: 'human' }));
element('add-sub').addEventListener('click', () => post({ type: 'addNode', kind: 'subworkflow' }));
element('save').addEventListener('click', () => {
	if (!snapshot.workflow) {
		return;
	}
	const positions = [...nodesLayer.children].map(node => ({
		id: node.dataset.id, x: node.offsetLeft, y: node.offsetTop,
	}));
	post({ type: 'saveLayout', positions });
});
element('validate').addEventListener('click', () => post({ type: 'validate' }));
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
