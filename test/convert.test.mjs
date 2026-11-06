/**
 * Conversion: the request history a provider actually receives.
 *
 * The failure this file exists to prevent is silent. A tool answer dropped on
 * the way to the wire does not raise, and the model cannot tell a missing result
 * from an empty one — it reports "(no output)" and re-issues the same call, so
 * the symptom surfaces as a looping agent rather than as a broken provider.
 *
 * Two generations of the Harness write tool answers. V4 makes the answer a
 * first-class `tool` message whose content *is* the result; V3 wraps the result
 * in a `tool-result` block, which a relay may hand over on the `tool` message or
 * inside the following `user` turn. Every one of those shapes must reach the
 * wire carrying its text.
 *
 * @module @local/dsh-custom-provider/test/convert
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildChatPayload, toolAnswersOf } from '../src/convert.js';

/** A payload built from one message list, at a fixed ceiling. */
function payload(messages) {
  return buildChatPayload({ messages }, { model: { id: 'test-model' }, maxTokens: 64 });
}

test('a V4 tool answer reaches the wire', async () => {
  const { messages } = await payload([
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ALPHA_7' }] },
  ]);
  assert.deepEqual(messages, [{ role: 'tool', tool_call_id: 'c1', content: 'ALPHA_7' }]);
});

test('a tool answer wrapped in a tool-result block reaches the wire', async () => {
  const { messages } = await payload([
    {
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ALPHA_7' }] }],
    },
  ]);
  assert.deepEqual(messages, [{ role: 'tool', tool_call_id: 'c1', content: 'ALPHA_7' }]);
});

test('a tool-result block inside a user turn becomes its own tool row', async () => {
  const { messages } = await payload([
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ALPHA_7' }] }] },
  ]);
  assert.deepEqual(messages, [{ role: 'tool', tool_call_id: 'c1', content: 'ALPHA_7' }]);
});

test('a result preceeds the follow-up prose of the same turn', async () => {
  const { messages } = await payload([
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ALPHA_7' }] },
        { type: 'text', text: 'and now summarise' },
      ],
    },
  ]);
  assert.deepEqual(messages, [
    { role: 'tool', tool_call_id: 'c1', content: 'ALPHA_7' },
    { role: 'user', content: 'and now summarise' },
  ]);
});

test('a multi-result batch keeps every answer and its own id', async () => {
  const { messages } = await payload([
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'one' }] },
        { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'two' }] },
      ],
    },
  ]);
  assert.deepEqual(messages, [
    { role: 'tool', tool_call_id: 'c1', content: 'one' },
    { role: 'tool', tool_call_id: 'c2', content: 'two' },
  ]);
});

test('an empty answer still answers its call', async () => {
  const { messages } = await payload([
    { role: 'tool', toolCallId: 'c1', content: [] },
  ]);
  assert.deepEqual(messages, [{ role: 'tool', tool_call_id: 'c1', content: '(no output)' }]);
});

test('the assistant turn keeps its calls ahead of the answer', async () => {
  const { messages } = await payload([
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'c1', name: 'get_secret', arguments: '{}' }],
    },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ALPHA_7' }] }] },
  ]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'get_secret', arguments: '{}' } },
  ]);
  assert.deepEqual(messages[1], { role: 'tool', tool_call_id: 'c1', content: 'ALPHA_7' });
});

test('a plain user turn is untouched', async () => {
  const { messages } = await payload([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  assert.deepEqual(messages, [{ role: 'user', content: 'hello' }]);
});

test('toolAnswersOf reads both vocabularies', () => {
  assert.deepEqual(
    toolAnswersOf({ role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'x' }] }),
    [{ callId: 'c1', text: 'x' }],
  );
  assert.deepEqual(
    toolAnswersOf({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'y' }] }] }),
    [{ callId: 'c2', text: 'y' }],
  );
  assert.deepEqual(toolAnswersOf({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), []);
});
