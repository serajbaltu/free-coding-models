/**
 * @file src/cli-help.js
 * @description Shared CLI help builder for the startup `--help` flag and the in-app help overlay.
 *
 * @details
 *   📖 Keeping CLI help text in one module avoids the classic drift where the TUI overlay
 *   📖 documents one set of flags while `--help` prints another. New flags should be added
 *   📖 here once, then both entry points stay aligned.
 *
 *   📖 The builder accepts an optional `chalk` instance. When omitted, it returns plain text,
 *   📖 which keeps unit tests simple and makes the function safe for non-TTY contexts.
 *
 * @functions
 *   → `buildCliHelpLines` — build formatted help lines with optional colors and indentation
 *   → `buildCliHelpText` — join the help lines into one printable string
 *
 * @exports buildCliHelpLines, buildCliHelpText
 * @see ./tool-metadata.js — source of truth for launcher modes and their CLI flags
 */

import { getToolModeOrder, getToolMeta } from './tool-metadata.js'

const ANALYSIS_FLAGS = [
  { flag: '--best', description: 'Show only top tiers (A+, S, S+)' },
  { flag: '--fiable', description: 'Run the 10s reliability analysis mode' },
  { flag: '--json', description: 'Output results as JSON for scripts/automation' },
  { flag: '--tier <S|A|B|C>', description: 'Filter models by tier family' },
  { flag: '--recommend', description: 'Open Smart Recommend immediately on startup' },
  { flag: '--premium', description: 'Show only S/S+ models with perfect health and good verdict' },
  { flag: '--sort <column>', description: 'Sort by column (rank, tier, origin, model, ping, avg, swe, ctx, condition, verdict, uptime, stability, usage)' },
  { flag: '--desc | --asc', description: 'Set sort direction (descending or ascending)' },
  { flag: '--origin <provider>', description: 'Filter models by provider origin' },
  { flag: '--ping-interval <ms>', description: 'Override ping interval in milliseconds' },
  { flag: '--hide-unconfigured', description: 'Hide models without configured API keys' },
  { flag: '--show-unconfigured', description: 'Show all models regardless of API key config' },
  { flag: '--disable-widths-warning', description: 'Disable terminal width warning' },
]

const CONFIG_FLAGS = [
  { flag: '--proxy', description: 'Start FCM Proxy V2 in foreground with live dashboard (no daemon)' },
  { flag: '--no-telemetry', description: 'Disable anonymous telemetry for this run' },
  { flag: '--clean-proxy, --proxy-clean', description: 'Remove persisted fcm-proxy config from OpenCode' },
  { flag: '--help, -h', description: 'Print this help and exit' },
]

const COMMANDS = [
  { command: 'daemon status', description: 'Show background FCM Proxy V2 service status' },
  { command: 'daemon install', description: 'Install and start the background service' },
  { command: 'daemon uninstall', description: 'Remove the background service' },
  { command: 'daemon restart', description: 'Restart the background service' },
  { command: 'daemon stop', description: 'Gracefully stop the background service without uninstalling it' },
  { command: 'daemon logs', description: 'Print the latest daemon log lines' },
]

const EXAMPLES = [
  'free-coding-models --help',
  'free-coding-models --openclaw --tier S',
  "free-coding-models --json | jq '.[0]'",
  'free-coding-models daemon status',
]

function paint(chalk, formatter, text) {
  if (!chalk || !formatter) return text
  return formatter(text)
}

function formatEntry(label, description, { chalk = null, indent = '', labelWidth = 40 } = {}) {
  const coloredLabel = paint(chalk, chalk?.cyan, label.padEnd(labelWidth))
  const coloredDescription = paint(chalk, chalk?.dim, description)
  return `${indent}${coloredLabel} ${coloredDescription}`
}

export function buildCliHelpLines({ chalk = null, indent = '', title = 'CLI Help' } = {}) {
  const lines = []
  const launchFlags = getToolModeOrder()
    .map((mode) => getToolMeta(mode))
    .filter((meta) => meta.flag)
    .map((meta) => ({ flag: meta.flag, description: `${meta.label} mode` }))

  lines.push(`${indent}${paint(chalk, chalk?.bold, title)}`)
  lines.push(`${indent}${paint(chalk, chalk?.dim, 'Usage: free-coding-models [apiKey] [options]')}`)
  lines.push(`${indent}${paint(chalk, chalk?.dim, '       free-coding-models daemon [status|install|uninstall|restart|stop|logs]')}`)
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.bold, 'Tool Flags')}`)
  for (const entry of launchFlags) {
    lines.push(formatEntry(entry.flag, entry.description, { chalk, indent }))
  }
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.bold, 'Analysis Flags')}`)
  for (const entry of ANALYSIS_FLAGS) {
    lines.push(formatEntry(entry.flag, entry.description, { chalk, indent }))
  }
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.bold, 'Config & Maintenance')}`)
  for (const entry of CONFIG_FLAGS) {
    lines.push(formatEntry(entry.flag, entry.description, { chalk, indent }))
  }
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.bold, 'Commands')}`)
  for (const entry of COMMANDS) {
    lines.push(formatEntry(entry.command, entry.description, { chalk, indent }))
  }
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.dim, 'Default launcher with no tool flag: OpenCode CLI')}`)
  lines.push(`${indent}${paint(chalk, chalk?.dim, 'Flags can be combined: --openclaw --tier S --json')}`)
  lines.push('')
  lines.push(`${indent}${paint(chalk, chalk?.bold, 'Examples')}`)
  for (const example of EXAMPLES) {
    lines.push(`${indent}${paint(chalk, chalk?.cyan, example)}`)
  }

  return lines
}

export function buildCliHelpText(options = {}) {
  return buildCliHelpLines(options).join('\n')
}
