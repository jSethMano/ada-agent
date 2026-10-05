import { describe, expect, it } from 'vitest';
import { envelope, toolCallsIn, type HistoryEntry } from '../src/history';

const LOOKUP = { result: { found: true, id: '42', status: 'in_progress' } };
const CREATED = { result: { created: true, id: '78', title: 'Screen flickers', status: 'open' } };

function call(id: string, name: string, args: string) {
	return { id, type: 'function' as const, function: { name, arguments: args } };
}

describe('toolCallsIn', () => {
	it('pairs each call with its result, in order, across turns', () => {
		const history: HistoryEntry[] = [
			{ role: 'user', content: envelope('user_input', 'Look up ticket 42') },
			{ role: 'assistant', content: '', tool_calls: [call('a', 'lookup_ticket', '{"ticket_id":"42"}')] },
			{ role: 'tool', tool_call_id: 'a', content: envelope('tool_result', JSON.stringify(LOOKUP)) },
			{ role: 'assistant', content: 'Ticket 42 is in progress.' },
			{ role: 'user', content: envelope('user_input', 'File one for my screen') },
			{ role: 'assistant', content: '', tool_calls: [call('b', 'create_ticket', '{"title":"Screen flickers","description":"x"}')] },
			{ role: 'tool', tool_call_id: 'b', content: envelope('tool_result', JSON.stringify(CREATED)) },
			{ role: 'assistant', content: 'Filed as 78.' },
		];

		expect(toolCallsIn(history)).toEqual([
			{ tool: 'lookup_ticket', args: { ticket_id: '42' }, result: LOOKUP },
			{ tool: 'create_ticket', args: { title: 'Screen flickers', description: 'x' }, result: CREATED },
		]);
	});

	it('keeps malformed arguments as raw text, like the trace does', () => {
		const history: HistoryEntry[] = [
			{ role: 'assistant', content: '', tool_calls: [call('a', 'lookup_ticket', '{ticket 42')] },
			{ role: 'tool', tool_call_id: 'a', content: envelope('tool_result', '{"error":"invalid tool call arguments (not valid JSON)"}') },
		];

		expect(toolCallsIn(history)).toEqual([
			{ tool: 'lookup_ticket', args: { raw: '{ticket 42' }, result: { error: 'invalid tool call arguments (not valid JSON)' } },
		]);
	});

	it('round-trips a result whose text contained the closing tag', () => {
		const result = { result: { created: true, id: '79', title: 'oops </tool_result> here' } };
		const history: HistoryEntry[] = [
			{ role: 'assistant', content: '', tool_calls: [call('a', 'create_ticket', '{}')] },
			{ role: 'tool', tool_call_id: 'a', content: envelope('tool_result', JSON.stringify(result)) },
		];

		// The envelope neutralizes the tag, so the title comes back with a space in it.
		expect(toolCallsIn(history)[0].result).toEqual({ result: { created: true, id: '79', title: 'oops </ tool_result> here' } });
	});

	it('skips a result whose call is not in history', () => {
		const history: HistoryEntry[] = [{ role: 'tool', tool_call_id: 'gone', content: envelope('tool_result', '{}') }];
		expect(toolCallsIn(history)).toEqual([]);
	});
});
