/**
 * @file favorites.js
 * @description Favorites management for model rows — persisted per user in ~/.free-coding-models.json.
 *              Extracted from bin/free-coding-models.js to allow unit testing in isolation.
 *
 * @details
 *   Favorites are stored as an ordered array of strings in the format "providerKey/modelId"
 *   (e.g. "groq/llama-3.1-70b-versatile").  Insertion order matters: it determines the
 *   `favoriteRank` used by `sortResultsWithPinnedFavorites` to keep pinned rows at the top.
 *
 *   How it works at runtime:
 *   1. On startup, `syncFavoriteFlags()` is called once to attach `isFavorite`/`favoriteRank`
 *      metadata to every result row based on the persisted favorites list.
 *   2. When the user presses F, `toggleFavoriteModel()` reloads the latest config snapshot,
 *      applies the toggle there, then persists atomically so stale state cannot wipe favorites.
 *   3. The renderer reads `r.isFavorite` and `r.favoriteRank` from the row to decide whether
 *      to show the ⭐ prefix and how to sort the row relative to non-favorites.
 *
 * @functions
 *   → ensureFavoritesConfig(config)             — Ensure config.favorites is a clean deduped array
 *   → toFavoriteKey(providerKey, modelId)        — Build the canonical "providerKey/modelId" string
 *   → syncFavoriteFlags(results, config)         — Attach isFavorite/favoriteRank to result rows
 *   → toggleFavoriteModel(config, providerKey, modelId) — Add/remove favorite and persist
 *
 * @exports
 *   ensureFavoritesConfig, toFavoriteKey, syncFavoriteFlags, toggleFavoriteModel
 *
 * @see src/config.js  — load/save helpers keep favorite persistence atomic and merge-safe
 * @see bin/free-coding-models.js — calls syncFavoriteFlags on startup and toggleFavoriteModel on F key
 */

import { loadConfig, saveConfig, replaceConfigContents } from './config.js'

/**
 * 📖 Ensure favorites config shape exists and remains clean.
 * 📖 Stored format: ["providerKey/modelId", ...] in insertion order.
 * @param {Record<string, unknown>} config
 */
export function ensureFavoritesConfig(config) {
  if (!Array.isArray(config.favorites)) config.favorites = []
  const seen = new Set()
  config.favorites = config.favorites.filter((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) return false
    if (seen.has(entry)) return false
    seen.add(entry)
    return true
  })
}

/**
 * 📖 Build deterministic key used to persist one favorite model row.
 * @param {string} providerKey
 * @param {string} modelId
 * @returns {string}
 */
export function toFavoriteKey(providerKey, modelId) {
  return `${providerKey}/${modelId}`
}

/**
 * 📖 Sync per-row favorite metadata from config (used by renderer and sorter).
 * 📖 Mutates each row in-place — adds favoriteKey, isFavorite, favoriteRank.
 * @param {Array<Record<string, unknown>>} results
 * @param {Record<string, unknown>} config
 */
export function syncFavoriteFlags(results, config) {
  ensureFavoritesConfig(config)
  const favoriteRankMap = new Map(config.favorites.map((entry, index) => [entry, index]))
  for (const row of results) {
    const favoriteKey = toFavoriteKey(row.providerKey, row.modelId)
    const rank = favoriteRankMap.get(favoriteKey)
    row.favoriteKey = favoriteKey
    row.isFavorite = rank !== undefined
    row.favoriteRank = rank !== undefined ? rank : Number.MAX_SAFE_INTEGER
  }
}

/**
 * 📖 Toggle favorite state and persist immediately.
 * 📖 Returns true when row is now favorite, false when removed.
 * @param {Record<string, unknown>} config
 * @param {string} providerKey
 * @param {string} modelId
 * @returns {boolean}
 */
export function toggleFavoriteModel(config, providerKey, modelId) {
  const latestConfig = loadConfig()
  ensureFavoritesConfig(latestConfig)
  const favoriteKey = toFavoriteKey(providerKey, modelId)
  const existingIndex = latestConfig.favorites.indexOf(favoriteKey)
  if (existingIndex >= 0) {
    latestConfig.favorites.splice(existingIndex, 1)
    const saveResult = saveConfig(latestConfig, {
      replaceFavorites: true,
    })
    if (saveResult.success) replaceConfigContents(config, latestConfig)
    return false
  }
  latestConfig.favorites.push(favoriteKey)
  const saveResult = saveConfig(latestConfig, {
    replaceFavorites: true,
  })
  if (saveResult.success) replaceConfigContents(config, latestConfig)
  return true
}
