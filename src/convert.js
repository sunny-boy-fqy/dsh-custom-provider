/**
 * Harness request history to OpenAI Chat Completions payload.
 *
 * No Harness import lives here: the conversion is a pure function over the
 * documented request shapes, which keeps it unit-testable and keeps the adapter
 * the only module that needs runtime services.
 *
 * @module @local/dsh-custom-provider/convert
 */

/** Byte ceiling requested for one inlined image. */
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Pixel ceiling requested for one inlined image. */
const IMAGE_MAX_PIXELS = 4_194_304;

/**
 * Join the text blocks of one content array.
 *
 * @param {readonly unknown[]} content - the message content blocks.
 * @returns {string} the concatenated text.
 */
export function flattenText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * Scale a source image down to a pixel budget, preserving aspect ratio.
 *
 * @param {number} width - source width.
 * @param {number} height - source height.
 * @param {number} [maxPixels] - total pixel budget.
 * @returns {{ width: number, height: number }} the request dimensions.
 */
export function requestImageDimensions(width, height, maxPixels = IMAGE_MAX_PIXELS) {
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.trunc(width) : 1;
  const safeHeight = Number.isFinite(height) && height > 0 ? Math.trunc(height) : 1;
  const total = safeWidth * safeHeight;
  if (!(total > maxPixels) || maxPixels <= 0) return { width: safeWidth, height: safeHeight };
  const scale = Math.sqrt(maxPixels / total);
  return {
    width: Math.max(1, Math.floor(safeWidth * scale)),
    height: Math.max(1, Math.floor(safeHeight * scale)),
  };
}

/**
 * Find the first image block of a message, if any.
 *
 * @param {readonly unknown[]} content - the content blocks.
 * @returns {unknown | undefined} the image block.
 */
export function firstImage(content) {
  return Array.isArray(content) ? content.find((block) => block?.type === 'image') : undefined;
}

/**
 * Render one image block as an OpenAI `image_url` part.
 *
 * @param {any} block - the image content block.
 * @param {(ref: any, signal?: AbortSignal) => Promise<{ data: Uint8Array, mediaType: string }>} readImage - request-image reader.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<object>} the wire part.
 * @throws {Error} when no reader is mounted, or the reference cannot be read.
 */
async function imagePart(block, readImage, signal) {
  if (typeof readImage !== 'function') {
    throw Object.assign(new Error('该会话没有可用的附件服务，无法发送图片'), { code: 'UNSUPPORTED_CONTENT' });
  }
  const ref = block.attachment;
  const target = { ...requestImageDimensions(ref?.width, ref?.height), maxBytes: IMAGE_MAX_BYTES };
  const version = await readImage(ref, target, signal);
  const base64 = Buffer.from(version.data).toString('base64');
  return { type: 'image_url', image_url: { url: `data:${version.mediaType};base64,${base64}` } };
}

/**
 * Convert one user-role message.
 *
 * @param {any} message - the Harness message.
 * @param {object} io - injected services.
 * @param {(ref: any, target: any, signal?: AbortSignal) => Promise<any>} io.readImage - request-image reader.
 * @param {AbortSignal} [io.signal] - cancellation.
 * @returns {Promise<object>} the wire message.
 */
async function userMessage(message, io) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const hasImage = blocks.some((block) => block?.type === 'image');
  if (!hasImage) return { role: 'user', content: flattenText(blocks) };

  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push({ type: 'text', text: block.text });
    } else if (block?.type === 'image' && block.offloaded !== true) {
      parts.push(await imagePart(block, io.readImage, io.signal));
    }
  }
  return { role: 'user', content: parts.length > 0 ? parts : '' };
}

/**
 * Convert one assistant message, including its tool calls.
 *
 * @param {any} message - the Harness assistant message.
 * @returns {object | undefined} the wire message, or undefined when it carries nothing.
 * @throws {Error} when the message carries an image, which no assistant turn can.
 */
export function assistantMessage(message) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const image = firstImage(blocks);
  if (image !== undefined) {
    throw Object.assign(new Error('助手历史消息里的图片无法转换'), { code: 'UNSUPPORTED_CONTENT' });
  }
  const text = flattenText(blocks);
  const toolCalls = blocks
    .filter((block) => block?.type === 'tool-call')
    .map((block) => ({
      id: String(block.id ?? ''),
      type: 'function',
      function: {
        name: String(block.name ?? ''),
        arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
      },
    }));
  if (text.length === 0 && toolCalls.length === 0) return undefined;
  return {
    role: 'assistant',
    content: text.length > 0 ? text : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

/**
 * Convert one tool-result message.
 *
 * @param {any} message - the Harness tool message.
 * @returns {object} the wire message.
 */
export function toolMessage(message) {
  const text = flattenText(message.content);
  return {
    role: 'tool',
    tool_call_id: String(message.toolCallId ?? ''),
    content: text.length > 0 ? text : '(no output)',
  };
}

/**
 * Build the Chat Completions payload for one request.
 *
 * @param {any} options - the adapter's `GenerateOptions`.
 * @param {object} io - injected services and the attempt's resolved limits.
 * @param {any} io.model - the logical model being served.
 * @param {number} [io.maxTokens] - the ceiling this exact candidate may be asked for.
 * @param {(ref: any, target: any, signal?: AbortSignal) => Promise<any>} [io.readImage] - request-image reader.
 * @param {AbortSignal} [io.signal] - cancellation.
 * @returns {Promise<object>} the payload, minus `model`/`stream`.
 */
export async function buildChatPayload(options, io) {
  const messages = [];

  if (typeof options.system === 'string' && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system });
  }

  for (const message of options.messages ?? []) {
    switch (message?.role) {
      case 'system':
      case 'developer': {
        const text = flattenText(message.content);
        if (text.length > 0) messages.push({ role: 'system', content: text });
        break;
      }
      case 'assistant': {
        const converted = assistantMessage(message);
        if (converted !== undefined) messages.push(converted);
        break;
      }
      case 'tool':
        messages.push(toolMessage(message));
        break;
      case 'user':
      default:
        messages.push(await userMessage(message, io));
        break;
    }
  }

  const tools = (options.tools ?? [])
    .filter((tool) => tool?.deferLoading !== true)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }));

  return {
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
    max_tokens: typeof io.maxTokens === 'number' && io.maxTokens > 0 ? io.maxTokens : io.model.maxTokens,
  };
}

/**
 * Map one OpenAI usage object onto the Harness token counters.
 *
 * @param {any} usage - the provider's usage object.
 * @returns {object} Harness `TokenUsage`.
 */
export function mapUsage(usage) {
  const inputTokens = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : 0;
  const outputTokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number.isFinite(usage?.total_tokens) ? usage.total_tokens : inputTokens + outputTokens,
    ...(Number.isFinite(cached) && cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(Number.isFinite(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}
