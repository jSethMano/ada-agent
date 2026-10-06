import { describe, expect, it } from 'vitest';
import { textToolCall } from '../src/text-tool-call';

const TOOLS = ['lookup_ticket', 'create_ticket'];

function argsOf(reply: string) {
	const call = textToolCall(reply, TOOLS, 'text-call-1');
	return call ? { name: call.function.name, args: JSON.parse(call.function.arguments) } : null;
}

describe('textToolCall', () => {
	it('reads the bracketed call Scout writes into a structured one', () => {
		// A real reply to "Check ticket 42, and if it is not resolved open a follow-up".
		const reply =
			'Ticket 42 is currently "in progress" and assigned to sam@company.com. Since it is not resolved, I will create a follow-up ticket.\n\n' +
			'[create_ticket(title="Follow-up: VPN keeps disconnecting", description="Following up on ticket 42, VPN keeps disconnecting")]';
		expect(textToolCall(reply, TOOLS, 'text-call-1')).toEqual({
			id: 'text-call-1',
			type: 'function',
			function: {
				name: 'create_ticket',
				arguments: JSON.stringify({ title: 'Follow-up: VPN keeps disconnecting', description: 'Following up on ticket 42, VPN keeps disconnecting' }),
			},
		});
	});

	it('handles single quotes, escapes, commas inside values, and bare numbers', () => {
		expect(argsOf(`create_ticket(title='Can\\'t print', description="Says \\"offline\\", then stops")`)).toEqual({
			name: 'create_ticket',
			args: { title: "Can't print", description: 'Says "offline", then stops' },
		});
		expect(argsOf('lookup_ticket(ticket_id=42)')).toEqual({ name: 'lookup_ticket', args: { ticket_id: 42 } });
		expect(argsOf('lookup_ticket( ticket_id = "42" )')).toEqual({ name: 'lookup_ticket', args: { ticket_id: '42' } });
	});

	it('reads the JSON form, with parameters as an object or a string', () => {
		expect(argsOf('{"type": "function", "name": "create_ticket", "parameters": {"title": "Wi-Fi drops", "description": "x"}}')).toEqual({
			name: 'create_ticket',
			args: { title: 'Wi-Fi drops', description: 'x' },
		});
		expect(argsOf('{"name": "lookup_ticket", "arguments": "{\\"ticket_id\\": \\"77\\"}"}')).toEqual({
			name: 'lookup_ticket',
			args: { ticket_id: '77' },
		});
	});

	it('takes the first call when there are several', () => {
		expect(argsOf('lookup_ticket(ticket_id="42") then create_ticket(title="x", description="y")')?.name).toBe('lookup_ticket');
	});

	it('is not fooled by prose or by a call with no values', () => {
		expect(argsOf('I have two tools: lookup_ticket and create_ticket.')).toBeNull();
		expect(argsOf('I would call create_ticket(title, description) for that.')).toBeNull();
		expect(argsOf('Ticket 42 is in progress, assigned to sam@company.com.')).toBeNull();
		// Not a tool name, even though it contains one.
		expect(argsOf('recreate_ticket(title="x")')).toBeNull();
	});

	it('gives up on a call that never closes', () => {
		expect(argsOf('create_ticket(title="Screen flickers", description="cut off')).toBeNull();
		expect(argsOf('{"name": "create_ticket", "parameters": {"title": "x"')).toBeNull();
	});
});
