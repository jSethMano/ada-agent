import type { OpenAIToolCall } from './history';

// Llama 4 Scout sometimes writes a tool call into its reply as text, e.g.
// `[create_ticket(title="...", description="...")]`, instead of returning it
// through the structured tool-call interface. The router only acts on
// structured calls, so that reply used to go out as the final answer with
// nothing done: every run of "Check ticket 42, and if it is not resolved open
// a follow-up" failed this way at the second step. Asking the model again did
// not help (4 of 4 wrote it as text again), and Workers AI offers no
// tool_choice for this model to force a call, so the router reads the call it
// meant out of the text instead.

/**
 * The first tool call written as text in `reply`, as a structured call the
 * router can run like any other, or null. Two forms are recognized:
 *
 *   create_ticket(title="...", description="...")      keyword arguments
 *   {"name": "create_ticket", "parameters": {...}}       JSON
 *
 * Parsing is strict. Anything else, including a tool name mentioned in prose
 * or `create_ticket(title, description)` with no values, is not a call.
 */
export function textToolCall(reply: string, toolNames: readonly string[], id: string): OpenAIToolCall | null {
	const names = toolNames.join('|');

	const keyword = new RegExp(`\\b(${names})\\s*\\(`).exec(reply);
	if (keyword) {
		const args = parseKeywordArgs(reply, keyword.index + keyword[0].length);
		if (args) return toCall(id, keyword[1], args);
	}

	const json = new RegExp(`"name"\\s*:\\s*"(${names})"`).exec(reply);
	if (json) {
		const args = parseJsonCall(reply, json.index);
		if (args) return toCall(id, json[1], args);
	}

	return null;
}

function toCall(id: string, name: string, args: Record<string, unknown>): OpenAIToolCall {
	return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const KEY = /\s*(\w+)\s*=\s*/y;
const BARE = /[^,)\s]+/y;
const NUMBER = /^-?\d+(\.\d+)?$/;

// `key="value", key='value', key=42)` starting just after the `(`. Null unless
// the whole list parses and closes.
function parseKeywordArgs(text: string, start: number): Record<string, unknown> | null {
	const args: Record<string, unknown> = {};
	let at = start;
	const skipSpace = () => {
		while (at < text.length && /\s/.test(text[at])) at++;
	};

	skipSpace();
	if (text[at] === ')') return args;

	while (at < text.length) {
		KEY.lastIndex = at;
		const key = KEY.exec(text);
		if (!key) return null;
		at = KEY.lastIndex;

		const quote = text[at];
		if (quote === '"' || quote === "'") {
			const end = closingQuote(text, at);
			if (end === -1) return null;
			args[key[1]] = unquote(text.slice(at, end + 1), quote);
			at = end + 1;
		} else {
			BARE.lastIndex = at;
			const bare = BARE.exec(text);
			if (!bare) return null;
			args[key[1]] = NUMBER.test(bare[0]) ? Number(bare[0]) : bare[0];
			at = BARE.lastIndex;
		}

		skipSpace();
		if (text[at] === ')') return args;
		if (text[at] !== ',') return null;
		at++;
	}
	return null;
}

function closingQuote(text: string, open: number): number {
	for (let at = open + 1; at < text.length; at++) {
		if (text[at] === '\\') at++;
		else if (text[at] === text[open]) return at;
	}
	return -1;
}

function unquote(literal: string, quote: string): string {
	if (quote === '"') {
		try {
			return JSON.parse(literal) as string;
		} catch {
			// Not a valid JSON escape sequence; fall through to the plain unescape.
		}
	}
	return literal.slice(1, -1).replace(/\\(.)/g, '$1');
}

// The JSON object around `"name": "<tool>"`: its `parameters` or `arguments`,
// as an object or a JSON string of one.
function parseJsonCall(text: string, nameAt: number): Record<string, unknown> | null {
	const open = text.lastIndexOf('{', nameAt);
	if (open === -1) return null;

	let depth = 0;
	for (let at = open; at < text.length; at++) {
		const char = text[at];
		if (char === '"') {
			at = closingQuote(text, at);
			if (at === -1) return null;
		} else if (char === '{') {
			depth++;
		} else if (char === '}' && --depth === 0) {
			try {
				const call = JSON.parse(text.slice(open, at + 1)) as Record<string, unknown>;
				const raw = call.parameters ?? call.arguments ?? {};
				const args = typeof raw === 'string' ? JSON.parse(raw) : raw;
				return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : null;
			} catch {
				return null;
			}
		}
	}
	return null;
}
