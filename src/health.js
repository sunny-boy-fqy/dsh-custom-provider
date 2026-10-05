/**
 * Durable health for every candidate entry.
 *
 * Two independent clocks decide whether an entry may be tried:
 *
 * - **Quota day-ban.** A quota-exhaustion failure retires the entry for the
 *   rest of the *local* calendar day. The stored fact is the local date itself
 *   (`2026-10-01`), not an expiry instant, so the entry revives at local
 *   midnight without anything having to run at midnight, and a clock change or
 *   a sleep/resume cannot leave a stale expiry behind.
 * - **Transient cooldown.** A network error, timeout, 5xx, rate limit or
 *   interrupted stream parks the entry for a few minutes. The stored fact is an
 *   expiry instant; when it passes the entry is tried again, and a success
 *   clears it.
 *
 * The state lives in one JSON file so the configuration page can show it and a
 * restart does not resurrect an entry the provider already refused to serve.
 *
 * @module @local/dsh-custom-provider/health
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Current on-disk shape version. */
export const STATE_VERSION = 1;

/**
 * @typedef {object} EntryHealth
 * @property {string} [quotaDate] - local `YYYY-MM-DD` on which the entry ran out of quota.
 * @property {number} [cooldownUntil] - epoch ms until which the entry is parked.
 * @property {string} [detail] - last failure message, for the configuration page.
 * @property {string} [code] - last failure code.
 * @property {number} [lastFailureAt] - epoch ms of the last recorded failure.
 * @property {number} [lastSuccessAt] - epoch ms of the last recorded success.
 * @property {number} failures - consecutive failures since the last success.
 */

/**
 * @typedef {object} EntryStatus
 * @property {string} key - entry id.
 * @property {boolean} available - may this entry be attempted right now?
 * @property {'quota' | 'cooldown' | null} reason - why it is unavailable.
 * @property {number} [until] - epoch ms at which a cooldown lifts.
 * @property {string} [detail] - last failure message.
 * @property {string} [code] - last failure code.
 * @property {number} failures - consecutive failures since the last success.
 * @property {number} [lastFailureAt] - epoch ms of the last recorded failure.
 * @property {number} [lastSuccessAt] - epoch ms of the last recorded success.
 */

/**
 * Local calendar day of an instant, as `YYYY-MM-DD`.
 *
 * Uses the host process's local time zone, which is the operator's time zone:
 * the ban must lift at *their* midnight, not at UTC midnight.
 *
 * @param {number} ms - epoch milliseconds.
 * @returns {string} the local date key.
 */
export function localDateKey(ms) {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Default state file location.
 *
 * `$DSH_HOME` when the Harness sets it (it always does for a real profile),
 * otherwise `~/.dsh` so a standalone test run still lands somewhere sane.
 *
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute path of the state file.
 */
export function defaultStatePath(env = process.env) {
  const home = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, 'llm-custom-provider', 'state.json');
}

/** An empty, valid state document. */
function emptyState() {
  return {
    version: STATE_VERSION,
    entries: /** @type {Record<string, EntryHealth>} */ ({}),
    lastRotation: /** @type {RotationRecord | undefined} */ (undefined),
  };
}

/**
 * @typedef {object} RotationRecord
 * @property {string} modelId - the model that degraded.
 * @property {string} from - the candidate that failed.
 * @property {string} to - the candidate that served the request instead.
 * @property {'quota' | 'transient' | 'fatal'} reason - the classification.
 * @property {string} code - the stable failure code.
 * @property {string} detail - the failure message.
 * @property {number} at - epoch ms.
 */

/** Coerce one persisted entry, dropping anything that is not a plain record. */
function readEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  /** @type {EntryHealth} */
  const entry = { failures: Number.isFinite(value.failures) ? Math.max(0, Math.trunc(value.failures)) : 0 };
  if (typeof value.quotaDate === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value.quotaDate)) entry.quotaDate = value.quotaDate;
  if (Number.isFinite(value.cooldownUntil)) entry.cooldownUntil = value.cooldownUntil;
  if (typeof value.detail === 'string') entry.detail = value.detail;
  if (typeof value.code === 'string') entry.code = value.code;
  if (Number.isFinite(value.lastFailureAt)) entry.lastFailureAt = value.lastFailureAt;
  if (Number.isFinite(value.lastSuccessAt)) entry.lastSuccessAt = value.lastSuccessAt;
  return entry;
}

/**
 * The durable health table for one provider instance.
 *
 * Reads and writes are synchronous and whole-file: the table is a few hundred
 * bytes, updates happen at most once per model call, and a partial write would
 * be worse than the blocking. Writes go through a temp file plus rename so a
 * crash mid-write cannot truncate the table.
 */
export class HealthStore {
  /**
   * @param {object} [options] - construction options.
   * @param {string} [options.path] - state file path; defaults to {@link defaultStatePath}.
   * @param {() => number} [options.now] - clock, injectable for tests.
   */
  constructor({ path, now = Date.now } = {}) {
    /** Absolute path of the JSON state file. */
    this.path = path ?? defaultStatePath();
    /** Clock used for every decision; injectable so tests can travel in time. */
    this.now = now;
    /** @type {{version: number, entries: Record<string, EntryHealth>}} */
    this.state = emptyState();
    /** True once the file has been read (or found absent). */
    this.loaded = false;
  }

  /** Read the state file. Missing or corrupt files degrade to an empty table. */
  load() {
    this.loaded = true;
    this.state = emptyState();
    try {
      if (!existsSync(this.path)) return this.state;
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      const entries = parsed?.entries;
      if (entries === null || typeof entries !== 'object') return this.state;
      for (const [key, value] of Object.entries(entries)) {
        const entry = readEntry(value);
        if (entry !== undefined) this.state.entries[key] = entry;
      }
      const rotation = parsed?.lastRotation;
      if (rotation !== null && typeof rotation === 'object') {
        const { modelId, from, to, reason, code, detail, at } = rotation;
        if (
          typeof modelId === 'string'
          && typeof from === 'string'
          && typeof to === 'string'
          && Number.isFinite(at)
        ) {
          this.state.lastRotation = {
            modelId,
            from,
            to,
            reason: reason === 'quota' || reason === 'transient' ? reason : 'fatal',
            code: typeof code === 'string' ? code : '',
            detail: typeof detail === 'string' ? detail : '',
            at,
          };
        }
      }
    } catch {
      // A corrupt table must not break model calls: start clean and let the
      // next write replace the file.
      this.state = emptyState();
    }
    return this.state;
  }

  /** Read once, lazily. */
  #ensure() {
    if (!this.loaded) this.load();
    return this.state;
  }

  /**
   * Record that one model degraded from one candidate to the next.
   *
   * A rotation is the one thing about this plugin a user cannot infer from the
   * answer: the reply simply arrives from somewhere else. Keeping the last one
   * lets the configuration page say so, and it survives a restart so a rotation
   * that happened while the window was closed is still reportable.
   *
   * @param {Omit<RotationRecord, 'at'>} record - what happened.
   * @returns {RotationRecord} the stored record.
   */
  noteRotation(record) {
    const stored = { ...record, at: this.now() };
    this.#ensure().lastRotation = stored;
    this.save();
    return stored;
  }

  /**
   * The most recent rotation, if any.
   *
   * @returns {RotationRecord | undefined} a detached copy.
   */
  lastRotation() {
    const stored = this.#ensure().lastRotation;
    return stored === undefined ? undefined : { ...stored };
  }

  /** Persist the table atomically. Failures are swallowed: health is advisory. */
  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      renameSync(temp, this.path);
      return true;
    } catch {
      try {
        if (existsSync(`${this.path}.tmp`)) unlinkSync(`${this.path}.tmp`);
      } catch {
        // Nothing else to do: a state file we cannot write must never fail a call.
      }
      return false;
    }
  }

  /** @returns {EntryHealth | undefined} the stored record for one entry. */
  entry(key) {
    return this.#ensure().entries[key];
  }

  /**
   * Is this entry allowed to be attempted now?
   *
   * @param {string} key - entry id.
   * @param {number} [at] - instant to judge; defaults to the store clock.
   * @returns {EntryStatus} the decision, with the reason for any refusal.
   */
  status(key, at = this.now()) {
    const entry = this.#ensure().entries[key];
    const base = { key, available: true, reason: /** @type {const} */ (null), failures: entry?.failures ?? 0 };
    if (entry === undefined) return base;
    const extra = {
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      ...(entry.code === undefined ? {} : { code: entry.code }),
      ...(entry.lastFailureAt === undefined ? {} : { lastFailureAt: entry.lastFailureAt }),
      ...(entry.lastSuccessAt === undefined ? {} : { lastSuccessAt: entry.lastSuccessAt }),
    };
    if (entry.quotaDate !== undefined && entry.quotaDate === localDateKey(at)) {
      return { ...base, ...extra, available: false, reason: 'quota' };
    }
    if (entry.cooldownUntil !== undefined && entry.cooldownUntil > at) {
      return { ...base, ...extra, available: false, reason: 'cooldown', until: entry.cooldownUntil };
    }
    return { ...base, ...extra };
  }

  /**
   * Retire an entry for the rest of the local calendar day.
   *
   * @param {string} key - entry id.
   * @param {object} failure - the classified failure.
   * @param {string} [failure.detail] - message to show in the configuration page.
   * @param {string} [failure.code] - stable failure code.
   * @returns {EntryStatus} the new status.
   */
  markQuota(key, failure = {}) {
    const at = this.now();
    const state = this.#ensure();
    const previous = state.entries[key];
    state.entries[key] = {
      ...previous,
      quotaDate: localDateKey(at),
      cooldownUntil: undefined,
      failures: (previous?.failures ?? 0) + 1,
      lastFailureAt: at,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    };
    this.save();
    return this.status(key, at);
  }

  /**
   * Park an entry for a cooldown window.
   *
   * @param {string} key - entry id.
   * @param {number} cooldownMs - how long to park it.
   * @param {object} [failure] - the classified failure.
   * @param {string} [failure.detail] - message to show in the configuration page.
   * @param {string} [failure.code] - stable failure code.
   * @returns {EntryStatus} the new status.
   */
  markCooldown(key, cooldownMs, failure = {}) {
    const at = this.now();
    const state = this.#ensure();
    const previous = state.entries[key];
    state.entries[key] = {
      ...previous,
      cooldownUntil: at + Math.max(0, Math.trunc(cooldownMs)),
      failures: (previous?.failures ?? 0) + 1,
      lastFailureAt: at,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    };
    this.save();
    return this.status(key, at);
  }

  /**
   * Record a success: the entry is healthy again, so any cooldown lifts.
   *
   * A quota ban is deliberately *not* cleared here. The entry is never
   * attempted while banned, so a success can only mean the operator reset it —
   * and {@link clear} is the call for that.
   *
   * @param {string} key - entry id.
   * @returns {EntryStatus} the new status.
   */
  markSuccess(key) {
    const at = this.now();
    const state = this.#ensure();
    const previous = state.entries[key];
    state.entries[key] = {
      failures: 0,
      lastSuccessAt: at,
    };
    if (previous?.quotaDate !== undefined && previous.quotaDate === localDateKey(at)) {
      state.entries[key].quotaDate = previous.quotaDate;
    }
    this.save();
    return this.status(key, at);
  }

  /**
   * Forget everything recorded for one entry.
   *
   * @param {string} key - entry id.
   * @returns {boolean} true when a record existed.
   */
  clear(key) {
    const state = this.#ensure();
    if (state.entries[key] === undefined) return false;
    delete state.entries[key];
    this.save();
    return true;
  }

  /**
   * Forget every record: the configuration page's "reset all" action.
   *
   * @returns {number} how many entry records were dropped.
   */
  clearAll() {
    const state = this.#ensure();
    const count = Object.keys(state.entries).length;
    state.entries = {};
    this.save();
    return count;
  }

  /**
   * Drop records for entries that no longer exist in the configuration.
   *
   * @param {Iterable<string>} keys - entry ids the configuration currently declares.
   * @returns {readonly string[]} the keys that were dropped.
   */
  prune(keys) {
    const state = this.#ensure();
    const known = new Set(keys);
    const dropped = Object.keys(state.entries).filter((key) => !known.has(key));
    for (const key of dropped) delete state.entries[key];
    if (dropped.length > 0) this.save();
    return dropped;
  }

  /**
   * A detached view of every entry, for the configuration page.
   *
   * @param {Iterable<string>} keys - entry ids to report, in order.
   * @returns {{ path: string, entries: EntryStatus[] }} the snapshot.
   */
  snapshot(keys) {
    const at = this.now();
    return { path: this.path, entries: [...keys].map((key) => this.status(key, at)) };
  }
}
