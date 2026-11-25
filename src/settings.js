/**
 * Settings surface for the MiMo plugin.
 *
 * Everything here is **local**: the MiMo gateway exposes no account, credit,
 * check-in or load endpoints, so there is nothing upstream to mirror. These are
 * the knobs the reference plugin has that still mean something without that
 * data.
 *
 * @module dsh-connect-mimo/settings
 */

/** Refresh-cadence choices offered by the settings page, in milliseconds. */
export const POLL_CHOICES_MS = [60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000]

/** Default cadence when the stored value is not one of the choices. */
export const DEFAULT_POLL_MS = 5 * 60 * 1000

/**
 * Coerce a stored cadence to one of the offered choices.
 *
 * A hand-edited config must not be able to turn the poll loop into a busy loop,
 * so an unrecognised value falls back to the default rather than being used.
 */
export function normalizePollMs(value) {
  const ms = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(ms)) return DEFAULT_POLL_MS
  return POLL_CHOICES_MS.includes(ms) ? ms : DEFAULT_POLL_MS
}

/**
 * Normalize the enabled-model list.
 *
 * `null`/undefined means "every model the catalog offers", which is the
 * pre-settings behaviour and must survive an upgrade. An explicit empty array
 * is honoured as "none enabled" rather than silently meaning "all".
 */
export function normalizeEnabledModels(value) {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return null
  return value.filter(id => typeof id === 'string' && id.length > 0)
}

/**
 * Coerce a stored quota placement to one of the two seats.
 *
 * `dock` is the stats row below the composer (the original behaviour);
 * `input` is the trailing controls inside the composer, before the model
 * picker. Anything outside the pair falls back to `dock`.
 */
export function normalizePlacement(value) {
  return value === 'input' ? 'input' : 'dock'
}
/** Defaults, mirroring the schema so a missing key behaves identically. */
export const SETTINGS_DEFAULTS = {
  providerEnabled: true,
  showQuotaInComposer: true,
  quotaPlacement: 'dock',
  sidebarPanel: false,
  pollIntervalMs: DEFAULT_POLL_MS,
  enabledModels: null,
}

/**
 * Read one config field through its live reference.
 *
 * A field marked `.volatile()` in the Config schema reaches the plugin as a
 * stable reference (`{ get() }`) that the framework updates in place, not as the
 * bare value; an ordinary field arrives as itself. Both shapes are read here, so
 * every consumer keeps seeing plain values.
 */
function unwrap(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

/** Read the settings block out of a resolved plugin config. */
export function readSettings(config) {
  const raw = config ?? {}
  return {
    providerEnabled: unwrap(raw.providerEnabled) !== false,
    showQuotaInComposer: unwrap(raw.showQuotaInComposer) !== false,
    quotaPlacement: normalizePlacement(unwrap(raw.quotaPlacement)),
    sidebarPanel: unwrap(raw.sidebarPanel) === true,
    pollIntervalMs: normalizePollMs(unwrap(raw.pollIntervalMs)),
    enabledModels: normalizeEnabledModels(unwrap(raw.enabledModels)),
  }
}
