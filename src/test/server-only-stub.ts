/**
 * Stand-in for the `server-only` package under test.
 *
 * That package throws unless it's resolved through React's `react-server`
 * export condition, which Vitest doesn't apply. Aliasing it here lets us test
 * server modules directly; it does not weaken the real guard, which still
 * applies to anything Next bundles for the browser.
 */
export {};
