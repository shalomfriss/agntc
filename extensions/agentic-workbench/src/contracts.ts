// Typed artifacts and their contracts. Artifacts are the structured results that steps
// produce and pass to one another. Each artifact type carries a JSON Schema (a small,
// dependency-free subset) used to validate payloads before they flow downstream.

export interface JsonSchema {
	type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	minItems?: number;
	description?: string;
}

export interface ArtifactType {
	id: string;
	name: string;
	description: string;
	/** A freeform type carries a plain string instead of a JSON payload. */
	freeform?: boolean;
	schema?: JsonSchema;
}

const changeSetSchema: JsonSchema = {
	type: 'object',
	required: ['baseRevision', 'files', 'summary'],
	properties: {
		baseRevision: { type: 'string', description: 'Revision the change is based on.' },
		headRevision: { type: 'string', description: 'Resulting commit or patch id, if any.' },
		files: { type: 'array', items: { type: 'string' }, description: 'Changed file paths.' },
		summary: { type: 'string', description: 'What changed and why.' },
	},
};

export const artifactTypes: Record<string, ArtifactType> = {
	Text: { id: 'Text', name: 'Text', description: 'Freeform text output.', freeform: true },
	FeatureSpec: {
		id: 'FeatureSpec', name: 'Feature spec', description: 'A specification with acceptance criteria.',
		schema: {
			type: 'object',
			required: ['goal', 'acceptanceCriteria'],
			properties: {
				goal: { type: 'string' },
				acceptanceCriteria: { type: 'array', minItems: 1, items: { type: 'string' } },
				constraints: { type: 'array', items: { type: 'string' } },
				boundaries: { type: 'array', items: { type: 'string' } },
			},
		},
	},
	ChangeSet: { id: 'ChangeSet', name: 'Change set', description: 'A revision-referenced set of edits.', schema: changeSetSchema },
	TestReport: {
		id: 'TestReport', name: 'Test report', description: 'The outcome of running checks on a candidate.',
		schema: {
			type: 'object',
			required: ['passed', 'total'],
			properties: {
				candidateRevision: { type: 'string' },
				passed: { type: 'boolean' },
				total: { type: 'integer' },
				failures: { type: 'array', items: { type: 'string' } },
			},
		},
	},
	ReviewReport: {
		id: 'ReviewReport', name: 'Review report', description: 'An independent review of a candidate.',
		schema: {
			type: 'object',
			required: ['verdict', 'reason'],
			properties: {
				candidateRevision: { type: 'string' },
				verdict: { type: 'string', enum: ['approve', 'revise'] },
				reason: { type: 'string' },
				findings: { type: 'array', items: { type: 'string' } },
			},
		},
	},
	GateResult: {
		id: 'GateResult', name: 'Gate result', description: 'The outcome of a quality gate.',
		schema: {
			type: 'object',
			required: ['passed', 'reasons'],
			properties: {
				passed: { type: 'boolean' },
				reasons: { type: 'array', items: { type: 'string' } },
			},
		},
	},
};

export function artifactType(id: string | undefined): ArtifactType {
	return (id && artifactTypes[id]) || artifactTypes.Text;
}

function typeOf(value: unknown): string {
	if (Array.isArray(value)) {
		return 'array';
	}
	if (value === null) {
		return 'null';
	}
	return typeof value;
}

/** Validates a parsed value against a JSON Schema subset, returning human-readable errors. */
export function validate(schema: JsonSchema, value: unknown, path = '$'): string[] {
	const errors: string[] = [];
	if (schema.enum && !schema.enum.some(option => option === value)) {
		errors.push(`${path} must be one of ${schema.enum.map(option => JSON.stringify(option)).join(', ')}.`);
	}
	if (schema.type) {
		const actual = typeOf(value);
		const ok = schema.type === 'integer'
			? actual === 'number' && Number.isInteger(value)
			: actual === schema.type;
		if (!ok) {
			errors.push(`${path} must be a ${schema.type}, got ${actual}.`);
			return errors;
		}
	}
	if (schema.type === 'object' && typeOf(value) === 'object') {
		const record = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in record)) {
				errors.push(`${path}.${key} is required.`);
			}
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			if (key in record) {
				errors.push(...validate(child, record[key], `${path}.${key}`));
			}
		}
	}
	if (schema.type === 'array' && Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) {
			errors.push(`${path} must have at least ${schema.minItems} item(s).`);
		}
		if (schema.items) {
			value.forEach((item, index) => errors.push(...validate(schema.items!, item, `${path}[${index}]`)));
		}
	}
	return errors;
}

export interface ArtifactCheck {
	valid: boolean;
	errors: string[];
	value?: unknown;
}

/** Parses and validates text as an artifact of the given type. Freeform types always pass. */
export function checkArtifact(typeId: string | undefined, text: string): ArtifactCheck {
	const type = artifactType(typeId);
	if (type.freeform || !type.schema) {
		return { valid: true, errors: [], value: text };
	}
	let value: unknown;
	try {
		const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
		value = JSON.parse(fenced ? fenced[1] : text);
	} catch {
		return { valid: false, errors: [`Expected a JSON ${type.name} payload.`] };
	}
	const errors = validate(type.schema, value);
	return { valid: errors.length === 0, errors, value };
}

/** A compact description of a contract for inclusion in an agent's instructions. */
export function contractInstruction(typeId: string | undefined): string | undefined {
	const type = artifactType(typeId);
	if (type.freeform || !type.schema) {
		return undefined;
	}
	return [
		`Your output string must be a single JSON ${type.name} that validates against this schema:`,
		JSON.stringify(type.schema),
		'Return the JSON as the value of "output". Do not add prose outside it.',
	].join('\n');
}
