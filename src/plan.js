/**
 * Attempt planning: which candidates may this request try, and in what order?
 *
 * Planning happens **inside one logical model**. A request names `ds-free`, and
 * the only candidates it may ever touch are `ds-free`'s own — walking them in
 * the operator's order. Another model's candidates are a different promise to
 * the caller and are never borrowed: a failure that exhausted `ds-free` must
 * surface as `ds-free` failing, not as a silent answer from some other model the
 * caller never asked for.
 *
 * Planning is a pure function so the whole cascade — including which candidates
 * were skipped and why — is testable without a socket in sight.
 *
 * @module @local/dsh-custom-provider/plan
 */

/**
 * @typedef {import('./normalize.js').NormalizedCandidate} NormalizedCandidate
 * @typedef {import('./normalize.js').NormalizedModel} NormalizedModel
 * @typedef {import('./health.js').EntryStatus} EntryStatus
 */

/**
 * @typedef {object} AttemptPlan
 * @property {NormalizedCandidate[]} attempts - candidates to try, in order.
 * @property {Array<{ candidate: NormalizedCandidate, reason: 'quota' | 'cooldown' }>} skipped - candidates health refused.
 * @property {string} [failure] - set when no attempt is possible at all.
 */

/**
 * Build the attempt list for one request against one model.
 *
 * @param {NormalizedModel} model - the model the caller named.
 * @param {(candidate: NormalizedCandidate) => EntryStatus} statusOf - health lookup for one candidate.
 * @returns {AttemptPlan} the plan.
 */
export function planAttempts(model, statusOf) {
  /** @type {NormalizedCandidate[]} */
  const attempts = [];
  /** @type {Array<{ candidate: NormalizedCandidate, reason: 'quota' | 'cooldown' }>} */
  const skipped = [];

  for (const candidate of model.usableCandidates) {
    const status = statusOf(candidate);
    if (status.available) attempts.push(candidate);
    else skipped.push({ candidate, reason: status.reason === 'quota' ? 'quota' : 'cooldown' });
  }

  if (attempts.length === 0) {
    return {
      attempts,
      skipped,
      failure: `模型 "${model.id}" 的候选都不可用（额度用尽或冷却中），共跳过 ${skipped.length} 个`,
    };
  }
  return { attempts, skipped };
}

/**
 * Describe a plan in one line, for the failure message and the log.
 *
 * @param {AttemptPlan} plan - the plan.
 * @returns {string} a short human-readable summary.
 */
export function describePlan(plan) {
  const tried = plan.attempts.map((candidate) => candidate.id).join(' → ');
  const skipped = plan.skipped.length > 0
    ? `；跳过 ${plan.skipped
        .map((item) => `${item.candidate.id}(${item.reason === 'quota' ? '额度用尽' : '冷却中'})`)
        .join('、')}`
    : '';
  return `${tried}${skipped}`;
}
