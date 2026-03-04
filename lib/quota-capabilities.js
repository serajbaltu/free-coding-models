/**
 * @file lib/quota-capabilities.js
 * @description Provider quota telemetry capability map.
 *
 * Describes how we can observe quota state for each provider:
 * - header:   Provider sends x-ratelimit-remaining / x-ratelimit-limit headers
 * - endpoint: Provider has a dedicated usage/quota REST endpoint we can poll
 * - unknown:  No reliable quota signal available
 *
 * supportsEndpoint (optional, for openrouter/siliconflow):
 *   true  — provider has a known usage endpoint
 *   false — no endpoint, header-only or unknown
 *
 * @exports PROVIDER_CAPABILITIES — full map keyed by providerKey (matches sources.js)
 * @exports getQuotaTelemetry(providerKey) — returns capability object (defaults to unknown)
 * @exports isKnownQuotaTelemetry(providerKey) — true when telemetryType !== 'unknown'
 */

/**
 * @typedef {Object} ProviderCapability
 * @property {'header'|'endpoint'|'unknown'} telemetryType
 * @property {boolean} [supportsEndpoint]
 */

/** @type {Record<string, ProviderCapability>} */
export const PROVIDER_CAPABILITIES = {
  // Providers that return x-ratelimit-remaining / x-ratelimit-limit headers
  nvidia: { telemetryType: 'header', supportsEndpoint: false },
  groq: { telemetryType: 'header', supportsEndpoint: false },
  cerebras: { telemetryType: 'header', supportsEndpoint: false },
  sambanova: { telemetryType: 'header', supportsEndpoint: false },
  deepinfra: { telemetryType: 'header', supportsEndpoint: false },
  fireworks: { telemetryType: 'header', supportsEndpoint: false },
  together: { telemetryType: 'header', supportsEndpoint: false },
  hyperbolic: { telemetryType: 'header', supportsEndpoint: false },
  scaleway: { telemetryType: 'header', supportsEndpoint: false },
  googleai: { telemetryType: 'header', supportsEndpoint: false },
  codestral: { telemetryType: 'header', supportsEndpoint: false },
  perplexity: { telemetryType: 'header', supportsEndpoint: false },
  qwen: { telemetryType: 'header', supportsEndpoint: false },

  // Providers that have a dedicated usage/credits endpoint
  openrouter: { telemetryType: 'endpoint', supportsEndpoint: true },
  siliconflow: { telemetryType: 'endpoint', supportsEndpoint: true },

  // Providers with no reliable quota signal
  huggingface: { telemetryType: 'unknown', supportsEndpoint: false },
  replicate: { telemetryType: 'unknown', supportsEndpoint: false },
  cloudflare: { telemetryType: 'unknown', supportsEndpoint: false },
  zai: { telemetryType: 'unknown', supportsEndpoint: false },
  iflow: { telemetryType: 'unknown', supportsEndpoint: false },
}

/** Fallback for unrecognized providers */
const UNKNOWN_CAPABILITY = { telemetryType: 'unknown', supportsEndpoint: false }

/**
 * Get quota telemetry capability for a provider.
 * Returns `{ telemetryType: 'unknown', supportsEndpoint: false }` for unrecognized providers.
 *
 * @param {string} providerKey - Provider key matching sources.js (e.g. 'groq', 'openrouter')
 * @returns {ProviderCapability}
 */
export function getQuotaTelemetry(providerKey) {
  return PROVIDER_CAPABILITIES[providerKey] ?? UNKNOWN_CAPABILITY
}

/**
 * Returns true when we have a reliable quota telemetry signal for this provider
 * (either via response headers or a dedicated endpoint).
 *
 * Returns false for 'unknown' providers where quota state must be inferred.
 *
 * @param {string} providerKey
 * @returns {boolean}
 */
export function isKnownQuotaTelemetry(providerKey) {
  return getQuotaTelemetry(providerKey).telemetryType !== 'unknown'
}
