<p align="center">
  <img src="https://img.shields.io/npm/v/free-coding-models?color=76b900&label=npm&logo=npm" alt="npm version">
  <img src="https://img.shields.io/node/v/free-coding-models?color=76b900&logo=node.js" alt="node version">
  <img src="https://img.shields.io/npm/l/free-coding-models?color=76b900" alt="license">
  <img src="https://img.shields.io/badge/models-238-76b900?logo=nvidia" alt="models count">
  <img src="https://img.shields.io/badge/providers-25-blue" alt="providers count">
  <br>
  <img src="https://img.shields.io/badge/dependencies-1-76b900?logo=npm" alt="1 dependency">
  <img src="https://img.shields.io/badge/provenance-sigstore-blueviolet?logo=signstore" alt="npm provenance">
  <img src="https://img.shields.io/badge/supply_chain-verified-brightgreen" alt="supply chain verified">
</p>

<h1 align="center">free-coding-models</h1>

<p align="center">
  <strong>Find the fastest free coding model in seconds</strong><br>
  <sub>Ping 238 models across 25 AI Free providers in real-time </sub><br><sub> Install Free API endpoints to your favorite AI coding tool: <br>📦 OpenCode, 🦞 OpenClaw, 💘 Crush, 🪿 Goose, 🛠 Aider, 🐉 Qwen Code, 🤲 OpenHands, ⚡ Amp, π Pi, 🦘 Rovo or ♊ Gemini in one keystroke</sub>
</p>



<p align="center">

```bash
npm install -g free-coding-models
free-coding-models
```

create a free account on one of the [providers](#-list-of-free-ai-providers)

</p>

<p align="center">
  <a href="#-why-this-tool">💡 Why</a> •
  <a href="#-quick-start">⚡ Quick Start</a> •
  <a href="#-list-of-free-ai-providers">🟢 Providers</a> •
  <a href="#-usage">🚀 Usage</a> •
  <a href="#-tui-keys">⌨️ TUI Keys</a> •
  <a href="#-features">✨ Features</a> •
  <a href="#-contributing">📋 Contributing</a> •
  <a href="#️-model-licensing--commercial-use">⚖️ Licensing</a> •
  <a href="#️-security--trust">🛡️ Security</a> •
  <a href="#-support">📧 Support</a> •
  <a href="#-license">📄 License</a>
</p>

<p align="center">
  <img src="demo.gif" alt="free-coding-models demo" width="100%">
</p>

<p align="center">
  <sub>Made with ❤️ and ☕ by <a href="https://vanessadepraute.dev">Vanessa Depraute</a> (aka <a href="https://vavanessa.dev">Vava-Nessa</a>)</sub>
</p>

---

## 💡 Why this tool?

There are **238+ free coding models** scattered across 25 providers. Which one is fastest right now? Which one is actually stable versus just lucky on the last ping?

This CLI pings them all in parallel, shows live latency, and calculates a **live Stability Score (0-100)**. Average latency alone is misleading if a model randomly spikes to 6 seconds; the stability score measures true reliability by combining **p95 latency** (30%), **jitter/variance** (30%), **spike rate** (20%), and **uptime** (20%). 

It then writes the model you pick directly into your coding tool's config — so you go from "which model?" to "coding" in under 10 seconds.

---

## ⚡ Quick Start

### 🟢 List of Free AI Providers

Create a free account on one provider below to get started:

**238 coding models** across 25 providers, ranked by [SWE-bench Verified](https://www.swebench.com).

| Provider | Models | Tier range | Free tier | Env var |
|----------|--------|-----------|-----------|--------|
| [NVIDIA NIM](https://build.nvidia.com) | 46 | S+ → C | 40 req/min (no credit card needed) | `NVIDIA_API_KEY` |
| [OpenRouter](https://openrouter.ai/keys) | 25 | S+ → C | Free on :free: 50/day <$10, 1000/day ≥$10 (20 req/min) | `OPENROUTER_API_KEY` |
| [Cloudflare Workers AI](https://dash.cloudflare.com) | 15 | S → B | Free: 10k neurons/day, text-gen 300 RPM | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |
| [SambaNova](https://sambanova.ai/developers) | 13 | S+ → B | Dev tier generous quota | `SAMBANOVA_API_KEY` |
| [Hyperbolic](https://app.hyperbolic.ai/settings) | 13 | S+ → A- | $1 free trial credits | `HYPERBOLIC_API_KEY` |
| [Together AI](https://api.together.ai/settings/api-keys) | 19 | S+ → A- | Credits/promos vary by account (check console) | `TOGETHER_API_KEY` |
| [Scaleway](https://console.scaleway.com/iam/api-keys) | 10 | S+ → B+ | 1M free tokens | `SCALEWAY_API_KEY` |
| [iFlow](https://platform.iflow.cn) | 11 | S+ → A+ | Free for individuals (no req limits, 7-day key expiry) | `IFLOW_API_KEY` |
| [Alibaba DashScope](https://modelstudio.console.alibabacloud.com) | 11 | S+ → A | 1M free tokens per model (Singapore region, 90 days) | `DASHSCOPE_API_KEY` |
| [Groq](https://console.groq.com/keys) | 8 | S → B | 30‑50 RPM per model (varies by model) | `GROQ_API_KEY` |
| [Rovo Dev CLI](https://www.atlassian.com/rovo) | 5 | S+ | 5M tokens/day (beta) | CLI tool 🦘 |
| [ZAI](https://z.ai) | 7 | S+ → S | Free tier (generous quota) | `ZAI_API_KEY` |
| [OpenCode Zen](https://opencode.ai/zen) | 7 | S+ → A+ | Free with OpenCode account | Zen models ✨ |
| [Google AI Studio](https://aistudio.google.com/apikey) | 6 | B+ → C | 14.4K req/day, 30/min | `GOOGLE_API_KEY` |
| [SiliconFlow](https://cloud.siliconflow.cn/account/ak) | 6 | S+ → A | Free models: usually 100 RPM, varies by model | `SILICONFLOW_API_KEY` |
| [Cerebras](https://cloud.cerebras.ai) | 4 | S+ → B | Generous free tier (developer tier 10× higher limits) | `CEREBRAS_API_KEY` |
| [Perplexity API](https://www.perplexity.ai/settings/api) | 4 | A+ → B | Tiered limits by spend (default ~50 RPM) | `PERPLEXITY_API_KEY` |
| [OVHcloud AI Endpoints](https://endpoints.ai.cloud.ovh.net) | 8 | S → B | Free sandbox: 2 req/min/IP (no key). 400 RPM with key | `OVH_AI_ENDPOINTS_ACCESS_TOKEN` |
| [Chutes AI](https://chutes.ai) | 4 | S → A | Free (community GPU-powered, no credit card) | `CHUTES_API_KEY` |
| [DeepInfra](https://deepinfra.com/login) | 4 | A- → B+ | 200 concurrent requests (default) | `DEEPINFRA_API_KEY` |
| [Fireworks AI](https://fireworks.ai) | 4 | S → B+ | $1 credits – 10 req/min without payment | `FIREWORKS_API_KEY` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | 3 | S+ → A+ | 1,000 req/day | CLI tool ♊ |
| [Hugging Face](https://huggingface.com/settings/tokens) | 2 | S → B | Free monthly credits (~$0.10) | `HUGGINGFACE_API_KEY` |
| [Replicate](https://replicate.com/account/api-tokens) | 2 | A- → B | 6 req/min (no payment) – up to 3,000 RPM with payment | `REPLICATE_API_TOKEN` |
| [Mistral Codestral](https://codestral.mistral.ai) | 1 | B+ | 30 req/min, 2000/day | `CODESTRAL_API_KEY` |

> 💡 One key is enough. Add more at any time with **`P`** inside the TUI.

### Tier scale

| Tier | SWE-bench | Best for |
|------|-----------|----------|
| **S+** | ≥ 70% | Complex refactors, real-world GitHub issues |
| **S** | 60–70% | Most coding tasks, strong general use |
| **A+/A** | 40–60% | Solid alternatives, targeted programming |
| **A-/B+** | 30–40% | Smaller tasks, constrained infra |
| **B/C** | < 30% | Code completion, edge/minimal setups |

**① Install and run:**

```bash
npm install -g free-coding-models
free-coding-models
```

On first run, you'll be prompted to enter your API key(s). You can skip providers and add more later with **`P`**.

Use ⚡️ Command Palette! with **Ctrl+P**.

<p align="center">
  <img src="https://img.shields.io/badge/USE_%E2%9A%A1%EF%B8%8F%20COMMAND%20PALETTE-CTRL%2BP-22c55e?style=for-the-badge" alt="Use ⚡️ Command Palette with Ctrl+P">
</p>

Need to fix contrast because your terminal theme is fighting the TUI? Press **`G`** at any time to cycle **Auto → Dark → Light**. The switch recolors the full interface live: table, Settings, Help, Smart Recommend, Feedback, and Changelog.

**② Pick a model and launch your tool:**

```
↑↓ navigate   →   Enter to launch
```

The model you select is automatically written into your tool's config (📦 OpenCode, 🦞 OpenClaw, 💘 Crush, etc.) and the tool opens immediately. Done.

If the active CLI tool is missing, FCM now catches it before launch, offers a tiny Yes/No install prompt, installs the tool with its official global command, then resumes the same model launch automatically.

> 💡 You can also run `free-coding-models --goose --tier S` to pre-filter to S-tier models for Goose before the TUI even opens.

<p align="center">
  <img src="demo2.gif" alt="free-coding-models TUI demo" width="100%">
</p>

## 🚀 Usage

### Common scenarios

```bash
# "I want the most reliable model right now"
free-coding-models --fiable

# "I want to configure Goose with an S-tier model"
free-coding-models --goose --tier S

# "I want NVIDIA's top models only"
free-coding-models --origin nvidia --tier S

# "Start with an elite-focused preset, then adjust filters live"
free-coding-models --premium

# "I want to script this — give me JSON"
free-coding-models --tier S --json | jq -r '.[0].modelId'

# "I want to configure OpenClaw with Groq's fastest model"
free-coding-models --openclaw --origin groq
```

### Tool launcher flags

| Flag | Launches |
|------|----------|
| `--opencode` | 📦 OpenCode CLI |
| `--opencode-desktop` | 📦 OpenCode Desktop |
| `--openclaw` | 🦞 OpenClaw |
| `--crush` | 💘 Crush |
| `--goose` | 🪿 Goose |
| `--aider` | 🛠 Aider |
| `--qwen` | 🐉 Qwen Code |
| `--openhands` | 🤲 OpenHands |
| `--amp` | ⚡ Amp |
| `--pi` | π Pi |
| `--rovo` | 🦘 Rovo Dev CLI |
| `--gemini` | ♊ Gemini CLI |

Press **`Z`** in the TUI to cycle between tools without restarting.

### CLI-Only Tools

**🦘 Rovo Dev CLI**
- Provider: [Atlassian Rovo](https://www.atlassian.com/rovo)
- Install: [Installation Guide](https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/)
- Free tier: 5M tokens/day (beta, requires Atlassian account)
- Model: Claude Sonnet 4 (72.7% SWE-bench)
- Launch: `free-coding-models --rovo` or press `Z` until Rovo mode
- Features: Jira/Confluence integration, MCP server support

**♊ Gemini CLI**
- Provider: [Google Gemini](https://github.com/google-gemini/gemini-cli)
- Install: `npm install -g @google/gemini-cli`
- Free tier: 1,000 requests/day (personal Google account, no credit card)
- Models: Gemini 3 Pro (76.2% SWE-bench), Gemini 2.5 Pro, Gemini 2.5 Flash
- Launch: `free-coding-models --gemini` or press `Z` until Gemini mode
- Features: OpenAI-compatible API support, MCP server support, Google Search grounding

**Note:** When launching these tools via `Z` key or command palette, if the current mode doesn't match the tool, you'll see a confirmation alert asking to switch to the correct tool before launching.

### OpenCode Zen Free Models

[OpenCode Zen](https://opencode.ai/zen) is a hosted AI gateway offering 8 free coding models exclusively through OpenCode CLI and OpenCode Desktop. These models are **not** available through other tools.

| Model | Tier | SWE-bench | Context |
|-------|------|-----------|---------|
| Big Pickle | S+ | 72.0% | 200k |
| MiniMax M2.5 Free | S+ | 80.2% | 200k |
| MiMo V2 Pro Free | S+ | 78.0% | 1M |
| MiMo V2 Omni Free | S | 64.0% | 128k |
| MiMo V2 Flash Free | S+ | 73.4% | 256k |
| Nemotron 3 Super Free | A+ | 52.0% | 128k |
| GPT 5 Nano | S | 65.0% | 128k |
| Trinity Large Preview Free | S | 62.0% | 128k |

To use Zen models: sign up at [opencode.ai/auth](https://opencode.ai/auth) and enter your Zen API key via `P` (Settings). Zen models appear in the main table and auto-switch to OpenCode CLI on launch.

### Tool Compatibility

When a tool mode is active (via `Z`), models incompatible with that tool are highlighted with a dark red background so you can instantly see which models work with your current tool.

| Model Type | Compatible Tools |
|------------|-----------------|
| Regular (NVIDIA, Groq, etc.) | All tools except 🦘 Rovo and ♊ Gemini |
| Rovo | 🦘 Rovo Dev CLI only |
| Gemini | ♊ Gemini CLI only |
| OpenCode Zen | 📦 OpenCode CLI and 📦 OpenCode Desktop only |

→ **[Full flags reference](./docs/flags.md)**

---

## ⌨️ TUI Keys

### Keyboard

| Key | Action |
|-----|--------|
| `↑↓` | Navigate models |
| `Enter` | Launch selected model in active tool |
| `Z` | Cycle target tool |
| `T` | Cycle tier filter |
| `D` | Cycle provider filter |
| `E` | Toggle configured-only mode |
| `F` | Favorite / unfavorite model |
| `Y` | Toggle favorites mode (`Normal filter/sort` default ↔ `Pinned + always visible`) |
| `X` | Clear active custom text filter |
| `G` | Cycle global theme (`Auto → Dark → Light`) |
| `Ctrl+P` | Open ⚡️ command palette (search + run actions) |
| `R/S/C/M/O/L/A/H/V/B/U` | Sort columns |
| `Shift+U` | Update to latest version (when update available) |
| `P` | Settings (API keys, providers, updates, theme) |
| `Q` | Smart Recommend overlay |
| `N` | Changelog |
| `W` | Cycle ping cadence |
| `I` | Feedback / bug report |
| `K` | Help overlay |
| `Ctrl+C` | Exit |

### Mouse

| Action | Result |
|--------|--------|
| **Click column header** | Sort by that column |
| **Click Tier header** | Cycle tier filter |
| **Click CLI Tools header** | Cycle tool mode |
| **Click model row** | Move cursor to model |
| **Double-click model row** | Select and launch model |
| **Right-click model row** | Toggle favorite |
| **Scroll wheel** | Navigate table / overlays / palette |
| **Click footer hotkey** | Trigger that action |
| **Click update banner** | Install latest version and relaunch |
| **Click command palette item** | Select item (double-click to confirm) |
| **Click recommend option** | Select option (double-click to confirm) |
| **Click outside modal** | Close command palette |

→ **[Stability score & column reference](./docs/stability.md)**

---

## ✨ Features

- **Parallel pings** — all 238 models tested simultaneously via native `fetch`
- **Adaptive monitoring** — 2s burst for 60s → 10s normal → 30s idle
- **Stability score** — composite 0–100 (p95 latency, jitter, spike rate, uptime)
- **Smart ranking** — top 3 highlighted 🥇🥈🥉
- **Favorites** — star models with `F`, persisted across sessions, default to normal rows, and switch display mode with `Y` (pinned+sticky vs normal rows)
- **Configured-only default** — only shows providers you have keys for
- **Keyless latency** — models ping even without an API key (show 🔑 NO KEY)
- **Smart Recommend** — questionnaire picks the best model for your task type
- **⚡️ Command Palette** — `Ctrl+P` opens a searchable action launcher for filters, sorting, overlays, and quick toggles
- **Install Endpoints** — push a full provider catalog into any tool's config (from Settings `P` or ⚡️ Command Palette)
- **Missing tool bootstrap** — detect absent CLIs, offer one-click install, then continue the selected launch automatically
- **Tool compatibility matrix** — incompatible rows highlighted in dark red when a tool mode is active
- **OpenCode Zen models** — 8 free models exclusive to OpenCode CLI/Desktop, powered by the Zen AI gateway
- **Width guardrail** — shows a warning instead of a broken table in narrow terminals
- **Readable everywhere** — semantic theme palette keeps table rows, overlays, badges, and help screens legible in dark and light terminals
- **Global theme switch** — `G` cycles `auto`, `dark`, + `light` live without restarting
- **Auto-retry** — timeout models keep getting retried
- **Aggressive update nudging** — fluorescent green banner when an update is available, impossible to miss, Shift+U hotkey, command palette entry, background re-check every 5 min, mid-session updates the banner live without restarting
- **Last release timestamp** — light pink footer shows `Last release: Mar 27, 2026, 09:42 PM` from npm so users know how fresh the data is

---

## 📋 Contributing

We welcome contributions — issues, PRs, new provider integrations.

**Q:** How accurate are the latency numbers?  
**A:** Real round-trip times measured by your machine. Results depend on your network and provider load at that moment.

**Q:** Can I add a new provider?  
**A:** Yes — see [`sources.js`](./sources.js) for the model catalog format.

→ **[Development guide](./docs/development.md)** · **[Config reference](./docs/config.md)** · **[Tool integrations](./docs/integrations.md)**

---

## ⚖️ Model Licensing & Commercial Use

**Short answer:** All 238 models allow **commercial use of generated output (including code)**. You own what the models generate for you.

### Output Ownership

For every model in this tool, **you own the generated output** — code, text, or otherwise — and can use it commercially. The licenses below govern the *model weights themselves*, not your generated content.

### License Breakdown by Model Family

| License | Models | Commercial Output |
|---------|--------|:-----------------:|
| **Apache 2.0** | Qwen3/Qwen3.5/Qwen2.5 Coder, GPT-OSS 120B/20B, Devstral Small 2, Gemma 4, MiMo V2 Flash | ✅ Unrestricted |
| **MIT** | GLM 4.5/4.6/4.7/5, MiniMax M2.1, Devstral 2 | ✅ Unrestricted |
| **Modified MIT** | Kimi K2/K2.5 (>100M MAU → display "Kimi K2" branding) | ✅ With attribution at scale |
| **Llama Community License** | Llama 3.3 70B, Llama 4 Scout/Maverick | ✅ Attribution required. >700M MAU → separate Meta license |
| **DeepSeek License** | DeepSeek V3/V3.1/V3.2, R1 | ✅ Use restrictions on model (no military, no harm) — output is yours |
| **NVIDIA Nemotron License** | Nemotron Super/Ultra/Nano | ✅ Updated Mar 2026, now near-Apache 2.0 permissive |
| **MiniMax Model License** | MiniMax M2, M2.5 | ✅ Royalty-free, non-exclusive. Prohibited uses policy applies to model |
| **Proprietary (API)** | Claude (Rovo), Gemini (CLI), Perplexity Sonar, Mistral Large, Codestral | ✅ You own outputs per provider ToS |
| **OpenCode Zen** | Big Pickle, MiMo V2 Pro/Flash/Omni Free, GPT 5 Nano, MiniMax M2.5 Free, Nemotron 3 Super Free | ✅ Per OpenCode Zen ToS |

### Key Points

1. **Generated code is yours** — no model claims ownership of your output
2. **Apache 2.0 / MIT models** (Qwen, GLM, GPT-OSS, MiMo, Devstral Small) are the most permissive — no strings attached
3. **Llama** requires "Built with Llama" attribution; >700M MAU needs a Meta license
4. **DeepSeek / MiniMax** have use-restriction policies (no military use) that govern the model, not your generated code
5. **API-served models** (Claude, Gemini, Perplexity) grant full output ownership under their terms of service

> ⚠️ **Disclaimer:** This is a summary, not legal advice. License terms can change. Always verify the current license on the model's official page before making legal decisions.

---

## 🛡️ Security & Trust

### Supply Chain

| Signal | Status |
|--------|--------|
| **npm Provenance** | ✅ Published with Sigstore-signed provenance |
| **SBOM** | ✅ Software Bill of Materials attached to every GitHub Release |
| **Dependencies** | ✅ 1 runtime dependency (`chalk`) |
| **Lockfile** | ✅ `pnpm-lock.yaml` committed and tracked |
| **Security Policy** | ✅ [`SECURITY.md`](SECURITY.md) |
| **Code Owners** | ✅ [`CODEOWNERS`](CODEOWNERS) — all changes require maintainer review |
| **Dependabot** | ✅ Weekly automated dependency + GitHub Actions updates |
| **Audit CI** | ✅ `npm audit` runs on every push/PR + weekly scheduled scan |
| **License** | ✅ MIT |

### What This Tool Does

- Pings public API endpoints to measure latency and check availability
- Reads your API keys from `.env` files (only if you configure them)
- Opens configuration files for editing (with your permission)
- Reports anonymous usage data (no personal information — see footer)

### What This Tool Does NOT Do

- ❌ Does **not** send your API keys, code, or personal data to any third party
- ❌ Does **not** install or execute arbitrary code beyond `chalk` (the only dependency)
- ❌ Does **not** modify any files outside its own config directory
- ❌ Does **not** require `sudo`, root, or elevated permissions

> To report a vulnerability, see [`SECURITY.md`](SECURITY.md).

---

## 📧 Support

[GitHub Issues](https://github.com/vava-nessa/free-coding-models/issues) · [Discord](https://discord.gg/ZTNFHvvCkU)

---

## 📄 License

MIT © [vava](https://github.com/vava-nessa)

---

<p align="center">
  <strong>Contributors</strong><br>
  <a href="https://github.com/vava-nessa"><img src="https://avatars.githubusercontent.com/u/5466264?v=4&s=60" width="60" height="60" style="border-radius:50%" alt="vava-nessa"></a>
  <a href="https://github.com/erwinh22"><img src="https://avatars.githubusercontent.com/u/6641858?v=4&s=60" width="60" height="60" style="border-radius:50%" alt="erwinh22"></a>
  <a href="https://github.com/whit3rabbit"><img src="https://avatars.githubusercontent.com/u/12357518?v=4&s=60" width="60" height="60" style="border-radius:50%" alt="whit3rabbit"></a>
  <a href="https://github.com/skylaweber"><img src="https://avatars.githubusercontent.com/u/172871734?v=4&s=60" width="60" height="60" style="border-radius:50%" alt="skylaweber"></a>
  <a href="https://github.com/PhucTruong-ctrl"><img src="https://github.com/PhucTruong-ctrl.png?s=60" width="60" height="60" style="border-radius:50%" alt="PhucTruong-ctrl"></a>
  <br>
  <sub>
    <a href="https://github.com/vava-nessa">vava-nessa</a> &middot;
    <a href="https://github.com/erwinh22">erwinh22</a> &middot;
    <a href="https://github.com/whit3rabbit">whit3rabbit</a> &middot;
    <a href="https://github.com/skylaweber">skylaweber</a> &middot;
    <a href="https://github.com/PhucTruong-ctrl">PhucTruong-ctrl</a>
  </sub>
</p>



<p align="center">
  <sub>Anonymous usage data collected to improve the tool. No personal information ever.</sub>
</p>
