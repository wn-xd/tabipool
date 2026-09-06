# Changelog

## 1.0.6
- Resilient startup with empty pool: replaced fatal process exits on missing keys/providers in `loadProviders()` with non-fatal warnings, ensuring the proxy and dashboard always boot so keys and providers can be configured via the web UI.

## 1.0.5
- Fix UTF-8 BOM issue in `register-agents.ps1`: write agent configuration files (opencode, Prime Agent, Continue) in BOM-less UTF-8 via `[System.IO.File]::WriteAllText`, resolving `JSON.parse` syntax errors in Node and JS environments. Added defensive BOM stripping on read.

## 1.0.4
- Agent auto-registration (`tabipool register` + `register-agents.ps1`): automatically detect and configure opencode, Prime Agent, and Continue with live models fetched from `/v1/models`.
- Manual configuration snippets: printed instructions for Aider, Cline, omp, and generic OpenAI-compatible clients.
- Automated registration in `install.ps1`: detect installed agents and register the proxy endpoint post-service installation.
- Dashboard Endpoint card: copyable base URL, API key (`tabipool-local`), live model list with individual copy buttons, and "copy all as JSON".

## 1.0.3
- Zero-friction local operation: removed client-facing proxy token across all endpoints and UI.
- Simplified configuration and installation: loopback-only binding with no client authentication needed.

## 1.0.2
- Dashboard upstream management: add and remove providers directly from the web interface.
- Manual model declarations per provider for gateways returning empty `/v1/models`.
- Global `tabipool` command-line interface (`tabipool web`, `status`, `update`, `start`, `stop`, `restart`, `uninstall`).
- One-line web installer (`install.ps1`) for automated bootstrapping, prerequisite verification, and service installation.
- Clean cutover: retired legacy scripts (`update.cmd`, `install-service.cmd`, `install-autostart.ps1`) in favor of unified CLI and installer.

## 1.0.1
- Minor update for testing distribution and in-dashboard update popup.

## 1.0.0
- First distributable release: config/secret split, in-dashboard update popup, git-based distribution.
