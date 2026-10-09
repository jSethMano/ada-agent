import { describe, expect, it } from 'vitest';
import { isDroppedConnection, unreachableResult } from '../src/failures';

describe('isDroppedConnection', () => {
	it('retries the dropped connection seen under wrangler dev', () => {
		// The baseline's only 502 (it-printer-paper-jam), from the wrangler log.
		expect(isDroppedConnection(new Error('Network connection lost.'))).toBe(true);
		expect(isDroppedConnection('Error: Network connection lost.')).toBe(true);
	});

	it('never retries a model error or a bad reply', () => {
		for (const message of [
			'AiError: 3040: Capacity temporarily exceeded, please try again.',
			'InferenceUpstreamError: 5007: No such model',
			'AiError: 5006: Invalid input',
			'Unexpected token < in JSON at position 0',
			'',
		]) {
			expect(isDroppedConnection(new Error(message)), message).toBe(false);
		}
		expect(isDroppedConnection(undefined)).toBe(false);
		expect(isDroppedConnection({ message: 'Network connection lost.' })).toBe(false);
	});
});

describe('unreachableResult', () => {
	it('tells the model nothing ran, in the shape each tool reports', () => {
		expect(unreachableResult('create_ticket').result).toMatchObject({ created: false });
		expect(unreachableResult('create_ticket').result.error).toMatch(/^Not filed: the ticket system could not be reached/);
		expect(unreachableResult('lookup_ticket').result).toMatchObject({ found: false });
		expect(unreachableResult('list_my_tickets').result).not.toHaveProperty('found');
		expect(unreachableResult('list_my_tickets').result.error).toContain('could not be reached');
	});
});
