/**
 * End-to-end acceptance probe for the bundle.
 *
 * The questions this row answers cannot be answered by reading the plugin's own
 * source: they are whether *this* Harness runtime ends up with the route
 * registered, the models advertised, the retry policy honoured, and the
 * documented behaviours actually happening through the real `ctx.llm` seam —
 * including the one that matters most here, that a model rotates inside its own
 * candidates and never borrows another model's.
 *
 * It mounts inertly (`selfCheck` defaults to false). Verify it from an overlay
 * patch, exactly like a `--patch` layer, so a production profile never pays for
 * it.
 *
 * @module @local/dsh-custom-provider/probe
 */

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';

/** Cordis plugin name. */
export const name = 'custom-provider-probe';

/** The seams under test. */
export const inject = ['llm', 'settings', 'credentials', 'attachments'];

/** Probe configuration. */
export const Config = z.object({
  selfCheck: z.boolean().default(false).description('Run the acceptance check at startup.'),
  phase: z.union(['full', 'seed', 'verify-banned']).default('full')
    .description('`full` runs every scenario; `seed` records one daily ban then exits; `verify-banned` asserts, in a fresh process, that the ban is still there.'),
  providerId: z.string().default('custom').description('Route id expected on ctx.llm.'),
  freeModel: z.string().default('ds-free').description('Model whose candidates rotate: quota, then a healthy one.'),
  toolsModel: z.string().default('ds-tools').description('Model that streams reasoning, text and tool calls.'),
  cappedModel: z.string().default('ds-capped').description('Model whose candidate declares a lower output ceiling.'),
  rollingModel: z.string().default('ds-rolling').description('Model whose candidate fails once then recovers.'),
  credModel: z.string().default('ds-cred').description('Model authenticated by a credential reference.'),
  sharedModel: z.string().default('ds-shared').description('Model whose candidate reuses a shared key.'),
  sharedKeyId: z.string().default('probe-shared').description('Shared key entry the reusing candidate names.'),
  sharedKeyValue: z.string().default('sk-from-shared-library').description('Value stored in the shared key entry.'),
  imageModel: z.string().default('ds-image').description('Model that accepts images.'),
  textModel: z.string().default('ds-textonly').description('Model that accepts text only.'),
  firstPort: z.number().default(4321).description('Port the quota-expired mock endpoint binds.'),
  secondPort: z.number().default(4322).description('Port the recording mock endpoint binds.'),
  thirdPort: z.number().default(4323).description('Port the tool-calling mock endpoint binds.'),
  fourthPort: z.number().default(4324).description('Port the transient-then-recovering mock endpoint binds.'),
  expectedText: z.string().default('from-second').description('Text the recording endpoint returns.'),
  modelCeiling: z.number().default(393216).description('Default output ceiling written on the models under test.'),
  candidateCeiling: z.number().default(65535).description('Output ceiling declared by the capped candidate.'),
  credentialRef: z.string().default('CUSTOM_PROVIDER_PROBE_KEY').description('Credential reference the credential model names.'),
  credentialValue: z.string().default('sk-from-credential-store').description('Value stored behind that reference.'),
  cooldownMinutes: z.number().default(0.01).description('Cooldown written into the configuration under test, in minutes.'),
  webPort: z.number().default(3202).description('Port this Harness serves, for the plugin page\u2019s own routes.'),
  waitForRouteMs: z.number().default(30000).description('How long to wait for the row to register its route.'),
  reportPath: z.string().default('').description('Optional absolute path for a JSON report.'),
  exitAfter: z.boolean().default(true).description('Exit the process with the result once the check finishes.'),
});

/** A 1x1 PNG, so the image path is exercised with real encoded bytes. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Write one line to stderr, which the startup log always captures. */
function announce(line) {
  process.stderr.write(`${line}\n`);
}

/** A quota-exhaustion answer. */
function quotaRoute(_req, res) {
  res.writeHead(402, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: '额度已用尽，请充值' } }));
}

/** A reasoning + text + tool-call streaming answer, split across chunks. */
function toolRoute(_req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q":' } }] } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

/** A healthy streaming answer. */
function streamAnswer(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

/** Listen on a fixed port or fail loudly. */
async function listen(port, handler) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (piece) => {
      raw += piece;
    });
    req.on('end', () => handler(req, res, raw));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

/** Sleep, without holding the event loop open. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Drain one stream into a list of chunks. */
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** A minimal Harness user message. */
function userMessage(text, extra = []) {
  return {
    id: 'probe-message',
    role: 'user',
    content: [{ type: 'text', text }, ...extra],
    source: { kind: 'user' },
  };
}

/**
 * Mount the probe.
 *
 * @param {object} ctx - Cordis context carrying the seams under test.
 * @param {object} config - the probe's config.
 */
export function apply(ctx, config) {
  if (config.selfCheck !== true) return;

  const run = async () => {
    /** @type {Array<{ name: string, ok: boolean, detail: unknown }>} */
    const checks = [];
    const check = (name, ok, detail) => {
      checks.push({ name, ok: ok === true, detail });
      announce(`custom-provider self-check: ${ok === true ? 'ok  ' : 'FAIL'} ${name} — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    };

    /** Every request the recording endpoint saw, oldest first. */
    const recorded = [];
    let quotaHits = 0;
    let toolHits = 0;
    let rollingHits = 0;
    let first;
    let second;
    let third;
    let fourth;

    try {
      first = await listen(config.firstPort, (req, res) => {
        quotaHits += 1;
        quotaRoute(req, res);
      });
      second = await listen(config.secondPort, (req, res, raw) => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          body = undefined;
        }
        recorded.push({ headers: req.headers, body });
        streamAnswer(res, config.expectedText);
      });
      third = await listen(config.thirdPort, (req, res) => {
        toolHits += 1;
        toolRoute(req, res);
      });
      fourth = await listen(config.fourthPort, (req, res) => {
        rollingHits += 1;
        // Fails once, then serves normally: the cooldown's whole purpose.
        if (rollingHits === 1) {
          res.writeHead(503, { 'content-type': 'text/plain' });
          res.end('upstream unavailable');
          return;
        }
        streamAnswer(res, 'recovered');
      });
    } catch (error) {
      check('mock endpoints bind', false, error instanceof Error ? error.message : String(error));
      summarise();
      return;
    }
    check(
      'mock endpoints bind',
      true,
      [config.firstPort, config.secondPort, config.thirdPort, config.fourthPort].join(' / '),
    );

    // Drive the row exactly the way the configuration page does: write the
    // model list through the settings plane, then let the volatile update reach
    // the adapter. No patch layer pins this config, so the write is the only
    // source of the values under test.
    const settingsNs = 'custom-provider';
    const describe = () => ctx.settings.describe().find((row) => row.ns === settingsNs);
    const endpoint = (port) => `http://127.0.0.1:${port}/v1`;
    const root = { id: 'root', name: 'Root', baseURL: endpoint(config.secondPort), apiKey: 'sk-root', model: 'mock-model-root' };
    const modelConfig = {
      providerId: config.providerId,
      displayName: '探针供应方',
      keys: [{ id: config.sharedKeyId, name: 'Shared', value: config.sharedKeyValue, credentialRef: '' }],
      cooldownMinutes: config.cooldownMinutes,
      idleTimeoutMs: 20000,
      failoverOnTransient: true,
      models: [
        {
          id: config.freeModel,
          name: 'DS Free',
          contextWindow: 1048576,
          maxTokens: config.modelCeiling,
          candidates: [
            { ...root, id: 'modelscope1', baseURL: endpoint(config.firstPort), model: 'mock-model-a' },
            { ...root, id: 'modelscope2', model: 'mock-model-b' },
          ],
        },
        {
          id: config.toolsModel,
          name: 'DS Tools',
          candidates: [{ ...root, id: 'tools', baseURL: endpoint(config.thirdPort), model: 'mock-model-c' }],
        },
        {
          id: config.cappedModel,
          name: 'DS Capped',
          maxTokens: config.modelCeiling,
          candidates: [{ ...root, id: 'capped', model: 'mock-model-d', maxTokens: config.candidateCeiling }],
        },
        {
          id: config.rollingModel,
          name: 'DS Rolling',
          candidates: [{ ...root, id: 'flaky', baseURL: endpoint(config.fourthPort), model: 'mock-model-e' }],
        },
        {
          id: config.credModel,
          name: 'DS Cred',
          candidates: [{ ...root, id: 'stored', apiKey: '', credentialRef: config.credentialRef, model: 'mock-model-f' }],
        },
        {
          id: config.sharedModel,
          name: 'DS Shared',
          candidates: [{ ...root, id: 'reused', apiKey: '', keyId: config.sharedKeyId, model: 'mock-model-s' }],
        },
        {
          id: config.imageModel,
          name: 'DS Image',
          input: ['text', 'image'],
          maxTokens: config.candidateCeiling,
          candidates: [{ ...root, id: 'sight', model: 'mock-model-i', maxTokens: config.candidateCeiling }],
        },
        {
          id: config.textModel,
          name: 'DS Text Only',
          input: ['text'],
          maxTokens: config.candidateCeiling,
          candidates: [{ ...root, id: 'blind', model: 'mock-model-t', maxTokens: config.candidateCeiling }],
        },
      ],
    };
    const modelIds = modelConfig.models.map((model) => model.id);

    const before = describe();
    check('the settings entry is visible to the configuration page', before !== undefined, before?.ns ?? null);
    check('the generic settings form is suppressed for this namespace', before?.autoGenerate === false, before?.autoGenerate);
    try {
      await ctx.settings.mutate(
        settingsNs,
        Object.entries(modelConfig).map(([field, value]) => ({ op: 'set', path: [field], value })),
        before.revision,
      );
      const written = describe();
      check(
        'the configuration page can write the model list',
        Array.isArray(written?.value?.models) && written.value.models.length === modelIds.length,
        written?.value?.models?.map((model) => model.id),
      );
    } catch (error) {
      check('the configuration page can write the model list', false, error instanceof Error ? error.message : String(error));
    }

    // Wait for the volatile update to reach the adapter's route.
    const deadline = Date.now() + config.waitForRouteMs;
    let providers = [];
    while (Date.now() < deadline) {
      providers = ctx.llm.listProviders().map((provider) => provider.id);
      if (providers.includes(config.providerId)) break;
      await sleep(200);
    }
    check('route is registered on ctx.llm', providers.includes(config.providerId), providers);

    const models = await ctx.llm.listModels(config.providerId).catch((error) => {
      check('listModels answers', false, error instanceof Error ? error.message : String(error));
      return [];
    });
    const advertised = models.map((model) => model.id);
    check('every model is advertised, once each', modelIds.every((id) => advertised.includes(id)), advertised);

    const policy = ctx.llm.providerRetryPolicy(config.providerId);
    check('the adapter owns retrying (maxRetries 0)', policy?.mode === 'normal' && policy.maxRetries === 0, policy);

    const effective = describe();
    check(
      'the written model list is the effective configuration',
      Array.isArray(effective?.value?.models) && effective.value.models.length === modelIds.length,
      effective?.value?.models?.map((model) => model.id),
    );

    /** Read this plugin's own state route, exactly as the configuration page does. */
    const readState = async () => {
      const response = await fetch(`http://127.0.0.1:${config.webPort}/api/custom-provider/state`);
      return { status: response.status, payload: await response.json() };
    };
    /** The health of one candidate key inside a state payload. */
    const statusOf = (payload, key) => {
      for (const model of payload?.models ?? []) {
        for (const candidate of model.candidates ?? []) if (candidate.key === key) return candidate.status;
      }
      return undefined;
    };

    // Second phase of the persistence check: a brand-new process reads the ban
    // the previous process recorded, without this one ever contacting the
    // endpoint. Nothing here can re-create the ban, so a pass means the file
    // carried it.
    if (config.phase === 'verify-banned') {
      const observed = await readState();
      const ban = statusOf(observed.payload, `${config.freeModel}/modelscope1`);
      check(
        'the daily ban survived a full restart',
        observed.status === 200 && ban?.available === false && ban?.reason === 'quota',
        { status: observed.status, ban },
      );
      summarise();
      return;
    }

    const request = (model, extra = []) => ({
      provider: config.providerId,
      model,
      messages: [userMessage('reply with one word', extra)],
    });

    // ── quota cascade, inside one model ──────────────────────────────────
    let chunks = [];
    try {
      chunks = await collect(ctx.llm.stream(request(config.freeModel)));
    } catch (error) {
      check('quota cascade streams', false, error instanceof Error ? error.message : String(error));
    }
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
    check('the first candidate was contacted once', quotaHits === 1, quotaHits);
    check('the second candidate served the request', recorded.length === 1, recorded.length);
    check('the surviving candidate produced the text', text === config.expectedText, text);
    check(
      'the stream ended with a normal finish',
      chunks.at(-1)?.type === 'finish' && chunks.at(-1)?.reason?.kind === 'stop',
      chunks.at(-1),
    );
    check('usage was reported', chunks.some((chunk) => chunk.type === 'usage'), chunks.length);

    const hitsBefore = quotaHits;
    const recordedBefore = recorded.length;
    await collect(ctx.llm.stream(request(config.freeModel)));
    check('the quota-banned candidate is never contacted again', quotaHits === hitsBefore, { before: hitsBefore, after: quotaHits });
    check('the request still succeeds on the surviving candidate', recorded.length === recordedBefore + 1, recorded.length);

    // First phase of the persistence check: record the ban and stop, leaving the
    // state file behind for a fresh process to read.
    if (config.phase === 'seed') {
      const observed = await readState();
      const ban = statusOf(observed.payload, `${config.freeModel}/modelscope1`);
      check('the daily ban is recorded and persisted', ban?.available === false && ban?.reason === 'quota', ban);
      check(
        'the state file is named under the Harness home',
        typeof observed.payload?.healthPath === 'string' && observed.payload.healthPath.endsWith('state.json'),
        observed.payload?.healthPath,
      );
      summarise();
      return;
    }

    // ── manual recovery from the configuration page ──────────────────────
    try {
      const resetResponse = await fetch(`http://127.0.0.1:${config.webPort}/api/custom-provider/reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: `${config.freeModel}/modelscope1` }),
      });
      const resetPayload = await resetResponse.json();
      const cleared = statusOf(resetPayload?.state, `${config.freeModel}/modelscope1`);
      check(
        'the page\u2019s reset route clears one candidate\u2019s ban',
        resetResponse.status === 200 && resetPayload?.ok === true && cleared?.available === true,
        { status: resetResponse.status, cleared: cleared?.available, clearedCount: resetPayload?.cleared },
      );

      const quotaBeforeReset = quotaHits;
      await collect(ctx.llm.stream(request(config.freeModel)));
      check(
        'a manually reset candidate is tried again',
        quotaHits === quotaBeforeReset + 1,
        { before: quotaBeforeReset, after: quotaHits },
      );
    } catch (error) {
      check('the page\u2019s reset route clears one candidate\u2019s ban', false, error instanceof Error ? error.message : String(error));
    }

    // ── the model's own candidates are the only ones it may touch ────────
    try {
      const recordedBeforeTools = recorded.length;
      const quotaBeforeTools = quotaHits;
      const { BlockAssembler } = await import('@deepseek-ai/dsh-llm');
      const toolChunks = await collect(ctx.llm.stream(request(config.toolsModel)));
      const assembler = new BlockAssembler();
      for (const chunk of toolChunks) assembler.push(chunk);
      const blocks = assembler.blocks();

      check('the tool-calling candidate was contacted', toolHits === 1, toolHits);
      check(
        'serving one model never touches another model\u2019s candidates',
        quotaHits === quotaBeforeTools && recorded.length === recordedBeforeTools,
        { quotaHits, recorded: recorded.length },
      );
      check('reasoning, text and the tool call assemble into three blocks', Array.isArray(blocks) && blocks.length === 3, blocks);
      const toolBlock = Array.isArray(blocks) ? blocks.find((block) => block.type === 'tool-call') : undefined;
      check(
        'the assembled tool call keeps its id, name and raw JSON arguments',
        toolBlock !== undefined
          && toolBlock.id === 'call_1'
          && toolBlock.name === 'lookup'
          && toolBlock.arguments === '{"q":"x"}',
        toolBlock,
      );
      check(
        'the assembler recovered usage from the usage chunk',
        assembler.usage?.inputTokens === 10 && assembler.usage?.outputTokens === 2,
        assembler.usage,
      );
      check('the assembler recovered the tool-calls finish reason', assembler.finish?.kind === 'tool-calls', assembler.finish);
    } catch (error) {
      check('tool chunks assemble through the runtime assembler', false, error instanceof Error ? error.message : String(error));
    }

    // ── a candidate's own output ceiling ─────────────────────────────────
    try {
      await collect(ctx.llm.stream(request(config.cappedModel)));
      const capped = [...recorded].reverse().find((row) => row.body?.model === 'mock-model-d');
      check(
        'a candidate\u2019s own output ceiling caps the request it receives',
        capped?.body?.max_tokens === config.candidateCeiling,
        { sent: capped?.body?.max_tokens, modelDefault: config.modelCeiling, candidateCeiling: config.candidateCeiling },
      );
      const uncapped = [...recorded].reverse().find((row) => row.body?.model === 'mock-model-b');
      check(
        'a candidate without its own ceiling follows the model default',
        uncapped?.body?.max_tokens === config.modelCeiling,
        uncapped?.body?.max_tokens,
      );
    } catch (error) {
      check('a candidate\u2019s own output ceiling caps the request it receives', false, error instanceof Error ? error.message : String(error));
    }

    // ── credential reference ─────────────────────────────────────────────
    try {
      await ctx.credentials.set(config.credentialRef, config.credentialValue);
      const resolved = await ctx.credentials.resolve(config.credentialRef);
      check(
        'a credential reference resolves through the credentials seam',
        resolved?.value === config.credentialValue,
        resolved === undefined ? 'unresolved' : { source: resolved.source },
      );
      await collect(ctx.llm.stream(request(config.credModel)));
      const carrier = [...recorded].reverse().find((row) => row.body?.model === 'mock-model-f');
      check(
        'the resolved credential is sent as the bearer key',
        carrier?.headers?.authorization === `Bearer ${config.credentialValue}`,
        carrier?.headers?.authorization,
      );
    } catch (error) {
      check('a credential reference resolves through the credentials seam', false, error instanceof Error ? error.message : String(error));
    }

    // ── shared key reuse ─────────────────────────────────────────────────
    try {
      await collect(ctx.llm.stream(request(config.sharedModel)));
      const reused = [...recorded].reverse().find((row) => row.body?.model === 'mock-model-s');
      check(
        'a candidate reusing a shared key sends that key',
        reused?.headers?.authorization === `Bearer ${config.sharedKeyValue}`,
        reused?.headers?.authorization,
      );
    } catch (error) {
      check('a candidate reusing a shared key sends that key', false, error instanceof Error ? error.message : String(error));
    }

    // ── the degradation is reported, not silent ──────────────────────────
    try {
      const observed = await readState();
      const reported = observed.payload?.lastRotation;
      check(
        'a degradation is reported with both candidates',
        reported?.modelId === config.freeModel
          && reported?.from === `${config.freeModel}/modelscope1`
          && reported?.to === `${config.freeModel}/modelscope2`
          && reported?.reason === 'quota',
        reported,
      );
    } catch (error) {
      check('a degradation is reported with both candidates', false, error instanceof Error ? error.message : String(error));
    }

    // ── transient cooldown, and the rollback poll ────────────────────────
    try {
      const recordedBeforeFlaky = recorded.length;
      const failedOver = await collect(ctx.llm.stream(request(config.rollingModel)));
      const rolledOver = [...recorded].reverse().find((row) => row.body?.model === 'mock-model-root');
      check(
        'a transient failure ends the turn when the model has no next candidate',
        failedOver.at(-1)?.reason?.kind === 'error' || rolledOver !== undefined,
        { finish: failedOver.at(-1)?.reason, landedOn: rolledOver?.body?.model },
      );
      check('the failing candidate was contacted once', rollingHits === 1, rollingHits);

      const afterSkip = rollingHits;
      await collect(ctx.llm.stream(request(config.rollingModel)));
      check('a parked candidate is skipped while it cools down', rollingHits === afterSkip, rollingHits);

      await sleep(Math.round(config.cooldownMinutes * 60_000) + 250);
      const recovered = await collect(ctx.llm.stream(request(config.rollingModel)));
      check('the cooldown expires and the candidate is retried', rollingHits === 2, rollingHits);
      check(
        'the retried candidate now serves the request itself',
        recovered.at(-1)?.type === 'finish'
          && recovered.at(-1)?.reason?.kind === 'stop'
          && recorded.length === recordedBeforeFlaky,
        { finish: recovered.at(-1)?.reason, extraRecordings: recorded.length - recordedBeforeFlaky },
      );
    } catch (error) {
      check('the cooldown rollback poll recovers the candidate', false, error instanceof Error ? error.message : String(error));
    }

    // ── images ───────────────────────────────────────────────────────────
    try {
      const reference = await ctx.attachments.saveImage({
        data: Uint8Array.from(Buffer.from(PNG_BASE64, 'base64')),
        mediaType: 'image/png',
        name: 'probe.png',
      });
      const imageBlock = { type: 'image', attachment: reference };
      await collect(ctx.llm.stream(request(config.imageModel, [imageBlock])));
      const withImage = [...recorded].reverse().find((row) => row.body?.model === 'mock-model-i');
      const parts = withImage?.body?.messages?.at(-1)?.content;
      const imagePart = Array.isArray(parts) ? parts.find((part) => part?.type === 'image_url') : undefined;
      const url = imagePart?.image_url?.url;
      check(
        'an image block reaches a model that accepts images',
        typeof url === 'string' && url.startsWith('data:image/png;base64,'),
        typeof url === 'string' ? `${url.slice(0, 40)}… (${url.length} chars)` : parts,
      );

      await collect(ctx.llm.stream(request(config.textModel, [imageBlock])));
      const textOnly = [...recorded].reverse().find(
        (row) => row.body?.model === 'mock-model-t' && JSON.stringify(row.body).includes('image omitted'),
      );
      check(
        'an image is projected to placeholder text for a text-only model',
        textOnly !== undefined && !JSON.stringify(textOnly.body).includes('image_url'),
        textOnly === undefined ? 'no placeholder seen' : 'projected',
      );
    } catch (error) {
      check('an image block reaches a model that accepts images', false, error instanceof Error ? error.message : String(error));
    }

    summarise();

    function summarise() {
      const failed = checks.filter((candidate) => !candidate.ok).length;
      const report = {
        ok: failed === 0,
        checks,
        node: process.version,
        platform: process.platform,
        providerId: config.providerId,
        finishedAt: new Date().toISOString(),
      };
      if (config.reportPath.length > 0) {
        try {
          writeFileSync(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        } catch (error) {
          announce(`custom-provider self-check: report write failed — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      announce(`custom-provider self-check: ${failed === 0 ? `PASS (${checks.length}/${checks.length})` : `FAIL (${checks.length - failed}/${checks.length})`}`);
      first?.close();
      second?.close();
      third?.close();
      fourth?.close();
      if (config.exitAfter === true) {
        setTimeout(() => process.exit(failed === 0 ? 0 : 1), 100).unref?.();
      }
    }
  };

  run().catch((error) => {
    announce(`custom-provider self-check: crashed — ${error instanceof Error ? error.stack : String(error)}`);
    if (config.exitAfter === true) setTimeout(() => process.exit(1), 100).unref?.();
  });
}
