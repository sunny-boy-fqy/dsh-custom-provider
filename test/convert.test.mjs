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
    [{ callId: 'c1', text: 'x', images: [] }],
  );
  assert.deepEqual(
    toolAnswersOf({ role: 'user', content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'y' }] }] }),
    [{ callId: 'c2', text: 'y', images: [] }],
  );
  assert.deepEqual(toolAnswersOf({ role: 'user', content: [{ type: 'text', text: 'hi' }] }), []);
});

/** A stand-in request-image reader that yields a fixed one-pixel PNG. */
const PIXEL = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
));
const reader = async () => ({ data: PIXEL, mediaType: 'image/png' });

test('a picture a tool returned reaches the wire as an image part', async () => {
  const { messages } = await buildChatPayload(
    { messages: [{
      role: 'tool',
      toolCallId: 'c1',
      content: [
        { type: 'text', text: 'image/png image, 320x120 px, 1688 bytes' },
        { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1688, width: 320, height: 120 } },
      ],
    }] },
    { model: { id: 'test-model' }, maxTokens: 64, readImage: reader },
  );
  assert.equal(messages.length, 2);
  // The text row keeps the metadata, and says the pixels are coming.
  assert.equal(messages[0].role, 'tool');
  assert.equal(messages[0].tool_call_id, 'c1');
  // The picture follows as a user turn, which is where an image part can live.
  assert.equal(messages[1].role, 'user');
  const parts = messages[1].content;
  assert.ok(Array.isArray(parts), 'the follow-up carries parts');
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
});

test('an image-only answer still names its call', async () => {
  const { messages } = await buildChatPayload(
    { messages: [{
      role: 'tool',
      toolCallId: 'c1',
      content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 1688, width: 320, height: 120 } }],
    }] },
    { model: { id: 'test-model' }, maxTokens: 64, readImage: reader },
  );
  assert.equal(messages[0].content, '(see attached image)');
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].content.filter((part) => part.type === 'image_url').length, 1);
});

test('a picture stays behind its own tool row in a parallel batch', async () => {
  const { messages } = await buildChatPayload(
    { messages: [{
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'one' }] },
        { type: 'tool-result', toolCallId: 'c2', content: [
          { type: 'text', text: 'two' },
          { type: 'image', attachment: { attachmentId: 'a2', mediaType: 'image/png', bytes: 1688, width: 320, height: 120 } },
        ] },
      ],
    }] },
    { model: { id: 'test-model' }, maxTokens: 64, readImage: reader },
  );
  const roles = messages.map((message) => message.role);
  assert.deepEqual(roles, ['tool', 'tool', 'user']);
  assert.equal(messages[0].tool_call_id, 'c1');
  assert.equal(messages[1].tool_call_id, 'c2');
  assert.match(messages[2].content[0].text, /c2/);
});

test('a text-only tool answer adds no follow-up turn', async () => {
  const { messages } = await buildChatPayload(
    { messages: [{ role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ALPHA_7' }] }] },
    { model: { id: 'test-model' }, maxTokens: 64, readImage: reader },
  );
  assert.deepEqual(messages, [{ role: 'tool', tool_call_id: 'c1', content: 'ALPHA_7' }]);
});
