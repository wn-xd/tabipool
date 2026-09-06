# Tabipool API Proxy

Key-rotating reverse proxy pool for OpenAI-compatible gateways with automatic failover, balance monitoring, upstream management, and multi-provider routing. Loopback-only, zero dependencies.

## Quick Install (One-Line)

Run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/windro-exe/tabipool/main/install.ps1 | iex
```

This will automatically:
1. Verify prerequisites (`git`, `bun`, `nssm`).
2. Clone `tabipool` to `%USERPROFILE%\tabipool` (or update if already cloned).
3. Install dependencies (`bun install`).
4. Initialize `config.local.ps1` and `providers.json` from examples.
5. Set the `TABIPOOL_HOME` environment variable and add `tabipool` to your user `PATH`.
6. Install and start the background Windows service (starts at boot).

---

## CLI Commands

The `tabipool` CLI is available globally from any command prompt or PowerShell:

- `tabipool web` — Open the dashboard in your default browser (starts the background service if not answering).
- `tabipool status` — View proxy health, active pool balances, uptime, and traffic statistics.
- `tabipool update` — Pull the latest repository changes, update dependencies if lockfile changed, and restart the service (prompts for admin elevation via UAC).
- `tabipool start` / `tabipool stop` / `tabipool restart` — Control the background service (prompts for admin elevation via UAC).
- `tabipool uninstall` — Stop and remove the service, remove `tabipool` from PATH and `TABIPOOL_HOME`, preserving keys and clone directory.
- `tabipool uninstall --purge` — Full uninstaller that removes the service, PATH, environment variable, and deletes the install directory and keys.
- `tabipool help` — Show available commands.

---

## Web Dashboard & Upstream Management

Open `http://127.0.0.1:8787/` (or `tabipool web`):

- **Manage Upstreams:** Add or remove providers directly in the dashboard. Upstreams support manual model lists for gateways with empty `/v1/models` responses.
- **Add API Keys:** Add and validate `sk-` keys against the selected provider before they join the live rotation pool.
- **Live Balances & Drain:** Monitor real-time quota, health, and spend per key.
- **Failover & Blip Absorption:** Requests automatically retry across keys and providers on rate-limits, gateway timeouts, or errors.

---

## API Usage

Point OpenAI- or Anthropic-compatible clients (e.g. Cursor, OpenCode, Aider, LiteLLM) to:
- **Base URL:** `http://127.0.0.1:8787/v1` (or `http://tabi.localhost/v1` if `UI_PORT=80`)
- **API Key / Bearer Token:** Not required (loopback-only; leave empty or pass any dummy string).

---

## Security

The proxy binds exclusively to loopback (`127.0.0.1`). Upstream keys and usage data remain local to your machine and are excluded from git.
