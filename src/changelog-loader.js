/**
 * @file changelog-loader.js
 * @description Load and parse CHANGELOG.md for display in the TUI
 *
 * @functions
 *   → loadChangelog() — Read and parse CHANGELOG.md into structured format
 *   → getLatestChanges(version) — Return changelog for a specific version
 *   → formatChangelogForDisplay(version) — Format for TUI rendering
 *
 * @exports loadChangelog, getLatestChanges, formatChangelogForDisplay
 */

import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const CHANGELOG_PATH = join(__dirname, '..', 'CHANGELOG.md')

/**
 * 📖 loadChangelog: Read and parse CHANGELOG.md
 * @returns {Object} { versions: { '0.2.11': { added: [], fixed: [], changed: [] }, ... } }
 */
export function loadChangelog() {
  if (!existsSync(CHANGELOG_PATH)) return { versions: {} }

  const content = readFileSync(CHANGELOG_PATH, 'utf8')
  const versions = {}
  const lines = content.split('\n')
  let currentVersion = null
  let currentSection = null
  let currentItems = []

  for (const line of lines) {
    // 📖 Match version headers: ## 0.2.11
    const versionMatch = line.match(/^## ([\d.]+)/)
    if (versionMatch) {
      if (currentVersion && currentSection && currentItems.length > 0) {
        if (!versions[currentVersion]) versions[currentVersion] = {}
        versions[currentVersion][currentSection] = currentItems
      }
      currentVersion = versionMatch[1]
      currentSection = null
      currentItems = []
      continue
    }

    // 📖 Match section headers: ### Added, ### Fixed, ### Changed
    const sectionMatch = line.match(/^### (Added|Fixed|Changed|Updated)/)
    if (sectionMatch) {
      if (currentVersion && currentSection && currentItems.length > 0) {
        if (!versions[currentVersion]) versions[currentVersion] = {}
        versions[currentVersion][currentSection.toLowerCase()] = currentItems
      }
      currentSection = sectionMatch[1].toLowerCase()
      currentItems = []
      continue
    }

    // 📖 Match bullet points: - **text**: description
    if (line.match(/^- /) && currentVersion && currentSection) {
      currentItems.push(line.replace(/^- /, ''))
    }
  }

  // 📖 Save the last section
  if (currentVersion && currentSection && currentItems.length > 0) {
    if (!versions[currentVersion]) versions[currentVersion] = {}
    versions[currentVersion][currentSection] = currentItems
  }

  return { versions }
}

/**
 * 📖 getLatestChanges: Return changelog for a specific version
 * @param {string} version (e.g. '0.2.11')
 * @returns {Object|null}
 */
export function getLatestChanges(version) {
  const { versions } = loadChangelog()
  return versions[version] || null
}

/**
 * 📖 formatChangelogForDisplay: Format changelog section as array of strings for TUI
 * @param {string} version
 * @returns {string[]} formatted lines
 */
export function formatChangelogForDisplay(version) {
  const changes = getLatestChanges(version)
  if (!changes) return []

  const lines = [
    `📋 Changelog for v${version}`,
    '',
  ]

  const sections = { added: 'Added', fixed: 'Fixed', changed: 'Changed', updated: 'Updated' }
  for (const [key, label] of Object.entries(sections)) {
    if (changes[key] && changes[key].length > 0) {
      lines.push(`✨ ${label}:`)
      for (const item of changes[key]) {
        // 📖 Wrap long lines for display
        const maxWidth = 70
        let item_text = item.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
        if (item_text.length > maxWidth) {
          item_text = item_text.substring(0, maxWidth - 3) + '...'
        }
        lines.push(`  • ${item_text}`)
      }
      lines.push('')
    }
  }

  return lines
}
