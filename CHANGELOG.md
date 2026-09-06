# Changelog

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
