import * as vscode from 'vscode';
import { defaultWorkbench, orderedSteps, validateSubagents, Workbench } from './model';
import { ProviderProfile } from './providers';

export interface RunEntry {
	id: string;
	name: string;
	startedAt: string;
	status: 'Succeeded' | 'Failed' | 'Cancelled';
}

interface Providers {
	profiles: ProviderProfile[];
	defaultId?: string;
	revision?: number;
}

export class State implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onChange = this.changed.event;
	private writes: Promise<unknown> = Promise.resolve();
	private localProviders?: Providers;
	private localWorkbench?: Workbench;
	private localRuns?: RunEntry[];

	constructor(readonly context: vscode.ExtensionContext) {}

	private async update(operation: () => Promise<void>): Promise<void> {
		const current = this.writes.then(operation);
		this.writes = current.catch(() => {});
		await current;
		this.changed.fire();
	}

	get workbench(): Workbench {
		return structuredClone(this.localWorkbench ?? this.context.workspaceState.get<Workbench>('workbench') ?? defaultWorkbench());
	}

	updateWorkbench(change: (workbench: Workbench) => void): Promise<void> {
		return this.update(async () => {
			const workbench = this.workbench;
			change(workbench);
			validateSubagents(workbench.agents);
			workbench.workflows.forEach(orderedSteps);
			await this.context.workspaceState.update('workbench', workbench);
			this.localWorkbench = workbench;
		});
	}

	get providers(): Providers {
		const stored = this.context.globalState.get<Providers>('providers');
		const providers = (stored?.revision ?? 0) >= (this.localProviders?.revision ?? 0)
			? stored ?? this.localProviders : this.localProviders;
		return structuredClone(providers ?? { profiles: [] });
	}

	saveProvider(profile: ProviderProfile, secret?: string): Promise<void> {
		return this.update(async () => {
			const providers = this.providers;
			const index = providers.profiles.findIndex(value => value.id === profile.id);
			if (index === -1) {
				providers.profiles.push(profile);
			} else {
				providers.profiles[index] = profile;
			}
			providers.defaultId ??= profile.id;
			if (secret !== undefined) {
				if (secret) {
					await this.context.secrets.store(this.secretKey(profile.id), secret);
				} else {
					await this.context.secrets.delete(this.secretKey(profile.id));
				}
			}
			await this.persistProviders(providers);
		});
	}

	private async persistProviders(providers: Providers): Promise<void> {
		providers.revision = Math.max(Date.now(), (providers.revision ?? 0) + 1);
		await this.context.globalState.update('providers', providers);
		this.localProviders = providers;
	}

	secret(id: string): Thenable<string | undefined> {
		return this.context.secrets.get(this.secretKey(id));
	}

	private secretKey(id: string): string {
		return `provider:${id}`;
	}

	setDefault(id: string): Promise<void> {
		return this.update(async () => {
			const providers = this.providers;
			if (!providers.profiles.some(value => value.id === id)) {
				throw new Error('The provider is no longer connected.');
			}
			providers.defaultId = id;
			await this.persistProviders(providers);
		});
	}

	disconnect(id: string): Promise<void> {
		return this.update(async () => {
			const providers = this.providers;
			providers.profiles = providers.profiles.filter(value => value.id !== id);
			if (providers.defaultId === id) {
				providers.defaultId = providers.profiles[0]?.id;
			}
			await this.persistProviders(providers);
			await this.context.secrets.delete(this.secretKey(id));
		});
	}

	get runs(): RunEntry[] {
		return this.localRuns ?? this.context.workspaceState.get<RunEntry[]>('runs') ?? [];
	}

	updateRuns(entry: RunEntry): Promise<void> {
		return this.update(async () => {
			const runs = [entry, ...this.runs].slice(0, 50);
			await this.context.workspaceState.update('runs', runs);
			this.localRuns = runs;
		});
	}

	dispose(): void {
		this.changed.dispose();
	}
}
