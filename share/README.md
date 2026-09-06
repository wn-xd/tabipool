# Tabipool API Proxy

Key-rotating reverse proxy pool for OpenAI-compatible gateways with automatic failover, balance monitoring, and multi-provider routing. Loopback-only, zero dependencies.

## Setup

1. **Install [Bun](https://bun.sh)** (runtime, required for proxy execution).

2. **Configure local settings:**
   Copy `config.local.ps1.example` to `config.local.ps1` and set your desired configuration:
   ```powershell
   Copy-Item config.local.ps1.example config.local.ps1
   ```
   Edit `config.local.ps1`:
   - `$PROXY_TOKEN`: Set a strong random secret token.
   - `$PORT`: Listening port (default `8787`).
   - `$UI_PORT`: Friendly URL port (e.g. `80` for `http://tabi.localhost/`, or `0` to disable).
   - `$HOST_ADDR`: Bind address (default `127.0.0.1`).

3. **Configure providers:**
   Copy `providers.example.json` to `providers.json`:
   ```powershell
   Copy-Item providers.example.json providers.json
   ```
   Edit `providers.json` to configure your upstream providers and key file associations.

4. **Add API keys:**
   Drop your API keys into `keys.txt` (or the key files specified in `providers.json`), one key per line:
   ```
   sk-...
   sk-...
   ```

5. **Install service or autostart (run elevated / Administrator):**
   Choose one of the two installer options:
   - **Option A (NSSM Service):** Runs as a background Windows service starting at boot:
     ```powershell
     powershell -ExecutionPolicy Bypass -File install-service.ps1
     ```
     Or double-click `install-service.cmd` (self-elevates).
   - **Option B (Scheduled Task):** Runs at user logon without a console window:
     ```powershell
     powershell -ExecutionPolicy Bypass -File install-autostart.ps1
     ```

## Usage

- **Dashboard:** Open `http://127.0.0.1:8787/` (or `http://tabi.localhost/` if `UI_PORT=80`).
- **API Endpoint:** Point OpenAI/Anthropic SDKs or clients to `http://127.0.0.1:8787/v1` with your configured `PROXY_TOKEN` as the Bearer token / API key.
- **Security:** The proxy binds exclusively to loopback (`127.0.0.1`). Your keys, token, and state never leave your local machine.

## Updates

When a new version is pushed to the repository:
1. The web dashboard will display an **"Update available: vX.X.X → vY.Y.Y"** banner with an **Update & restart** button.
2. Clicking the button initiates `update.cmd`, which pulls the latest changes via git, reinstalls dependencies if `bun.lock` changed, and restarts the background service or scheduled task.
3. Your local configuration (`config.local.ps1`), providers (`providers.json`), keys (`keys*.txt`), and runtime state remain untouched and gitignored.
