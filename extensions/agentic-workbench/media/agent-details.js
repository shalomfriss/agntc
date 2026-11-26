/* global acquireVsCodeApi */
'use strict';

const vscode = acquireVsCodeApi();
const previous = vscode.getState();
const drafts = new Map(Object.entries(previous?.drafts ?? {}));
const catalogs = new Map();

const element = id => document.getElementById(id);
const form = element('details');
const wording = JSON.parse(form.dataset.localized);
const interpolate = (pattern, value) => pattern.replace('{0}', () => value);
const agent = element('agent');
const nameInput = element('name');
const instructions = element('instructions');
const provider = element('provider');
const model = element('model');
const modelId = element('model-id');
const access = element('access');
const subagent = element('subagent');
const maxSubagents = element('max-subagents');
const skill = element('skill');
const status = element('status');

let snapshot;
let selection = previous?.selection;
let linked = [];
let skills = [];
let busy;
let savedId;
let requestId = 0;

function option(label, value, disabled = false) {
	const node = new Option(label, value);
	node.disabled = disabled;
	return node;
}

function savedDetails() {
	const current = snapshot.agents.find(value => value.id === selection);
	return {
		name: current?.name ?? '',
		instructions: current?.instructions ?? '',
		providerId: current?.providerId ?? '',
		model: current?.model ?? '',
		access: current?.access ?? 'read',
		subagents: current?.subagents ?? [],
		skills: current?.skills ?? [],
		maxSubagents: current?.maxSubagents ?? '',
	};
}

function draftDetails() {
	return {
		name: nameInput.value.trim(),
		instructions: instructions.value.trim(),
		providerId: provider.value,
		model: model.value === 'custom' ? modelId.value.trim() : model.value.slice('model:'.length),
		access: access.value,
		subagents: linked,
		skills: skills,
		maxSubagents: maxSubagents.value.trim() === '' ? '' : Number(maxSubagents.value),
	};
}

function isDirty() {
	return JSON.stringify(draftDetails()) !== JSON.stringify(savedDetails());
}

function renderStatus(text = '', error = false) {
	status.textContent = text;
	status.classList.toggle('error', error);
}

function persist() {
	vscode.setState({ selection, drafts: Object.fromEntries(drafts) });
}

function collect() {
	const details = draftDetails();
	if (isDirty() || nameInput.value !== details.name || instructions.value !== details.instructions || model.value === 'custom') {
		drafts.set(selection, { ...details, name: nameInput.value, instructions: instructions.value,
			custom: model.value === 'custom', model: model.value === 'custom' ? modelId.value : details.model });
	} else {
		drafts.delete(selection);
	}
	persist();
}

function activeProfile() {
	return snapshot.profiles.find(value => value.id === (provider.value || snapshot.defaultId));
}

function renderModel(value, custom = false) {
	const profile = activeProfile();
	const available = catalogs.get(profile?.id);
	const options = available?.models ?? [];
	const hasModel = options.some(item => item.id === value);
	const useCustom = custom || Boolean(value && !hasModel);
	model.replaceChildren(
		option(profile?.model ? interpolate(wording.providerDefaultModel, profile.model) : wording.providerDefault, ''),
		...options.map(item => option(item.label, `model:${item.id}`)),
		option(wording.customModel, 'custom'),
	);
	model.value = useCustom ? 'custom' : value ? `model:${value}` : '';
	element('custom-model').hidden = !useCustom;
	modelId.required = useCustom;
	modelId.value = useCustom ? value : '';
	const load = element('load-models');
	load.hidden = !profile?.hasCatalog;
	load.disabled = available?.loading ?? false;
	load.textContent = available?.loading ? wording.loadingModels : available?.models ? wording.refreshModels : wording.loadModels;
	const hint = element('model-hint');
	hint.textContent = available?.error ?? (available?.models?.length === 0
		? wording.noModels
		: profile?.hasCatalog ? '' : wording.overrideModel);
	hint.hidden = !hint.textContent;
}

function renderProvider(id) {
	const defaultProfile = snapshot.profiles.find(value => value.id === snapshot.defaultId);
	const disconnected = id && !snapshot.profiles.some(value => value.id === id);
	provider.replaceChildren(option(defaultProfile ? interpolate(wording.workbenchDefaultProvider, defaultProfile.name) : wording.workbenchDefault, ''),
		...snapshot.profiles.map(value => option(value.name, value.id)),
		...(disconnected ? [option(wording.disconnectedProvider, id)] : []));
	provider.value = id;
	renderProviderHint();
}

function renderProviderHint() {
	const profile = activeProfile();
	const hint = element('provider-hint');
	hint.textContent = profile ? '' : provider.value ? wording.providerDisconnected : wording.providerRequired;
	hint.hidden = !hint.textContent;
	element('connect').textContent = profile ? wording.addProvider : wording.connectProvider;
}

function renderAccess() {
	element('access-hint').textContent = access.value === 'write'
		? wording.writeAccess
		: wording.readAccess;
}

function ancestorIds() {
	const blocked = new Set();
	const queue = [selection];
	while (queue.length) {
		const id = queue.pop();
		if (!blocked.has(id)) {
			blocked.add(id);
			queue.push(...snapshot.agents.filter(value => value.subagents.includes(id)).map(value => value.id));
		}
	}
	return blocked;
}

function relation(label, detail, id, remove) {
	const item = document.createElement('li');
	const content = document.createElement('span');
	content.className = 'relation-name';
	if (id) {
		const link = document.createElement('button');
		link.type = 'button';
		link.className = 'text-button';
		link.textContent = label;
		link.addEventListener('click', () => selectAgent(id));
		content.append(link);
	} else {
		content.textContent = label;
	}
	item.append(content);
	if (detail) {
		const text = document.createElement('span');
		text.className = 'detail';
		text.textContent = detail;
		item.append(text);
	}
	if (remove) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'text-button';
		button.setAttribute('aria-label', interpolate(wording.unlinkNamed, label));
		button.textContent = wording.unlink;
		button.addEventListener('click', remove);
		item.append(button);
	}
	return item;
}

function renderLinks() {
	const ancestor = ancestorIds();
	const candidates = snapshot.agents.filter(value => value.id !== selection && !linked.includes(value.id));
	const open = candidates.some(value => !ancestor.has(value.id));
	subagent.replaceChildren(option(open ? wording.chooseSubagent : wording.noSubagents, ''),
		...candidates.map(value => option(ancestor.has(value.id) ? interpolate(wording.circularLink, value.name) : value.name,
			value.id, ancestor.has(value.id))));
	subagent.disabled = !open;
	element('subagent-hint').textContent = open
		? wording.subagentProvider
		: wording.createSubagent;
	element('subagent-count').textContent = linked.length ? String(linked.length) : '';
	element('subagents').replaceChildren(...linked.map(id => {
		const entry = snapshot.agents.find(value => value.id === id);
		return relation(entry?.name ?? wording.unavailableAgent, entry ? '' : wording.deletedAgent, id, () => {
			linked = linked.filter(value => value !== id);
			renderLinks();
			update();
			subagent.focus();
		});
	}));
}

function renderSkills() {
	const catalog = snapshot.skills ?? [];
	const available = catalog.filter(value => !skills.includes(value.id));
	skill.replaceChildren(option(catalog.length ? wording.chooseSkill : wording.noSkills, ''),
		...available.map(value => option(value.source ? `${value.name} · ${value.source}` : value.name, value.id)));
	skill.disabled = available.length === 0;
	element('skill-count').textContent = skills.length ? String(skills.length) : '';
	element('skills').replaceChildren(...skills.map(id => {
		const entry = catalog.find(value => value.id === id);
		return relation(entry?.name ?? id, entry?.description || (entry ? '' : wording.unavailableSkill), undefined, () => {
			skills = skills.filter(value => value !== id);
			renderSkills();
			update();
			skill.focus();
		});
	}));
}

function renderUsage() {
	const usedBy = snapshot.usedBy;
	element('usage').hidden = usedBy.length === 0;
	element('dependencies').replaceChildren(...usedBy.map(value => relation(value.label, value.detail, value.agentId)));
}

function renderActions() {
	const dirty = isDirty();
	const editing = selection !== 'new';
	const canRun = !dirty && Boolean(activeProfile()) && !busy;
	const run = element('run');
	run.hidden = !editing;
	run.disabled = !canRun;
	run.title = dirty ? wording.saveBeforeRun : !activeProfile() ? wording.providerRequired : wording.run;
	element('agent-name').textContent = editing ? (nameInput.value.trim() || wording.agentDetails) : wording.newAgent;
	element('save').textContent = busy ? (busy === 'delete' ? wording.deleteInProgress : wording.saveInProgress) : editing ? wording.saveChanges : wording.saveAgent;
	element('save').disabled = Boolean(busy) || !dirty;
	element('discard').disabled = Boolean(busy) || (!dirty && !drafts.has(selection));
	const remove = element('delete');
	remove.hidden = !editing;
	remove.disabled = Boolean(busy) || snapshot.usedBy.length > 0;
	remove.title = snapshot.usedBy.length > 0 ? wording.unlinkBeforeDelete : wording.delete;
	element('form-body').inert = Boolean(busy);
	element('new-agent').disabled = Boolean(busy) || selection === 'new';
	agent.disabled = Boolean(busy);
}

function apply() {
	const draft = drafts.get(selection) ?? savedDetails();
	nameInput.value = draft.name;
	instructions.value = draft.instructions;
	access.value = draft.access;
	maxSubagents.value = draft.maxSubagents === '' || draft.maxSubagents == null ? '' : String(draft.maxSubagents);
	linked = [...draft.subagents];
	skills = [...(draft.skills ?? [])];
	renderProvider(draft.providerId);
	renderModel(draft.model, draft.custom);
	renderAccess();
	renderLinks();
	renderSkills();
	renderUsage();
	renderActions();
}

function selectAgent(key) {
	if (selection !== key) {
		vscode.postMessage({ type: 'select', key });
	}
}

function update() {
	renderStatus();
	collect();
	renderActions();
}

window.addEventListener('message', ({ data }) => {
	switch (data.type) {
		case 'snapshot': {
			const changed = selection !== data.selection;
			snapshot = data;
			selection = data.selection;
			agent.replaceChildren(
				...data.agents.map(value => option(value.name, value.id)),
				...(selection === 'new' ? [option(wording.newAgent, 'new')] : []),
			);
			agent.value = selection;
			form.hidden = false;
			if (changed) {
				busy = undefined;
				renderStatus();
				element('form-body').scrollTop = 0;
			}
			apply();
			persist();
			if (selection === savedId) {
				savedId = undefined;
				renderStatus(wording.saved);
			}
			if (changed && selection === 'new') {
				nameInput.focus();
			}
			break;
		}
		case 'saved':
			drafts.delete(data.key);
			if (selection === data.key) {
				busy = undefined;
				savedId = data.id;
			}
			persist();
			break;
		case 'deleted':
			busy = undefined;
			if (data.deleted) {
				drafts.delete(data.key);
			}
			persist();
			break;
		case 'models':
		case 'error':
			if (data.type === 'models' || data.action === 'models') {
				if (catalogs.get(data.providerId)?.requestId === data.requestId) {
					const previous = catalogs.get(data.providerId);
					catalogs.set(data.providerId, data.type === 'models' ? { models: data.models } : { models: previous?.models, error: data.text });
					if (activeProfile()?.id === data.providerId) {
						const value = model.value === 'custom' ? modelId.value : draftDetails().model;
						renderModel(value, model.value === 'custom' && !value);
						collect();
						renderActions();
					}
				}
			} else if (selection === data.key) {
				busy = undefined;
				renderStatus(data.text, true);
				renderActions();
			}
			break;
	}
});

agent.addEventListener('change', () => selectAgent(agent.value));
element('new-agent').addEventListener('click', () => selectAgent('new'));
element('connect').addEventListener('click', () => vscode.postMessage({ type: 'connect' }));
element('run').addEventListener('click', () => vscode.postMessage({ type: 'run', key: selection }));
element('delete').addEventListener('click', () => {
	busy = 'delete';
	renderActions();
	vscode.postMessage({ type: 'delete', key: selection });
});
element('discard').addEventListener('click', () => {
	drafts.delete(selection);
	persist();
	apply();
	renderStatus(wording.discarded);
});
for (const control of [nameInput, instructions, modelId, maxSubagents]) {
	control.addEventListener('input', update);
}
provider.addEventListener('change', () => {
	renderProviderHint();
	renderModel('');
	update();
});
model.addEventListener('change', () => {
	const useCustom = model.value === 'custom';
	element('custom-model').hidden = !useCustom;
	modelId.required = useCustom;
	if (useCustom) {
		modelId.focus();
	}
	update();
});
access.addEventListener('change', () => {
	renderAccess();
	update();
});
subagent.addEventListener('change', () => {
	if (subagent.value) {
		linked = [...linked, subagent.value];
		renderLinks();
		update();
	}
});
skill.addEventListener('change', () => {
	if (skill.value) {
		skills = [...skills, skill.value];
		renderSkills();
		update();
	}
});
element('load-models').addEventListener('click', () => {
	const providerId = activeProfile()?.id;
	if (providerId) {
		catalogs.set(providerId, { models: catalogs.get(providerId)?.models, requestId: ++requestId, loading: true });
		renderModel(model.value === 'custom' ? modelId.value : draftDetails().model, model.value === 'custom');
		vscode.postMessage({ type: 'models', providerId, requestId });
	}
});
form.addEventListener('submit', event => {
	event.preventDefault();
	const draft = draftDetails();
	for (const [control, value] of [[nameInput, draft.name], [instructions, draft.instructions]]) {
		if (!value) {
			renderStatus(control === nameInput ? wording.nameRequired : wording.instructionsRequired, true);
			control.focus();
			return;
		}
	}
	busy = 'save';
	renderActions();
	vscode.postMessage({ type: 'save', key: selection, draft });
});

vscode.postMessage({ type: 'ready', key: selection });
