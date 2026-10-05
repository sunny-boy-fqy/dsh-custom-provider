/**
 * Browser half of `@local/dsh-custom-provider`.
 *
 * A lazy CommonJS factory, which is the artifact shape the Harness Client
 * module table loads (`window.__ModuleLoader__.load`). React comes from the
 * platform module table; nothing else is required, and no control is imported
 * from a Harness Client package — the plugin draws its own with the
 * `--dsw-alias-*` theme tokens, so a host restyle can only make it plainer,
 * never blank the slot.
 *
 * The editor registers into `plugins.row.config` under
 * `@local/dsh-custom-provider#custom-provider`, so it appears on
 * 侧栏 → 插件 → this bundle → 该行 → 配置.
 *
 * It edits three levels: the provider (settings plus a shared key library), the
 * **models** the picker offers, and each model's own **candidate** list. Cards
 * collapse, because a realistic configuration is long enough that "which model
 * am I looking at" stops being obvious.
 *
 * @module @local/dsh-custom-provider/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-custom-provider',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dshCustomProvider';
    const API = '/api/custom-provider';

    const zh = {
      title: '自定义供应商',
      summary: '自定义模型，每个模型内部有自己的候选轮询表',
      loading: '正在读取配置…',
      unavailable: '该插件行未挂载或不是易变配置，无法在此编辑。',
      readOnly: '当前部署是只读的。',
      provider: '供应方',
      providerId: '路由 id',
      providerIdHint: '模型请求里记录的 provider 名；改动会在下一次请求生效。',
      displayName: '显示名',
      cooldown: '临时故障冷却（分钟）',
      cooldownHint: '网络错误/超时/5xx/限流后，该候选在此时间内不再尝试，到期自动恢复。',
      idleTimeout: '空闲超时（毫秒）',
      idleTimeoutHint: '每收到一段数据就重新计时；超时按临时故障处理。',
      failoverTransient: '临时故障时轮换到下一个候选',
      failoverAny: '其他错误也轮换（401/403/400 等）',
      failoverAnyHint: '默认关闭：把配置错误直接报出来，而不是被下一段失败掩盖。',
      extraPatterns: '额外“额度用尽”关键字',
      extraPatternsHint: '每行一个，按字面匹配（忽略大小写）。',
      keys: '共享密钥库',
      keysHint: '在这里填一次，多个候选可复用；轮换或改错只需改这一处。',
      addKey: '+ 添加密钥',
      keyN: '密钥',
      keyId: '密钥 id',
      keyName: '名称',
      keyValue: '密钥值',
      keyRef: '凭据引用',
      keyCredential: '凭据',
      models: '自定义模型',
      modelsHint: '这里每一个模型就是模型选择器里的一项；它只在自己的候选之间轮换，不会串到别的模型。',
      addModel: '+ 添加模型',
      modelN: '模型',
      modelId: '模型 id',
      modelIdHint: '模型选择器与历史记录里的标识，例如 ds-free；留空由显示名派生。',
      modelName: '显示名',
      contextWindow: '上下文窗口',
      maxTokens: '默认最大输出',
      inputLabel: '输入类型',
      inputText: '文本',
      inputImage: '图片',
      candidates: '候选轮询表',
      candidatesHint: '从第一个开始顺延；额度用尽/冷却中的候选会被跳过。',
      addCandidate: '+ 添加候选',
      candidateN: '候选',
      candidateId: '候选标识',
      baseURL: '端点地址',
      keySource: '密钥来源',
      keyInline: '内联密钥',
      sharedKeyInUse: '使用共享密钥：',
      apiKey: 'API Key',
      apiKeyHint: '明文保存在 profile 配置里；也可改用共享密钥或凭据引用。',
      credentialRef: '凭据引用',
      credentialRefHint: 'DSH 凭据名（大写字母/数字/下划线），设置了就优先于明文 Key。',
      upstreamModel: '上游模型名',
      capMaxTokens: '输出上限',
      capMaxTokensHint: '该端点自己的上限；留空跟随模型。各中转站上限不同，填上才不会把上游拒绝的值发出去。',
      capContextWindow: '上下文上限',
      capContextWindowHint: '该端点自己的窗口；留空跟随模型。',
      followModel: '跟随模型',
      headers: '附加请求头（JSON）',
      headersInvalid: '请求头不是合法的 JSON 对象，未应用。',
      moreOptions: '请求头',
      enabled: '启用',
      probe: '探测',
      probing: '探测中…',
      reset: '恢复',
      resetAll: '全部恢复',
      statusAvailable: '可用',
      statusQuota: '今日额度用尽',
      statusCooldown: '冷却中',
      statusNone: '未保存',
      usableCount: '可用',
      quotaCount: '额度用尽',
      cooldownCount: '冷却中',
      saved: '已保存。',
      noChanges: '没有变化。',
      saveFailed: '保存被拒绝，配置未改变。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      route: '路由',
      clientHalf: '浏览器半侧',
      routeOk: '已注册',
      routeMissing: '未注册',
      diagnostics: '诊断',
      noDiagnostics: '没有发现问题。',
      moveUp: '上移',
      moveDown: '下移',
      remove: '删除',
      collapse: '折叠',
      expand: '展开',
      collapseAll: '全部折叠',
      expandAll: '全部展开',
      unsaved: '（未保存）',
      failures: '连续失败',
      noModels: '还没有模型：先添加一个模型，再在它内部添加候选。',
      noCandidates: '该模型还没有候选，它在模型选择器里不会出现。',
      rotationTitle: '降级提示',
      noRotation: '还没有发生降级。',
      rotationModelLabel: '模型：',
      rotationFromLabel: '失败候选：',
      rotationToLabel: '降级到：',
      rotationAtLabel: '时间：',
      reasonQuota: '额度用尽',
      reasonTransient: '临时故障',
      reasonFatal: '报错',
    };

    const en = {
      title: 'Custom provider',
      summary: 'Custom models, each with its own candidate rotation',
      loading: 'Loading configuration…',
      unavailable: 'This plugin row is not mounted as a volatile config, so it cannot be edited here.',
      readOnly: 'This deployment is read-only.',
      provider: 'Provider',
      providerId: 'Route id',
      providerIdHint: 'The provider name recorded in model requests; takes effect on the next request.',
      displayName: 'Display name',
      cooldown: 'Transient cooldown (minutes)',
      cooldownHint: 'After a network error, timeout, 5xx or rate limit this candidate is skipped for that long, then retried.',
      idleTimeout: 'Idle timeout (ms)',
      idleTimeoutHint: 'Restarts on every byte received; a stall is treated as a transient failure.',
      failoverTransient: 'Rotate to the next candidate on transient faults',
      failoverAny: 'Also rotate on other errors (401/403/400…)',
      failoverAnyHint: 'Off by default: a configuration error is reported instead of being hidden by the next candidate.',
      extraPatterns: 'Extra “out of quota” phrases',
      extraPatternsHint: 'One per line, matched literally, case-insensitively.',
      keys: 'Shared keys',
      keysHint: 'Fill a key in once and several candidates can reuse it; rotating it is one edit.',
      addKey: '+ Add key',
      keyN: 'Key',
      keyId: 'Key id',
      keyName: 'Name',
      keyValue: 'Value',
      keyRef: 'Credential reference',
      keyCredential: 'credential',
      models: 'Custom models',
      modelsHint: 'Each model here is one entry in the picker, and it rotates only inside its own candidates.',
      addModel: '+ Add model',
      modelN: 'Model',
      modelId: 'Model id',
      modelIdHint: 'The identity the picker and the session log record, e.g. ds-free.',
      modelName: 'Label',
      contextWindow: 'Context window',
      maxTokens: 'Default max output',
      inputLabel: 'Input',
      inputText: 'Text',
      inputImage: 'Image',
      candidates: 'Candidates',
      candidatesHint: 'Walked from the first; out-of-quota and cooling-down candidates are skipped.',
      addCandidate: '+ Add candidate',
      candidateN: 'Candidate',
      candidateId: 'Candidate id',
      baseURL: 'Endpoint',
      keySource: 'Key source',
      keyInline: 'Inline key',
      sharedKeyInUse: 'Using shared key: ',
      apiKey: 'API key',
      apiKeyHint: 'Stored as plain text in the profile config; a shared key or a credential reference is the alternative.',
      credentialRef: 'Credential reference',
      credentialRefHint: 'A DSH credential name (upper-case letters, digits, underscores); wins over the inline key.',
      upstreamModel: 'Upstream model',
      capMaxTokens: 'Output cap',
      capMaxTokensHint: 'This endpoint’s own ceiling; blank follows the model.',
      capContextWindow: 'Context cap',
      capContextWindowHint: 'This endpoint’s own window; blank follows the model.',
      followModel: 'follows model',
      headers: 'Extra headers (JSON)',
      headersInvalid: 'Those headers are not a JSON object; the edit was not applied.',
      moreOptions: 'Headers',
      enabled: 'Enabled',
      probe: 'Probe',
      probing: 'Probing…',
      reset: 'Reset',
      resetAll: 'Reset all',
      statusAvailable: 'Available',
      statusQuota: 'Out of quota today',
      statusCooldown: 'Cooling down',
      statusNone: 'Unsaved',
      usableCount: 'available',
      quotaCount: 'out of quota',
      cooldownCount: 'cooling down',
      saved: 'Saved.',
      noChanges: 'No changes.',
      saveFailed: 'The write was rejected; nothing changed.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      route: 'Route',
      clientHalf: 'Browser half',
      routeOk: 'registered',
      routeMissing: 'not registered',
      diagnostics: 'Diagnostics',
      noDiagnostics: 'Nothing to report.',
      moveUp: 'Up',
      moveDown: 'Down',
      remove: 'Remove',
      collapse: 'Collapse',
      expand: 'Expand',
      collapseAll: 'Collapse all',
      expandAll: 'Expand all',
      unsaved: '(unsaved)',
      failures: 'Consecutive failures',
      noModels: 'No models yet: add one, then add candidates inside it.',
      noCandidates: 'This model has no candidates, so it will not appear in the picker.',
      rotationTitle: 'Degradation notice',
      noRotation: 'No degradation has happened yet.',
      rotationModelLabel: 'Model: ',
      rotationFromLabel: 'Failed candidate: ',
      rotationToLabel: 'Degraded to: ',
      rotationAtLabel: 'At: ',
      reasonQuota: 'out of quota',
      reasonTransient: 'transient failure',
      reasonFatal: 'error',
    };

    const FIELDS = [
      'providerId',
      'displayName',
      'keys',
      'models',
      'cooldownMinutes',
      'idleTimeoutMs',
      'failoverOnTransient',
      'failoverOnAnyError',
      'extraQuotaPatterns',
    ];

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0', color: 'var(--dsw-alias-label-primary)', fontSize: '13px' },
      section: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-1)' },
      row: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' },
      field: { display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 180px', minWidth: '140px' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.5' },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', fontFamily: 'inherit' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      textarea: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', minHeight: '46px', resize: 'vertical' },
      button: { padding: '6px 12px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit' },
      primary: { padding: '6px 14px', fontSize: '13px', color: '#fff', background: 'var(--dsw-alias-brand-primary)', border: '1px solid var(--dsw-alias-brand-primary)', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit' },
      small: { padding: '3px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', background: 'transparent', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit' },
      twisty: { width: '22px', padding: '2px 0', fontSize: '11px', lineHeight: '1', color: 'var(--dsw-alias-label-secondary)', background: 'transparent', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '5px', cursor: 'pointer', fontFamily: 'inherit' },
      modelCard: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-2)' },
      candidateCard: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', background: 'var(--dsw-alias-bg-base)' },
      cardHead: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      grow: { flex: 1 },
      chip: { padding: '2px 8px', borderRadius: '999px', fontSize: '11px', border: '1px solid var(--dsw-alias-border-l2)' },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: '12px' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: '12px' },
      idle: { color: 'var(--dsw-alias-state-idle-primary)', fontSize: '12px' },
      line: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      checkbox: { display: 'inline-flex', gap: '5px', alignItems: 'center', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      subhead: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', display: 'flex', alignItems: 'center', gap: '8px' },
      banner: { display: 'flex', flexDirection: 'column', gap: '3px', padding: '8px 10px', border: '1px solid var(--dsw-alias-state-warn-primary)', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-2)' },
      select: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '13px', textAlign: 'left', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit' },
      optionList: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '2px', padding: '4px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-1)', maxHeight: '180px', overflowY: 'auto' },
      option: { textAlign: 'left', padding: '4px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)', background: 'transparent', border: '1px solid transparent', borderRadius: '4px', cursor: 'pointer', fontFamily: 'inherit' },
      optionActive: { textAlign: 'left', padding: '4px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '4px', cursor: 'pointer', fontFamily: 'inherit' },
      body: { display: 'flex', flexDirection: 'column', gap: '6px' },
    };

    /** A deep enough copy for a JSON-shaped config. */
    function clone(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    /** Pull the editable surface out of the settings value. */
    function pick(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      const picked = {};
      for (const field of FIELDS) picked[field] = clone(source[field]);
      picked.keys = Array.isArray(picked.keys) ? picked.keys : [];
      picked.models = Array.isArray(picked.models) ? picked.models : [];
      for (const model of picked.models) {
        if (!Array.isArray(model.candidates)) model.candidates = [];
      }
      picked.extraQuotaPatterns = Array.isArray(picked.extraQuotaPatterns) ? picked.extraQuotaPatterns : [];
      return picked;
    }

    /** The ordered settings operations that turn `from` into `to`. */
    function diff(from, to) {
      const ops = [];
      for (const field of FIELDS) {
        if (JSON.stringify(from[field] ?? null) === JSON.stringify(to[field] ?? null)) continue;
        ops.push({ op: 'set', path: [field], value: to[field] });
      }
      return ops;
    }

    /** A stable blank shared key. */
    function blankKey() {
      return { id: '', name: '', value: '', credentialRef: '' };
    }

    /** A stable blank model. */
    function blankModel() {
      return {
        id: '',
        name: '',
        contextWindow: 262144,
        maxTokens: 32768,
        input: ['text'],
        candidates: [blankCandidate()],
        enabled: true,
      };
    }

    /** A stable blank candidate. */
    function blankCandidate() {
      return {
        id: '',
        name: '',
        baseURL: '',
        keyId: '',
        apiKey: '',
        credentialRef: '',
        model: '',
        headers: {},
        maxTokens: 0,
        contextWindow: 0,
        enabled: true,
      };
    }

    /** One labelled text field. */
    function Field(props) {
      return h('div', { style: props.style ?? S.field },
        h('label', { style: S.label, htmlFor: props.id }, props.label),
        h('input', {
          id: props.id,
          style: props.mono === true ? { ...S.input, ...S.mono } : S.input,
          type: props.type ?? 'text',
          value: props.value ?? '',
          disabled: props.disabled === true,
          placeholder: props.placeholder ?? '',
          onChange: (event) => props.onChange(event.target.value),
        }),
        props.hint !== undefined ? h('div', { style: S.hint }, props.hint) : null);
    }

    /** One labelled checkbox. */
    function Toggle(props) {
      return h('label', { style: S.checkbox, htmlFor: props.id },
        h('input', {
          id: props.id,
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', null, props.label));
    }

    /** The status chip for one candidate. */
    function StatusChip(props) {
      const status = props.status;
      if (status === undefined || status === null) {
        return h('span', { style: { ...S.chip, ...S.idle } }, props.t('statusNone'));
      }
      if (status.available === true) return h('span', { style: { ...S.chip, ...S.ok } }, props.t('statusAvailable'));
      const label = status.reason === 'quota' ? props.t('statusQuota') : props.t('statusCooldown');
      const detail = status.until !== undefined ? `${label} → ${new Date(status.until).toLocaleTimeString()}` : label;
      return h('span', { style: { ...S.chip, ...S.warn }, title: status.detail ?? '' }, detail);
    }

    /** The whole page for one row. */
    function Editor(props) {
      const t = props.t;
      const form = props.form;
      const state = form === undefined ? undefined : form.state;
      const ready = state !== undefined && state.status === 'ready';
      const writable = ready && state.writable === true;

      const [draft, setDraft] = React.useState(null);
      const [server, setServer] = React.useState(null);
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [probing, setProbing] = React.useState('');
      const [headerError, setHeaderError] = React.useState({});
      /** Which cards are folded away: `model-0`, `cand-0-1`. */
      const [folded, setFolded] = React.useState({});
      /** Which key-source picker is open, by `model.candidate` slot. */
      const [openPicker, setOpenPicker] = React.useState('');

      const refresh = React.useCallback(() => {
        let alive = true;
        fetch(`${API}/state`, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((payload) => {
            if (alive) setServer(payload);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      React.useEffect(() => refresh(), [refresh]);
      React.useEffect(() => {
        if (draft === null && ready) setDraft(pick(state.value));
      }, [draft, ready, state]);

      if (!ready) return h('p', { style: S.hint, role: 'status' }, t('unavailable'));
      if (draft === null) return h('p', { style: S.hint, role: 'status' }, t('loading'));

      const original = pick(state.value);
      const health = {};
      const serverModels = server !== null && Array.isArray(server.models) ? server.models : [];
      for (const model of serverModels) {
        for (const candidate of Array.isArray(model.candidates) ? model.candidates : []) {
          health[`${model.id}/${candidate.id}`] = candidate.status;
        }
      }
      const diagnostics = server !== null && Array.isArray(server.diagnostics) ? server.diagnostics : [];
      const rawRotation = server !== null && server.lastRotation !== undefined ? server.lastRotation : null;
      const rotation = rawRotation === null || rawRotation === undefined
        ? null
        : {
            ...rawRotation,
            reasonLabel: rawRotation.reason === 'quota'
              ? t('reasonQuota')
              : rawRotation.reason === 'transient' ? t('reasonTransient') : t('reasonFatal'),
            when: new Date(rawRotation.at).toLocaleString(),
          };

      // Functional updates throughout: two edits landing in one batch must both
      // survive, so every setter derives from the state it is given.
      const patch = (changes) => setDraft((current) => ({ ...current, ...changes }));
      const patchKey = (index, changes) =>
        setDraft((current) => ({
          ...current,
          keys: current.keys.map((key, position) => (position === index ? { ...key, ...changes } : key)),
        }));
      const patchModel = (index, changes) =>
        setDraft((current) => ({
          ...current,
          models: current.models.map((model, position) => (position === index ? { ...model, ...changes } : model)),
        }));
      const patchCandidate = (modelIndex, candidateIndex, changes) =>
        setDraft((current) => ({
          ...current,
          models: current.models.map((model, position) => {
            if (position !== modelIndex) return model;
            return {
              ...model,
              candidates: model.candidates.map((candidate, slot) =>
                slot === candidateIndex ? { ...candidate, ...changes } : candidate,
              ),
            };
          }),
        }));

      const toggleFold = (id) => setFolded((current) => ({ ...current, [id]: current[id] !== true }));
      const foldAll = (value) => {
        const next = {};
        if (value) {
          draft.models.forEach((model, modelIndex) => {
            next[`model-${modelIndex}`] = true;
            model.candidates.forEach((_candidate, candidateIndex) => {
              next[`cand-${modelIndex}-${candidateIndex}`] = true;
            });
          });
        }
        setFolded(next);
      };

      const moveWithin = (list, index, delta) => {
        const target = index + delta;
        if (target < 0 || target >= list.length) return list;
        const next = [...list];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        return next;
      };
      const addKey = () => setDraft((current) => ({ ...current, keys: [...current.keys, blankKey()] }));
      const removeKey = (index) =>
        setDraft((current) => ({ ...current, keys: current.keys.filter((_key, position) => position !== index) }));
      const moveKey = (index, delta) =>
        setDraft((current) => ({ ...current, keys: moveWithin(current.keys, index, delta) }));
      const addModel = () => setDraft((current) => ({ ...current, models: [...current.models, blankModel()] }));
      const removeModel = (index) =>
        setDraft((current) => ({ ...current, models: current.models.filter((_model, position) => position !== index) }));
      const moveModel = (index, delta) =>
        setDraft((current) => ({ ...current, models: moveWithin(current.models, index, delta) }));
      const addCandidate = (modelIndex) =>
        setDraft((current) => ({
          ...current,
          models: current.models.map((model, position) =>
            position === modelIndex ? { ...model, candidates: [...model.candidates, blankCandidate()] } : model,
          ),
        }));
      const removeCandidate = (modelIndex, candidateIndex) =>
        setDraft((current) => ({
          ...current,
          models: current.models.map((model, position) =>
            position === modelIndex
              ? { ...model, candidates: model.candidates.filter((_candidate, slot) => slot !== candidateIndex) }
              : model,
          ),
        }));
      const moveCandidate = (modelIndex, candidateIndex, delta) =>
        setDraft((current) => ({
          ...current,
          models: current.models.map((model, position) =>
            position === modelIndex
              ? { ...model, candidates: moveWithin(model.candidates, candidateIndex, delta) }
              : model,
          ),
        }));

      const save = async () => {
        const ops = diff(original, draft);
        if (ops.length === 0) {
          setNotice(t('noChanges'));
          return;
        }
        setBusy(true);
        setNotice('');
        let accepted = false;
        try {
          accepted = await form.mutate(ops, state.revision);
        } catch {
          accepted = false;
        }
        setBusy(false);
        setNotice(accepted ? t('saved') : t('saveFailed'));
        if (accepted) refresh();
      };

      const discard = () => {
        setDraft(pick(state.value));
        setNotice('');
        setHeaderError({});
      };

      const runProbe = async (modelId, candidateId, label) => {
        setProbing(`${modelId}/${candidateId}`);
        setNotice('');
        try {
          const response = await fetch(`${API}/probe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: modelId, candidate: candidateId }),
          });
          const payload = await response.json();
          const result = payload.result ?? {};
          setNotice(result.ok === true
            ? `${label}: ${result.status} · ${result.count} 个模型${Array.isArray(result.sample) && result.sample.length > 0 ? ` · ${result.sample.slice(0, 3).join(', ')}` : ''}`
            : `${label}: ${result.status ?? ''} ${result.detail ?? payload.error ?? ''}`);
        } catch (error) {
          setNotice(`${label}: ${String(error)}`);
        }
        setProbing('');
      };

      const runReset = async (key) => {
        try {
          const response = await fetch(`${API}/reset`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(key === undefined ? {} : { key }),
          });
          const payload = await response.json();
          if (payload.state !== undefined) setServer(payload.state);
        } catch {
          // The next poll shows the real state anyway.
        }
      };

      const readHeaders = (modelIndex, candidateIndex, text) => {
        const slot = `${modelIndex}.${candidateIndex}`;
        try {
          const parsed = text.trim().length === 0 ? {} : JSON.parse(text);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          const headers = {};
          for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') headers[key] = value;
          setHeaderError((current) => ({ ...current, [slot]: false }));
          patchCandidate(modelIndex, candidateIndex, { headers });
        } catch {
          setHeaderError((current) => ({ ...current, [slot]: true }));
        }
      };

      const route = server !== null && server.route !== undefined ? server.route : undefined;
      const clientLinked = server !== null && server.client !== undefined ? server.client.linked === true : undefined;
      const routeText = route === undefined
        ? ''
        : `${t('route')}: ${route.id ?? '—'} · ${route.registered === true ? t('routeOk') : t('routeMissing')}${route.error ? ` · ${route.error}` : ''}`;

      /** A number input where zero means "follow the model". */
      const capField = (modelIndex, candidateIndex, candidate, field, label, hint) => h(Field, {
        id: `cc-${modelIndex}-${candidateIndex}-${field}`,
        label,
        hint,
        type: 'number',
        disabled: !writable,
        value: candidate[field] > 0 ? candidate[field] : '',
        placeholder: t('followModel'),
        onChange: (value) => patchCandidate(modelIndex, candidateIndex, { [field]: Number(value) > 0 ? Number(value) : 0 }),
      });

      /** The health summary shown on a folded model card. */
      const summarize = (model) => {
        let usable = 0;
        let quota = 0;
        let cooling = 0;
        for (const candidate of model.candidates) {
          const status = health[`${model.id ?? ''}/${candidate.id ?? ''}`];
          if (status === undefined) continue;
          if (status.available === true) usable += 1;
          else if (status.reason === 'quota') quota += 1;
          else cooling += 1;
        }
        const parts = [`${t('usableCount')} ${usable}`];
        if (quota > 0) parts.push(`${t('quotaCount')} ${quota}`);
        if (cooling > 0) parts.push(`${t('cooldownCount')} ${cooling}`);
        return parts.join(' · ');
      };

      return h('div', { style: S.wrap },

        // ── provider-level settings ────────────────────────────────────────
        h('section', { style: S.section },
          h('div', { style: S.cardHead },
            h('strong', null, t('provider')),
            h('span', { style: S.grow }),
            routeText.length > 0 ? h('span', { style: route !== undefined && route.registered === true ? S.ok : S.error }, routeText) : null,
            clientLinked === undefined
              ? null
              : h('span', { style: clientLinked ? S.ok : S.error }, `${t('clientHalf')}: ${clientLinked ? t('routeOk') : t('routeMissing')}`)),
          h('div', { style: S.row },
            h(Field, {
              id: 'cc-provider-id', label: t('providerId'), hint: t('providerIdHint'), mono: true, disabled: !writable,
              value: draft.providerId ?? '', onChange: (value) => patch({ providerId: value }),
            }),
            h(Field, {
              id: 'cc-display-name', label: t('displayName'), disabled: !writable,
              value: draft.displayName ?? '', onChange: (value) => patch({ displayName: value }),
            }),
            h(Field, {
              id: 'cc-cooldown', label: t('cooldown'), type: 'number', hint: t('cooldownHint'), disabled: !writable,
              value: draft.cooldownMinutes ?? '', onChange: (value) => patch({ cooldownMinutes: Number(value) }),
            }),
            h(Field, {
              id: 'cc-idle', label: t('idleTimeout'), type: 'number', hint: t('idleTimeoutHint'), disabled: !writable,
              value: draft.idleTimeoutMs ?? '', onChange: (value) => patch({ idleTimeoutMs: Number(value) }),
            })),
          h('div', { style: S.row },
            h(Toggle, {
              id: 'cc-failover-transient', label: t('failoverTransient'), checked: draft.failoverOnTransient !== false, disabled: !writable,
              onChange: (checked) => patch({ failoverOnTransient: checked }),
            }),
            h(Toggle, {
              id: 'cc-failover-any', label: t('failoverAny'), checked: draft.failoverOnAnyError === true, disabled: !writable,
              onChange: (checked) => patch({ failoverOnAnyError: checked }),
            })),
          h('div', { style: S.hint }, t('failoverAnyHint')),
          h('div', { style: S.field },
            h('label', { style: S.label, htmlFor: 'cc-extra' }, t('extraPatterns')),
            h('textarea', {
              id: 'cc-extra',
              style: S.textarea,
              disabled: !writable,
              value: (draft.extraQuotaPatterns ?? []).join('\n'),
              onChange: (event) => patch({
                extraQuotaPatterns: event.target.value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
              }),
            }),
            h('div', { style: S.hint }, t('extraPatternsHint')))),

        // ── degradation notice ────────────────────────────────────────────
        h('section', { style: S.section },
          h('strong', null, t('rotationTitle')),
          rotation === null || rotation === undefined
            ? h('div', { id: 'cc-rotation-none', style: S.hint }, t('noRotation'))
            : h('div', { id: 'cc-rotation', style: S.banner },
                h('span', { style: S.warn }, [
                  `${t('rotationModelLabel')}${rotation.modelId}`,
                  `${t('rotationFromLabel')}${rotation.from}`,
                  rotation.reasonLabel,
                  `${t('rotationToLabel')}${rotation.to}`,
                  `${t('rotationAtLabel')}${rotation.when}`,
                ].join(' · ')),
                rotation.detail ? h('span', { style: S.hint }, rotation.detail) : null)),

        // ── shared key library ────────────────────────────────────────────
        h('section', { style: S.section },
          h('div', { style: S.cardHead },
            h('strong', null, t('keys')),
            h('span', { style: S.grow }),
            h('button', { id: 'cc-add-key', type: 'button', style: S.small, disabled: !writable, onClick: addKey }, t('addKey'))),
          h('div', { style: S.hint }, t('keysHint')),
          draft.keys.length === 0 ? null : draft.keys.map((key, keyIndex) => h('div', {
            key: `key-${keyIndex}`,
            style: S.candidateCard,
          },
            h('div', { style: S.cardHead },
              h('span', { style: { ...S.chip, ...S.idle } }, `${t('keyN')} ${keyIndex + 1}`),
              h('span', { style: S.grow }),
              h('button', { id: `cc-key-${keyIndex}-up`, type: 'button', style: S.small, disabled: keyIndex === 0, onClick: () => moveKey(keyIndex, -1) }, t('moveUp')),
              h('button', { id: `cc-key-${keyIndex}-down`, type: 'button', style: S.small, disabled: keyIndex === draft.keys.length - 1, onClick: () => moveKey(keyIndex, 1) }, t('moveDown')),
              h('button', { id: `cc-key-${keyIndex}-remove`, type: 'button', style: S.small, disabled: !writable, onClick: () => removeKey(keyIndex) }, t('remove'))),
            h('div', { style: S.row },
              h(Field, {
                id: `cc-key-${keyIndex}-id`, label: t('keyId'), mono: true, disabled: !writable,
                value: key.id ?? '', placeholder: 'modelscope-1',
                onChange: (value) => patchKey(keyIndex, { id: value }),
              }),
              h(Field, {
                id: `cc-key-${keyIndex}-name`, label: t('keyName'), disabled: !writable,
                value: key.name ?? '', onChange: (value) => patchKey(keyIndex, { name: value }),
              }),
              h(Field, {
                id: `cc-key-${keyIndex}-value`, label: t('keyValue'), mono: true, type: 'password', disabled: !writable,
                value: key.value ?? '', onChange: (value) => patchKey(keyIndex, { value: value }),
              }),
              h(Field, {
                id: `cc-key-${keyIndex}-ref`, label: t('keyRef'), mono: true, disabled: !writable,
                value: key.credentialRef ?? '', onChange: (value) => patchKey(keyIndex, { credentialRef: value }),
              }))))),

        // ── diagnostics ───────────────────────────────────────────────────
        h('section', { style: S.section },
          h('strong', null, t('diagnostics')),
          diagnostics.length === 0
            ? h('div', { style: S.hint }, t('noDiagnostics'))
            : h('ul', { style: { margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' } },
                diagnostics.map((item, index) => h('li', {
                  key: `diag-${index}`,
                  style: item.severity === 'error' ? S.error : S.warn,
                }, `${
                  item.model >= 0 ? `${t('modelN')} ${item.model + 1}` : ''
                }${item.candidate >= 0 && item.model >= 0 ? ` · ${t('candidateN')} ${item.candidate + 1}` : ''}${
                  item.model >= 0 ? '：' : ''
                }${item.field ? `${item.field}: ` : ''}${item.message}`)))),

        // ── models ────────────────────────────────────────────────────────
        h('section', { style: S.section },
          h('div', { style: S.cardHead },
            h('strong', null, t('models')),
            h('span', { style: S.grow }),
            h('button', { id: 'cc-collapse-all', type: 'button', style: S.small, onClick: () => foldAll(true) }, t('collapseAll')),
            h('button', { id: 'cc-expand-all', type: 'button', style: S.small, onClick: () => foldAll(false) }, t('expandAll')),
            h('button', { id: 'cc-add-model', type: 'button', style: S.small, disabled: !writable, onClick: addModel }, t('addModel')),
            h('button', { id: 'cc-reset-all', type: 'button', style: S.small, disabled: !writable, onClick: () => runReset(undefined) }, t('resetAll'))),
          h('div', { style: S.hint }, t('modelsHint')),
          draft.models.length === 0 ? h('div', { style: S.hint }, t('noModels')) : null,

          draft.models.map((model, modelIndex) => {
            const foldedModel = folded[`model-${modelIndex}`] === true;
            return h('div', { key: `model-${modelIndex}`, style: S.modelCard },
              h('div', { style: S.cardHead },
                h('button', {
                  id: `cc-model-${modelIndex}-toggle`, type: 'button', style: S.twisty,
                  title: foldedModel ? t('expand') : t('collapse'),
                  'aria-expanded': foldedModel ? 'false' : 'true',
                  onClick: () => toggleFold(`model-${modelIndex}`),
                }, foldedModel ? '▶' : '▼'),
                h('span', { style: { ...S.chip, ...S.idle } }, `${t('modelN')} ${modelIndex + 1}`),
                model.id ? h('code', { style: { ...S.hint, ...S.mono } }, model.id) : h('span', { style: S.hint }, t('unsaved')),
                model.name ? h('span', { style: S.hint }, model.name) : null,
                h('span', { style: S.hint }, `${model.candidates.length} ${t('candidates')}${foldedModel ? ` · ${summarize(model)}` : ''}`),
                h('span', { style: S.grow }),
                h('button', { id: `cc-model-${modelIndex}-up`, type: 'button', style: S.small, disabled: modelIndex === 0, onClick: () => moveModel(modelIndex, -1) }, t('moveUp')),
                h('button', { id: `cc-model-${modelIndex}-down`, type: 'button', style: S.small, disabled: modelIndex === draft.models.length - 1, onClick: () => moveModel(modelIndex, 1) }, t('moveDown')),
                h('button', { id: `cc-model-${modelIndex}-remove`, type: 'button', style: S.small, disabled: !writable, onClick: () => removeModel(modelIndex) }, t('remove'))),

              foldedModel ? null : h('div', { style: S.body },
                h('div', { style: S.row },
                  h(Field, {
                    id: `cc-model-${modelIndex}-id`, label: t('modelId'), hint: t('modelIdHint'), mono: true, disabled: !writable,
                    value: model.id ?? '', placeholder: 'ds-free',
                    onChange: (value) => patchModel(modelIndex, { id: value }),
                  }),
                  h(Field, {
                    id: `cc-model-${modelIndex}-name`, label: t('modelName'), disabled: !writable,
                    value: model.name ?? '', onChange: (value) => patchModel(modelIndex, { name: value }),
                  }),
                  h(Field, {
                    id: `cc-model-${modelIndex}-ctx`, label: t('contextWindow'), type: 'number', disabled: !writable,
                    value: model.contextWindow ?? '', onChange: (value) => patchModel(modelIndex, { contextWindow: Number(value) }),
                  }),
                  h(Field, {
                    id: `cc-model-${modelIndex}-max`, label: t('maxTokens'), type: 'number', disabled: !writable,
                    value: model.maxTokens ?? '', onChange: (value) => patchModel(modelIndex, { maxTokens: Number(value) }),
                  })),
                h('div', { style: S.line },
                  h(Toggle, {
                    id: `cc-model-${modelIndex}-enabled`, label: t('enabled'), checked: model.enabled !== false, disabled: !writable,
                    onChange: (checked) => patchModel(modelIndex, { enabled: checked }),
                  }),
                  h('span', { style: S.label }, t('inputLabel')),
                  h(Toggle, {
                    id: `cc-model-${modelIndex}-text`, label: t('inputText'), checked: (model.input ?? ['text']).includes('text'), disabled: !writable,
                    onChange: (checked) => {
                      const current = new Set(model.input ?? ['text']);
                      if (checked) current.add('text'); else current.delete('text');
                      if (current.size === 0) current.add('text');
                      patchModel(modelIndex, { input: [...current] });
                    },
                  }),
                  h(Toggle, {
                    id: `cc-model-${modelIndex}-image`, label: t('inputImage'), checked: (model.input ?? ['text']).includes('image'), disabled: !writable,
                    onChange: (checked) => {
                      const current = new Set(model.input ?? ['text']);
                      if (checked) current.add('image'); else current.delete('image');
                      if (current.size === 0) current.add('text');
                      patchModel(modelIndex, { input: [...current] });
                    },
                  })),

                // ── the model's own candidate rotation ───────────────────
                h('div', { style: S.subhead },
                  h('strong', null, t('candidates')),
                  h('span', { style: S.grow }),
                  h('button', { id: `cc-model-${modelIndex}-add-candidate`, type: 'button', style: S.small, disabled: !writable, onClick: () => addCandidate(modelIndex) }, t('addCandidate'))),
                h('div', { style: S.hint }, t('candidatesHint')),
                model.candidates.length === 0 ? h('div', { style: S.error }, t('noCandidates')) : null,

                model.candidates.map((candidate, candidateIndex) => {
                  const key = `${model.id ?? ''}/${candidate.id ?? ''}`;
                  const status = health[key];
                  const slot = `${modelIndex}.${candidateIndex}`;
                  const label = `${model.id || '?'} / ${candidate.id || '?'}`;
                  const foldedCandidate = folded[`cand-${modelIndex}-${candidateIndex}`] === true;
                  const keyId = candidate.keyId ?? '';
                  const shared = keyId.length > 0 && draft.keys.some((entry) => (entry.id ?? '') === keyId);
                  return h('div', { key: `candidate-${modelIndex}-${candidateIndex}`, style: S.candidateCard },
                    h('div', { style: S.cardHead },
                      h('button', {
                        id: `cc-${modelIndex}-${candidateIndex}-toggle`, type: 'button', style: S.twisty,
                        title: foldedCandidate ? t('expand') : t('collapse'),
                        'aria-expanded': foldedCandidate ? 'false' : 'true',
                        onClick: () => toggleFold(`cand-${modelIndex}-${candidateIndex}`),
                      }, foldedCandidate ? '▶' : '▼'),
                      h('span', { style: { ...S.chip, ...S.idle } }, `${t('candidateN')} ${candidateIndex + 1}`),
                      candidate.id ? h('code', { style: { ...S.hint, ...S.mono } }, candidate.id) : h('span', { style: S.hint }, t('unsaved')),
                      h(StatusChip, { t, status }),
                      status !== undefined && status.failures > 0
                        ? h('span', { style: S.hint, title: status.detail ?? '' }, `${t('failures')}: ${status.failures}`)
                        : null,
                      h('span', { style: S.grow }),
                      h('button', { id: `cc-${modelIndex}-${candidateIndex}-up`, type: 'button', style: S.small, disabled: candidateIndex === 0, onClick: () => moveCandidate(modelIndex, candidateIndex, -1) }, t('moveUp')),
                      h('button', { id: `cc-${modelIndex}-${candidateIndex}-down`, type: 'button', style: S.small, disabled: candidateIndex === model.candidates.length - 1, onClick: () => moveCandidate(modelIndex, candidateIndex, 1) }, t('moveDown')),
                      h('button', {
                        id: `cc-${modelIndex}-${candidateIndex}-probe`,
                        type: 'button', style: S.small, disabled: !writable || !candidate.id,
                        onClick: () => runProbe(model.id, candidate.id, label),
                      }, probing === `${model.id}/${candidate.id}` ? t('probing') : t('probe')),
                      h('button', { id: `cc-${modelIndex}-${candidateIndex}-reset`, type: 'button', style: S.small, disabled: !writable || !candidate.id, onClick: () => runReset(key) }, t('reset')),
                      h('button', { id: `cc-${modelIndex}-${candidateIndex}-remove`, type: 'button', style: S.small, disabled: !writable, onClick: () => removeCandidate(modelIndex, candidateIndex) }, t('remove'))),

                    foldedCandidate ? null : h('div', { style: S.body },
                      // Identity, what it calls and where: one dense row, so the
                      // key line below sits next to the endpoint it belongs to
                      // instead of a full-width field away from it.
                      h('div', { style: S.row },
                        h(Field, {
                          id: `cc-${modelIndex}-${candidateIndex}-id`, label: t('candidateId'), mono: true, disabled: !writable,
                          value: candidate.id ?? '', placeholder: 'modelscope1',
                          onChange: (value) => patchCandidate(modelIndex, candidateIndex, { id: value }),
                        }),
                        h(Field, {
                          id: `cc-${modelIndex}-${candidateIndex}-model`, label: t('upstreamModel'), mono: true, disabled: !writable,
                          value: candidate.model ?? '', placeholder: 'deepseek-ai/DeepSeek-V4.1-Flash',
                          onChange: (value) => patchCandidate(modelIndex, candidateIndex, { model: value }),
                        }),
                        h(Field, {
                          id: `cc-${modelIndex}-${candidateIndex}-url`, label: t('baseURL'), mono: true, disabled: !writable,
                          style: { ...S.field, flex: '2 1 260px' },
                          value: candidate.baseURL ?? '', placeholder: 'https://gateway.example/v1',
                          onChange: (value) => patchCandidate(modelIndex, candidateIndex, { baseURL: value }),
                        })),
                      h('div', { style: S.row },
                        // An in-flow picker, not a native <select>: the page lives
                        // inside the host's own scroll container, where a native
                        // popup can be clipped. Options expand the card instead,
                        // so nothing can cover them.
                        h('div', { style: { ...S.field, flex: '1 1 170px' } },
                          h('label', { style: S.label, htmlFor: `cc-${modelIndex}-${candidateIndex}-keyId` }, t('keySource')),
                          h('button', {
                            id: `cc-${modelIndex}-${candidateIndex}-keyId`,
                            type: 'button',
                            style: S.select,
                            disabled: !writable,
                            'aria-expanded': openPicker === slot ? 'true' : 'false',
                            onClick: () => setOpenPicker(openPicker === slot ? '' : slot),
                          }, `${keyId.length > 0 ? keyId : t('keyInline')} ▾`),
                          openPicker === slot
                            ? h('div', { id: `cc-${modelIndex}-${candidateIndex}-keyId-list`, style: S.optionList },
                                [{ value: '', label: t('keyInline') }]
                                  .concat(draft.keys.map((entry, keyIndex) => ({
                                    value: entry.id ?? '',
                                    disabled: (entry.id ?? '').length === 0,
                                    label: `${entry.id || entry.name || `key-${keyIndex + 1}`}${entry.credentialRef ? ` (${t('keyCredential')})` : ''}`,
                                  })))
                                  .map((option, optionIndex) => h('button', {
                                    id: `cc-${modelIndex}-${candidateIndex}-keyId-opt-${optionIndex}`,
                                    key: `opt-${optionIndex}`,
                                    type: 'button',
                                    disabled: option.disabled === true,
                                    style: option.value === keyId ? S.optionActive : S.option,
                                    onClick: () => {
                                      setOpenPicker('');
                                      patchCandidate(modelIndex, candidateIndex, { keyId: option.value });
                                    },
                                  }, option.label)))
                            : null),
                        shared
                          ? h('div', { style: { ...S.field, flex: '2 1 220px' } },
                              h('span', { style: S.label }, t('keySource')),
                              h('span', { id: `cc-${modelIndex}-${candidateIndex}-shared`, style: S.ok }, `${t('sharedKeyInUse')}${keyId}`))
                          : h(Field, {
                              id: `cc-${modelIndex}-${candidateIndex}-key`, label: t('apiKey'), hint: t('apiKeyHint'), mono: true, type: 'password', disabled: !writable,
                              value: candidate.apiKey ?? '', onChange: (value) => patchCandidate(modelIndex, candidateIndex, { apiKey: value }),
                            }),
                        shared ? null : h(Field, {
                          id: `cc-${modelIndex}-${candidateIndex}-ref`, label: t('credentialRef'), hint: t('credentialRefHint'), mono: true, disabled: !writable,
                          value: candidate.credentialRef ?? '', onChange: (value) => patchCandidate(modelIndex, candidateIndex, { credentialRef: value }),
                        })),
                      h('div', { style: S.row },
                        capField(modelIndex, candidateIndex, candidate, 'maxTokens', t('capMaxTokens'), t('capMaxTokensHint')),
                        capField(modelIndex, candidateIndex, candidate, 'contextWindow', t('capContextWindow'), t('capContextWindowHint')),
                        h(Toggle, {
                          id: `cc-${modelIndex}-${candidateIndex}-enabled`, label: t('enabled'), checked: candidate.enabled !== false, disabled: !writable,
                          onChange: (checked) => patchCandidate(modelIndex, candidateIndex, { enabled: checked }),
                        })),
                      h('div', { style: S.field },
                        h('label', { style: S.label, htmlFor: `cc-${modelIndex}-${candidateIndex}-headers` }, t('moreOptions')),
                        h('textarea', {
                          id: `cc-${modelIndex}-${candidateIndex}-headers`,
                          style: S.textarea,
                          disabled: !writable,
                          value: JSON.stringify(candidate.headers ?? {}, null, 2),
                          onChange: (event) => readHeaders(modelIndex, candidateIndex, event.target.value),
                        }),
                        headerError[slot] === true ? h('div', { style: S.error }, t('headersInvalid')) : null)));
                })));
          })),

        // ── actions ───────────────────────────────────────────────────────
        h('div', { style: S.line },
          h('button', { id: 'cc-save', type: 'button', style: S.primary, disabled: !writable || busy, onClick: save }, busy ? t('saving') : t('save')),
          h('button', { id: 'cc-discard', type: 'button', style: S.button, disabled: busy, onClick: discard }, t('discard')),
          notice.length > 0 ? h('span', { style: notice === t('saveFailed') ? S.error : S.hint, role: 'status' }, notice) : null,
          writable ? null : h('span', { style: S.hint }, t('readOnly'))));
    }

    /** Slot entry point: a summary line for the collapsed row, the editor when open. */
    function RowConfig(props) {
      if (props.view === 'summary') return props.t('summary');
      return h(Editor, { t: props.t, form: props.form });
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'custom-provider: dictionaries');
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: '@local/dsh-custom-provider#custom-provider',
          locale: NS,
        }, RowConfig));
      },
    };
  },
});
