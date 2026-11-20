// Resolve the effective Kount configuration (Developer Settings KV first,
// then Worker env) and validate it centrally. Read per request, so a value
// saved in the admin UI applies to the next operation without a redeploy.
import { KOUNT_SETTING_KEYS, parseKountConfig } from '../config/kount.js'
import { resolveSetting } from './DeveloperSettingsService.js'

export async function resolveKountRaw(kv, env) {
  const entries = await Promise.all(
    KOUNT_SETTING_KEYS.map(async (key) => [key, kv ? await resolveSetting(kv, env, key) : env?.[key]]),
  )
  return Object.fromEntries(entries)
}

/** @throws {import('../config/kount.js').KountConfigError} on invalid values */
export async function resolveKountConfig(kv, env) {
  return parseKountConfig(await resolveKountRaw(kv, env))
}
