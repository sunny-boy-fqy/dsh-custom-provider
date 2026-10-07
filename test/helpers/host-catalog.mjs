/**
 * The Host's catalog projection, invoked with a stub registry.
 *
 * Shared by the host and client suites so there is one definition of what
 * `/api/custom-provider/catalog` returns. A client test that builds the payload
 * by hand only proves the client agrees with *the test*; routing the client
 * through this proves the two halves agree with each other.
 *
 * Deliberately imports `src/reuse.js` and not `index.js`: the latter needs
 * `@deepseek-ai/schemastery`, which only resolves inside a profile, and this
 * helper has to work from the source tree too. `index.js` calls exactly this
 * function to answer the route, so the shape below is the real one.
 *
 * @module @local/dsh-custom-provider/test/helpers/host-catalog
 */
import { buildCatalogView } from '../../src/reuse.js';
import { reusedProviders } from '../../src/normalize.js';

/**
 * Run the real projection over a list of routes.
 *
 * @param {Array<{id: string, name?: string, models?: object[]}>} routes - the registry.
 * @param {string[]} [reused] - route ids the config borrows from, or a config.
 * @returns {Promise<object>} the catalog payload.
 */
export async function liveCatalogFor(routes, reused = []) {
  const own = 'custom';
  const providers = routes
    .filter((route) => route.id !== own)
    .map((route) => ({ id: route.id, name: route.name ?? route.id }));
  const listed = new Map();
  for (const route of routes) listed.set(route.id, { models: route.models ?? [] });
  return {
    ok: true,
    self: own,
    reused,
    ...buildCatalogView({ providers, listed, self: own }),
  };
}

export { buildCatalogView, reusedProviders };
