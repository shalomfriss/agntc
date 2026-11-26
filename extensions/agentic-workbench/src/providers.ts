import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { checkCancelled, Message, Model } from './runner';
import { ProcessError, runProcess } from './process';

export const providerKinds = {
	copilot: { label: 'GitHub Copilot', description: 'VS Code account and model access' },
	codex: { label: 'OpenAI Codex', description: 'ChatGPT sign-in through Codex CLI' },
	claudeCode: { label: 'Claude Code', description: 'Anthropic sign-in through Claude Code CLI' },
	openai: { label: 'OpenAI API', description: 'OpenAI API key' },
	anthropic: { label: 'Anthropic API', description: 'Anthropic API key' },
	gemini: { label: 'Google Gemini', description: 'Google AI Studio API key' },
	compatible: { label: 'OpenAI-compatible', description: 'Custom endpoint, e.g. Ollama, OpenRouter, DeepSeek, or Mistral' },
};

export type ProviderKind = keyof typeof providerKinds;

export interface ProviderProfile {
	id: string;
	name: string;
	kind: ProviderKind;
	model?: string;
	baseUrl?: string;
}

export function usesApiKey(kind: ProviderKind): boolean {
	return ['openai', 'anthropic', 'gemini', 'compatible'].includes(kind);
}

export function validateEndpoint(value: string): string {
	const url = new URL(value);
	const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
	if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
		url.username || url.password || url.search || url.hash) {
		throw new Error('Use an HTTPS base URL or a loopback HTTP URL, without credentials, query or fragment.');
	}
	return url.toString().replace(/\/+$/, '');
}

interface OpenAIResponse {
	status: string;
	output?: Array<{ content?: Array<{ type: string; text?: string }> }>;
}

interface ChatResponse {
	choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
}

interface ClaudeResponse {
	content?: Array<{ type: string; text?: string }>;
	stop_reason?: string;
}

async function post<T>(
	url: string, headers: Record<string, string>, payload: object, signal: AbortSignal,
): Promise<T> {
	const timeout = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
	const response = await fetch(url, {
		method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(payload), signal: timeout, redirect: 'error',
	});
	if (!response.ok) {
		const requestId = response.headers.get('request-id') ?? response.headers.get('x-request-id');
		await response.body?.cancel();
		throw new Error(`Provider returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}.`);
	}
	return await response.json() as T;
}

const geminiApiBase = 'https://generativelanguage.googleapis.com/v1beta/openai';
const openAiApiBase = 'https://api.openai.com/v1';
const anthropicApiBase = 'https://api.anthropic.com/v1';

function authHeaders(profile: ProviderProfile, key?: string): Record<string, string> {
	if (profile.kind === 'anthropic') {
		return { 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' };
	}
	return key ? { Authorization: `Bearer ${key}` } : {};
}

function apiBase(profile: ProviderProfile): string {
	switch (profile.kind) {
		case 'openai': return openAiApiBase;
		case 'anthropic': return anthropicApiBase;
		case 'gemini': return geminiApiBase;
		default: return validateEndpoint(profile.baseUrl ?? '');
	}
}

export async function discoverModels(profile: ProviderProfile, key?: string): Promise<Array<{ id: string; label: string }>> {
	if (profile.kind === 'copilot') {
		return (await copilotModels()).map(({ id, name }) => ({ id, label: name }));
	}
	if (!usesApiKey(profile.kind)) {
		return [];
	}
	if (!key && profile.kind !== 'compatible') {
		throw new Error(vscode.l10n.t("Add an API key for this provider first."));
	}
	const response = await fetch(`${apiBase(profile)}/models${profile.kind === 'anthropic' ? '?limit=1000' : ''}`, {
		headers: authHeaders(profile, key), signal: AbortSignal.timeout(15_000), redirect: 'error',
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(vscode.l10n.t("The provider returned HTTP {0} for its model catalog.", response.status));
	}
	const result = await response.json() as { data?: Array<{ id?: unknown; display_name?: unknown }> };
	if (!Array.isArray(result?.data)) {
		throw new Error(vscode.l10n.t("The provider returned an unrecognized model catalog."));
	}
	const models = new Map<string, { id: string; label: string }>();
	for (const model of result.data) {
		if (typeof model?.id === 'string' && model.id.trim()) {
			models.set(model.id, { id: model.id, label: typeof model.display_name === 'string' ? model.display_name : model.id });
		}
	}
	return [...models.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function nonEmpty(value: string | undefined): string {
	if (!value?.trim()) {
		throw new Error('The model returned no text.');
	}
	return value;
}

function apiModel(profile: ProviderProfile, model: string, key?: string): Model {
	if (!model) {
		throw new Error(`Choose a model ID for ${profile.name}.`);
	}
	const headers = authHeaders(profile, key);
	const request = async (system: string, history: Message[], signal: AbortSignal): Promise<string> => {
		if (profile.kind === 'openai') {
			const result = await post<OpenAIResponse>(`${openAiApiBase}/responses`, headers, {
				model, instructions: system, input: history, store: false, max_output_tokens: 16_384,
			}, signal);
			if (result.status !== 'completed') {
				throw new Error(`OpenAI returned a response with status "${result.status}".`);
			}
			return nonEmpty(result.output?.flatMap(item => item.content ?? [])
				.filter(part => part.type === 'output_text').map(part => part.text).join(''));
		}
		if (profile.kind === 'anthropic') {
			const result = await post<ClaudeResponse>(`${anthropicApiBase}/messages`, headers,
				{ model, system, messages: history, max_tokens: 16_384 }, signal);
			if (result.stop_reason === 'max_tokens') {
				throw new Error('Anthropic reached the output token limit.');
			}
			return nonEmpty(result.content?.filter(part => part.type === 'text').map(part => part.text).join(''));
		}
		const result = await post<ChatResponse>(`${apiBase(profile)}/chat/completions`, headers, {
			model, messages: [{ role: 'system', content: system }, ...history],
		}, signal);
		if (result.choices?.[0]?.finish_reason === 'length') {
			throw new Error('The model reached its output token limit.');
		}
		return nonEmpty(result.choices?.[0]?.message?.content);
	};
	return { id: model, label: `${profile.name} / ${model}`, request };
}

function cliModel(profile: ProviderProfile, model?: string): Model {
	const request = async (system: string, history: Message[], signal: AbortSignal): Promise<string> => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-model-'));
		const input = `${system}\n\nConversation (JSON):\n${JSON.stringify(history)}\n\nRespond to the last user message now.`;
		const modelFlag = model ? ['--model', model] : [];
		const isCodex = profile.kind === 'codex';
		try {
			if (isCodex) {
				const output = path.join(cwd, 'response.txt');
				await runProcess('codex', [
					'--ask-for-approval', 'never', 'exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
					'--ignore-rules', '--sandbox', 'read-only', '--disable', 'shell_tool', '--disable', 'plugins',
					'--disable', 'hooks', '--output-last-message', output, ...modelFlag, '-',
				], signal, { cwd, input });
				return nonEmpty(await fs.readFile(output, 'utf8'));
			}
			const { stdout } = await runProcess('claude', [
				'--print', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config',
				'--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--tools', '',
				'--disable-slash-commands', ...modelFlag,
			], signal, { cwd, input });
			const result = JSON.parse(stdout) as { result?: string; is_error?: boolean };
			if (result.is_error) {
				throw new Error('Claude Code could not complete the request. Check its account status and selected model.');
			}
			return nonEmpty(result.result);
		} catch (error) {
			if (error instanceof ProcessError) {
				throw new Error(`${profile.name} could not complete the request. Check CLI login status and model access.`);
			}
			throw error;
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	};
	return { id: model ?? 'auto', label: `${profile.name} / ${model ?? 'CLI default'}`, request };
}

export async function verifyCliLogin(kind: 'codex' | 'claudeCode'): Promise<void> {
	const args = kind === 'codex' ? ['login', 'status'] : ['auth', 'status'];
	try {
		await runProcess(kind === 'codex' ? 'codex' : 'claude', args, AbortSignal.timeout(20_000), { cwd: os.tmpdir() });
	} catch (error) {
		if (error instanceof ProcessError) {
			throw new Error(`Sign in using ${kind === 'codex' ? 'codex login' : 'claude auth login'}, then retry.`);
		}
		throw error;
	}
}

export function copilotModels(): Thenable<vscode.LanguageModelChat[]> {
	return vscode.lm.selectChatModels({ vendor: 'copilot' });
}

export async function resolveModel(
	profile: ProviderProfile, secret: string | undefined, override?: string,
): Promise<Model> {
	const selected = override ?? profile.model;
	if (profile.kind === 'copilot') {
		const models = await copilotModels();
		const model = selected ? models.find(value => value.id === selected) : models[0];
		if (!model) {
			throw new Error(`Copilot model ${selected ?? 'access'} is unavailable. Enable GitHub Copilot Chat, sign in, and choose an available model.`);
		}
		return {
			id: model.id, label: `${profile.name} / ${model.name}`,
			request: async (system, history, signal) => {
				checkCancelled(signal);
				const source = new vscode.CancellationTokenSource();
				const abort = () => source.cancel();
				signal.addEventListener('abort', abort, { once: true });
				try {
					const messages = history.map(({ role, content }, index) => role === 'user'
						? vscode.LanguageModelChatMessage.User(index === 0 ? `${system}\n\n${content}` : content)
						: vscode.LanguageModelChatMessage.Assistant(content));
					const response = await model.sendRequest(messages, {}, source.token);
					let output = '';
					for await (const item of response.text) {
						output += item;
					}
					return nonEmpty(output);
				} finally {
					signal.removeEventListener('abort', abort);
					source.dispose();
				}
			},
		};
	}
	if (profile.kind === 'codex' || profile.kind === 'claudeCode') {
		await verifyCliLogin(profile.kind);
		return cliModel(profile, selected);
	}
	if (profile.kind !== 'compatible' && !secret) {
		throw new Error(`Add an API key for "${profile.name}" in Manage AI Provider.`);
	}
	return apiModel(profile, selected ?? '', secret);
}
