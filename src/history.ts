// The conversation history Chak stores in its Durable Object, in the message
// shape the model takes. The router writes it; the answer check reads the tool
// calls back out of it.

export type OpenAIToolCall = {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
};

export type HistoryEntry =
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string; tool_calls?: OpenAIToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };

// A tool call as recorded in history: the call paired with the result it got.
export type RecordedToolCall = { tool: string; args: unknown; result: unknown };

// Wrap untrusted content in a labeled envelope so the model can distinguish
// data from instructions. Neutralizes any embedded closing tag in the payload
// so a caller can't break out of the envelope.
export function envelope(tag: string, content: string): string {
	const safe = content.replaceAll(`</${tag}>`, `</ ${tag}>`);
	return `<${tag}>\n${safe}\n</${tag}>`;
}

// The inverse of envelope() for JSON payloads. Anything that does not parse
// comes back as the text it was.
function openEnvelope(tag: string, content: string): unknown {
	const open = `<${tag}>\n`;
	const close = `\n</${tag}>`;
	const inner = content.startsWith(open) && content.endsWith(close) ? content.slice(open.length, -close.length) : content;
	try {
		return JSON.parse(inner);
	} catch {
		return inner;
	}
}

function parseArguments(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return { raw };
	}
}

// Trim history from the front, but only cut at a `user` boundary so we never
// orphan a `tool` response from its preceding assistant `tool_calls` (many
// LLM APIs reject that shape).
export function trimHistory(history: HistoryEntry[], maxEntries: number): HistoryEntry[] {
	if (history.length <= maxEntries) return history;
	let start = history.length - maxEntries;
	while (start < history.length && history[start].role !== 'user') {
		start++;
	}
	return history.slice(start);
}

/**
 * Every tool call in `history` with its result, in the order they ran. History
 * keeps the name and arguments on the assistant entry and the result on a
 * later tool entry, joined by tool_call_id. A result whose call is missing is
 * skipped; trimHistory never cuts between the two.
 */
export function toolCallsIn(history: HistoryEntry[]): RecordedToolCall[] {
	const calls = new Map<string, OpenAIToolCall>();
	const recorded: RecordedToolCall[] = [];
	for (const entry of history) {
		if (entry.role === 'assistant') {
			for (const call of entry.tool_calls ?? []) calls.set(call.id, call);
		} else if (entry.role === 'tool') {
			const call = calls.get(entry.tool_call_id);
			if (!call) continue;
			recorded.push({
				tool: call.function.name,
				args: parseArguments(call.function.arguments),
				result: openEnvelope('tool_result', entry.content),
			});
		}
	}
	return recorded;
}
