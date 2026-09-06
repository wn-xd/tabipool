#!/usr/bin/env bun
export {};
/**
 * tabitoken key-rotating reverse proxy.
 *
 * Spreads requests across a pool of independent tabitoken accounts (one `sk-` token
 * each) and fails over automatically. Loopback-only, zero dependencies.
 *
 * Behaviours below are not guesses; each was measured against the live gateway.
 * See the CLASSIFY table for the reasoning behind every status-code decision.
 */

/** Single-source release marker; also the file the update-check compares against origin. */
let VERSION = "0.0.0";
try {
  VERSION = (await Bun.file(new URL("VERSION", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).text()).trim();
} catch {}

const UPSTREAM = process.env.UPSTREAM ?? "https://tabitoken.com";
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
/** Friendly-URL listener for http://tabi.localhost/ . 0 disables it. */
const UI_PORT = Number(process.env.UI_PORT ?? 80);
const PROXY_TOKEN = process.env.PROXY_TOKEN ?? "";
const KEYS_FILE = process.env.KEYS_FILE ?? "keys.txt";
const STATE_FILE = process.env.STATE_FILE ?? "state.json";
const LOG_FILE = process.env.LOG_FILE ?? "requests.jsonl";
/** Optional per-key credit ceilings; upstream never reports them. */
const CREDITS_FILE = process.env.CREDITS_FILE ?? "credits.json";
/** Multi-provider routing table; absent => single provider from UPSTREAM/KEYS_FILE. */
const PROVIDERS_FILE = process.env.PROVIDERS_FILE ?? "providers.json";
const DASHBOARD_FILE = new URL("dashboard.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
/** Historical state files surfaced read-only in the dashboard: [label, file]. */
const ARCHIVE_STATES: [string, string][] = [
  ["tabitoken", "state.json"],
  ["justwoker", "state-justwoker.json"],
];
/** Neutral desktop UA: avoids Cloudflare's case-sensitive client-tool denylist. */
const OUTBOUND_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Period-4 origin blip means 4 attempts always covers one clean slot. */
const MAX_ATTEMPTS = 4;
/** Two verified `Invalid token` 401s before a key is written off. */
const KILL_THRESHOLD = 2;
/** A wallet that reports empty may be topped up later, so cool rather than kill. */
const COOL_QUOTA_MS = 6 * 60 * 60 * 1000;
/** 429 without Retry-After is account-scoped; rotation escapes it. */
const COOL_RATELIMIT_MS = 20_000;
const COOL_NETWORK_MS = 10_000;
/** Never let a transient upstream wobble retire the whole pool. */
const MAX_KILL_FRACTION = 0.5;
/** new-api quota units per USD (common.QuotaPerUnit). Used to convert quota -> USD. */
const QUOTA_PER_UNIT = 500_000;
/** Health verdicts older than this are re-examined instead of trusted. */
const HEALTH_TTL_MS = 10 * 60 * 1000;
/** Near-fixed per-request cost: the gateway injects a ~7k-token system prompt. */
const EST_REQUEST_CENTS = 80;
const DEFAULT_INITIAL_CENTS = 12_000;
/** How often to re-read authoritative quota from upstream. */
const BALANCE_POLL_MS = 10 * 60 * 1000;
/**
 * How often to re-probe each provider's model list. Deliberately much shorter than the
 * balance poll: a provider losing or regaining its Claude channel is the failure this
 * pool exists to route around, and the probe is one cheap GET per provider.
 */
const MODEL_POLL_MS = 60 * 1000;
const UPDATE_POLL_MS = 15 * 60 * 1000;

let updateInfo: { available: boolean; latest: string; behind: number } = { available: false, latest: VERSION, behind: 0 };
const REPO_DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
async function checkForUpdate() {
  try {
    await Bun.spawn(["git", "fetch", "--quiet"], { cwd: REPO_DIR }).exited;
    const behindProc = Bun.spawn(["git", "rev-list", "--count", "HEAD..@{u}"], { cwd: REPO_DIR, stdout: "pipe" });
    const behind = Number((await new Response(behindProc.stdout).text()).trim()) || 0;
    let latest = VERSION;
    if (behind > 0) {
      const vProc = Bun.spawn(["git", "show", "@{u}:VERSION"], { cwd: REPO_DIR, stdout: "pipe" });
      latest = (await new Response(vProc.stdout).text()).trim() || VERSION;
    }
    updateInfo = { available: behind > 0, latest, behind };
  } catch { /* no remote / offline / not a repo: leave updateInfo as-is */ }
}

const HOP_BY_HOP: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  // Bun's fetch auto-decompresses, so a forwarded content-encoding would
  // label plaintext as gzip and the client would die with ZlibError.
  "content-encoding": true,
  "content-length": true,
  host: true,
};

type Key = {
  id: number;
  key: string;
  tail: string;
  /** Which provider this key authenticates against. */
  provider: string;
  initialCents: number;
  /** Authoritative cumulative spend, in cents, from the upstream billing poll. */
  spendCents: number;
  /** Requests since the last poll, used to estimate spend between polls. */
  sincePoll: number;
  requests: number;
  failures: number;
  blips: number;
  inflight: number;
  dead: boolean;
  killEvidence: number;
  coolUntil: number;
  lastError: string | null;
  lastUsed: number;
  /** True when upstream reports unlimited_quota: no ceiling exists, so no "remaining". */
  unlimited: boolean;
};

/** One upstream gateway plus the key pool that authenticates against it. */
type Provider = {
  name: string;
  upstream: string;
  keysFile: string;
  enabled: boolean;
  /** Model ids this provider serves, learned from its own /v1/models. */
  models: Set<string>;
  /**
   * Model ids declared by config/UI. Some gateways answer chat requests but return an
   * empty /v1/models, so discovery alone finds nothing; these are merged in unconditionally
   * and let a request route even when the upstream will not enumerate its own models.
   */
  manualModels: string[];
  lastError: string | null;
};

const providers: Provider[] = [];

/** model id -> provider name. First provider to claim a model wins. */
const modelOwner = new Map<string, string>();

const providerByName = (name: string) => providers.find((p) => p.name === name);

/** One row per client-visible request outcome. Ring buffer, flushed to JSONL. */
type ReqLog = {
  t: number;
  key: string;
  model: string;
  path: string;
  status: number;
  ms: number;
  attempts: number;
  blips: number;
  stream: boolean;
  action: string;
};

/** Pool-wide spend sample taken at each billing poll; the money source of truth. */
type SpendSample = { t: number; spentCents: number; perKey: Record<string, number> };

const keys: Key[] = [];
let lastPickedId = -1;
/** The one limit rotation cannot dodge: CriticalRateLimit keys on client IP. */
let ipPauseUntil = 0;
let killWindowStart = Date.now();
let killsInWindow = 0;

const RECENT_MAX = 2000;
const recent: ReqLog[] = [];
const spendHistory: SpendSample[] = [];
const startedAt = Date.now();
/** Buffered JSONL appends so per-request logging never blocks a response. */
let logQueue: ReqLog[] = [];

function record(row: ReqLog) {
  recent.push(row);
  if (recent.length > RECENT_MAX) recent.shift();
  logQueue.push(row);
}

async function flushLog() {
  if (!logQueue.length) return;
  const batch = logQueue;
  logQueue = [];
  try {
    const lines = batch.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const f = Bun.file(LOG_FILE);
    const prev = (await f.exists()) ? await f.text() : "";
    await Bun.write(LOG_FILE, prev + lines);
  } catch (e) {
    console.warn(`log flush failed: ${(e as Error).message}`);
  }
}

/** Replays today's JSONL so a restart does not blank the dashboard. */
async function loadLog() {
  const f = Bun.file(LOG_FILE);
  if (!(await f.exists())) return;
  try {
    const lines = (await f.text()).split("\n").filter(Boolean);
    for (const line of lines.slice(-RECENT_MAX)) {
      try {
        recent.push(JSON.parse(line) as ReqLog);
      } catch {
        /* skip malformed row */
      }
    }
  } catch (e) {
    console.warn(`log load failed: ${(e as Error).message}`);
  }
}

/** Per-tail credit overrides from credits.json, which wins over the CSV. */
let creditDefaultCents = DEFAULT_INITIAL_CENTS;
const creditByTail = new Map<string, number>();

async function loadCreditOverrides() {
  const f = Bun.file(CREDITS_FILE);
  if (!(await f.exists())) return;
  try {
    const j = JSON.parse(await f.text()) as { defaultUsd?: number; byTail?: Record<string, number> };
    if (Number.isFinite(j.defaultUsd)) creditDefaultCents = Math.round(j.defaultUsd! * 100);
    for (const [tail, usd] of Object.entries(j.byTail ?? {})) {
      if (Number.isFinite(usd)) creditByTail.set(tail, Math.round(usd * 100));
    }
  } catch (e) {
    console.warn(`${CREDITS_FILE} unreadable: ${(e as Error).message}`);
  }
}

async function loadInitialCredits(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const f = Bun.file("usage-by-key.csv");
  if (!(await f.exists())) return out;
  const text = await f.text();
  for (const line of text.split("\n").slice(1)) {
    const cols = line.split(",");
    if (cols.length < 2) continue;
    const key = cols[0]!.replace(/^"|"$/g, "").trim();
    const credit = Number(cols[1]);
    if (key && Number.isFinite(credit)) out.set(key, Math.round(credit * 100));
  }
  return out;
}

/**
 * Adds keys to the live pool, skipping duplicates. Shared by startup load and the
 * runtime add endpoint so both paths produce identically-shaped entries.
 * Returns the tails actually added.
 */
function addKeys(rawKeys: string[], credits: Map<string, number>, provider: string): string[] {
  const added: string[] = [];
  for (const key of rawKeys) {
    if (keys.some((k) => k.key === key)) continue;
    keys.push({
      id: keys.length,
      key,
      tail: key.slice(-5),
      provider,
      // credits.json wins over the CSV, which wins over the flat default.
      initialCents: creditByTail.get(key.slice(-5)) ?? credits.get(key) ?? creditDefaultCents,
      spendCents: 0,
      sincePoll: 0,
      requests: 0,
      failures: 0,
      blips: 0,
      inflight: 0,
      dead: false,
      killEvidence: 0,
      coolUntil: 0,
      lastError: null,
      lastUsed: 0,
      unlimited: false,
    });
    added.push(key.slice(-5));
  }
  return added;
}

/**
 * Loads providers.json and each provider's key pool. Falls back to a single provider
 * built from the UPSTREAM/KEYS_FILE env vars, so an existing single-gateway setup keeps
 * working untouched.
 */
async function loadProviders() {
  const credits = await loadInitialCredits();
  const f = Bun.file(PROVIDERS_FILE);

  if (await f.exists()) {
    try {
      const cfg = JSON.parse(await f.text()) as {
        providers?: { name?: string; upstream?: string; keysFile?: string; enabled?: boolean; models?: string[] }[];
      };
      for (const p of cfg.providers ?? []) {
        if (!p.name || !p.upstream || !p.keysFile) continue;
        if (p.enabled === false) continue;
        // A provider may exist before it has keys: added via the UI, keys pasted after.
        // Load it anyway so it shows in the dashboard and can receive keys, rather than
        // silently vanishing on the next restart.
        const kf = Bun.file(p.keysFile);
        const raw = (await kf.exists())
          ? (await kf.text()).split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))
          : [];
        providers.push({
          name: p.name,
          upstream: p.upstream.replace(/\/+$/, ""),
          keysFile: p.keysFile,
          enabled: true,
          models: new Set(),
          manualModels: (p.models ?? []).map((m) => String(m).trim()).filter(Boolean),
          lastError: null,
        });
        const n = addKeys(raw, credits, p.name).length;
        console.log(`[provider] ${p.name} -> ${p.upstream} (${n} keys${p.models?.length ? `, ${p.models.length} declared models` : ""})`);
      }
    } catch (e) {
      console.warn(`${PROVIDERS_FILE} unreadable: ${(e as Error).message}`);
    }
  }

  if (!providers.length) {
    const kf = Bun.file(KEYS_FILE);
    if (!(await kf.exists())) {
      console.error(`fatal: no providers configured and ${KEYS_FILE} not found`);
      process.exit(1);
    }
    const raw = (await kf.text()).split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    providers.push({
      name: "default",
      upstream: UPSTREAM.replace(/\/+$/, ""),
      keysFile: KEYS_FILE,
      enabled: true,
      models: new Set(),
      manualModels: [],
      lastError: null,
    });
    addKeys(raw, credits, "default");
    console.log(`[provider] default -> ${UPSTREAM} (${keys.length} keys)`);
  }

  if (!keys.length) {
    console.error("fatal: no keys loaded from any provider");
    process.exit(1);
  }
}

/** Appends new keys to a provider's key file so a restart keeps them. */
async function persistKeysFile(newKeys: string[], file: string) {
  const f = Bun.file(file);
  const prev = (await f.exists()) ? await f.text() : "";
  const sep = prev.length && !prev.endsWith("\n") ? "\n" : "";
  await Bun.write(file, prev + sep + newKeys.join("\n") + "\n");
}

/** Rewrites every provider's key file from the live pool, used after a removal. */
async function rewriteKeysFiles() {
  for (const p of providers) {
    const own = keys.filter((k) => k.provider === p.name).map((k) => k.key);
    await Bun.write(p.keysFile, own.length ? own.join("\n") + "\n" : "");
  }
}

/**
 * Rewrites providers.json from the live provider set, so upstreams added or removed via
 * the UI survive a restart. The `_comment` field is preserved if the file already had one.
 */
async function saveProviders() {
  const f = Bun.file(PROVIDERS_FILE);
  let comment: string | undefined;
  if (await f.exists()) {
    try {
      const prior = JSON.parse(await f.text()) as { _comment?: string };
      comment = prior._comment;
    } catch { /* unreadable prior file: write without a comment */ }
  }
  const out = {
    ...(comment ? { _comment: comment } : {}),
    providers: providers.map((p) => ({
      name: p.name,
      upstream: p.upstream,
      keysFile: p.keysFile,
      enabled: p.enabled,
      ...(p.manualModels.length ? { models: p.manualModels } : {}),
    })),
  };
  await Bun.write(PROVIDERS_FILE, JSON.stringify(out, null, 2) + "\n");
}

/**
 * Spend counters persist; health verdicts deliberately do not. A "dead" flag that
 * outlives a transient outage would lock the pool out permanently and silently.
 */
async function loadState() {
  const f = Bun.file(STATE_FILE);
  if (!(await f.exists())) return;
  try {
    const s = JSON.parse(await f.text());
    const fresh = Date.now() - (s.savedAt ?? 0) < HEALTH_TTL_MS;
    for (const rec of s.keys ?? []) {
      const k = keys.find((x) => x.tail === rec.tail);
      if (!k) continue;
      k.spendCents = rec.spendCents ?? 0;
      k.requests = rec.requests ?? 0;
      if (fresh && rec.dead) k.dead = true;
    }
    for (const sample of s.spendHistory ?? []) spendHistory.push(sample as SpendSample);
  } catch (e) {
    console.warn(`state load failed, starting clean: ${(e as Error).message}`);
  }
}

/**
 * Read-only summaries of other upstreams' state files, so switching gateways does not
 * make prior spend history vanish from the dashboard.
 */
type Archive = {
  label: string;
  file: string;
  savedAt: number;
  keys: number;
  spentUsd: number;
  spendHistory: { t: number; spentUsd: number }[];
  top: { tail: string; spentUsd: number; requests: number }[];
};
const archives: Archive[] = [];

async function loadArchives() {
  for (const [label, file] of ARCHIVE_STATES) {
    if (file === STATE_FILE) continue; // that one is live, not an archive
    const f = Bun.file(file);
    if (!(await f.exists())) continue;
    try {
      const s = JSON.parse(await f.text()) as {
        savedAt?: number;
        keys?: { tail: string; spendCents?: number; requests?: number }[];
        spendHistory?: { t: number; spentCents: number }[];
      };
      const ks = s.keys ?? [];
      archives.push({
        label,
        file,
        savedAt: s.savedAt ?? 0,
        keys: ks.length,
        spentUsd: +(ks.reduce((a, k) => a + (k.spendCents ?? 0), 0) / 100).toFixed(2),
        spendHistory: (s.spendHistory ?? []).map((h) => ({ t: h.t, spentUsd: +(h.spentCents / 100).toFixed(2) })),
        top: ks
          .map((k) => ({ tail: k.tail, spentUsd: +((k.spendCents ?? 0) / 100).toFixed(2), requests: k.requests ?? 0 }))
          .sort((a, b) => b.spentUsd - a.spentUsd)
          .slice(0, 10),
      });
    } catch (e) {
      console.warn(`archive ${file} unreadable: ${(e as Error).message}`);
    }
  }
}

let saveQueued = false;
function saveState() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(async () => {
    saveQueued = false;
    const body = {
      savedAt: Date.now(),
      keys: keys.map((k) => ({
        tail: k.tail,
        spendCents: k.spendCents,
        requests: k.requests,
        dead: k.dead,
      })),
      // Kept so the spend chart has history immediately after a restart.
      spendHistory: spendHistory.slice(-500),
    };
    try {
      await Bun.write(STATE_FILE, JSON.stringify(body, null, 2));
    } catch (e) {
      console.warn(`state save failed: ${(e as Error).message}`);
    }
  }, 1000);
}

function effectiveCents(k: Key) {
  return k.spendCents + k.sincePoll * EST_REQUEST_CENTS;
}

/** Fraction of the wallet consumed. Draining by fraction empties unequal wallets together. */
function usedFraction(k: Key) {
  return k.initialCents > 0 ? effectiveCents(k) / k.initialCents : 1;
}

function available(now: number, provider?: string | null) {
  return keys.filter((k) => !k.dead && k.coolUntil <= now && (!provider || k.provider === provider));
}

/**
 * Least-used selection, by fraction of wallet spent.
 *
 * Uniform random is what produced the observed $9.50-$72.90 drain spread; least-used
 * also self-heals after a key sits in cooldown, which round-robin cannot. Consecutive
 * reuse is avoided because the origin's bodyless-403 counter is per-key, so alternating
 * keys sidesteps the blip instead of absorbing it.
 */
function pickKey(exclude: Set<number>, now: number, provider?: string | null): Key | null {
  let pool = available(now, provider).filter((k) => !exclude.has(k.id));
  if (!pool.length) return null;
  if (pool.length > 1) {
    const alt = pool.filter((k) => k.id !== lastPickedId);
    if (alt.length) pool = alt;
  }
  const minInflight = Math.min(...pool.map((k) => k.inflight));
  const idle = pool.filter((k) => k.inflight === minInflight);
  idle.sort((a, b) => usedFraction(a) - usedFraction(b) || a.lastUsed - b.lastUsed);
  return idle[0]!;
}

type Action =
  | "OK"
  | "BLIP" // infra noise: retry elsewhere, never blame the key
  | "KEY_DEAD"
  | "KEY_QUOTA"
  | "KEY_THROTTLED"
  | "IP_THROTTLED"
  | "CF_BLOCK"
  | "GATEWAY_RETRY"
  | "CLIENT_FAIL"; // caller's payload: returning it unchanged is the whole job

/**
 * `x-oneapi-request-id` is set unconditionally by new-api ahead of all routes and is
 * never overwritten from upstream. Present => the gateway itself answered, so the
 * status is a real verdict. Absent => something in front answered, whatever the code.
 * Key health may only be updated when that header is present.
 */
function classify(status: number, headers: Headers, body: string): Action {
  const gw = !!(headers.get("x-oneapi-request-id") || headers.get("x-request-id"));
  const ct = (headers.get("content-type") ?? "").toLowerCase();
  const isHtml = ct.includes("text/html") || /^\s*<(?:!doctype|html)/i.test(body);

  // Retry-After is the strongest signal available and MUST be honoured before any
  // body sniffing: Cloudflare serves its rate-limit page as HTML, so checking for
  // HTML first misreports a plain "slow down" as an unrecoverable block.
  if (status === 429 && headers.get("retry-after")) return "IP_THROTTLED";
  if (headers.get("cf-mitigated")) return "CF_BLOCK";
  // An HTML body is only a *block* for a 403 with no Retry-After. A 429 that reached
  // here has no Retry-After, so treat it as throttling rather than a block.
  if (!gw && isHtml && status === 403) return "CF_BLOCK";
  if (status >= 200 && status < 300) return "OK";
  if (status === 429) return "IP_THROTTLED";
  // `model_not_found` means no channel serves this model. Every key gets the identical
  // answer, so retrying burns the whole pool on a request that cannot succeed. new-api
  // returns it as 503, which would otherwise look like a transient gateway fault.
  if (/model_not_found|no available channel/i.test(body)) return "CLIENT_FAIL";
  // 502/503/504 are gateway-path failures, shared by every key. Retry, but never
  // attribute them to the key that happened to be selected.
  if (status === 502 || status === 503 || status === 504) return "GATEWAY_RETRY";
  if (!gw) return "BLIP";

  if (status === 401) return /invalid token/i.test(body) ? "KEY_DEAD" : "KEY_THROTTLED";
  if (status === 429) return "KEY_THROTTLED";
  if (/insufficient_user_quota|quota|exhausted/i.test(body) && (status === 403 || status === 402))
    return "KEY_QUOTA";
  // new-api answers malformed requests with 500 + code:invalid_request. Rotating on
  // that would burn all 30 keys on a request that can never succeed.
  if (/invalid_request|sensitive_words_detected/i.test(body)) return "CLIENT_FAIL";
  if (status === 400 || status === 404 || status === 405) return "CLIENT_FAIL";
  return "GATEWAY_RETRY";
}

function killKey(k: Key, reason: string) {
  const now = Date.now();
  if (now - killWindowStart > 5 * 60 * 1000) {
    killWindowStart = now;
    killsInWindow = 0;
  }
  const live = keys.filter((x) => !x.dead).length;
  // A pool-wide 401 storm is an upstream event, not 30 simultaneously revoked keys.
  if (killsInWindow + 1 > Math.max(1, Math.floor(live * MAX_KILL_FRACTION))) {
    k.coolUntil = now + 5 * 60 * 1000;
    k.lastError = `${reason} (mass-kill guard: cooled, not killed)`;
    console.warn(`[pool] mass-kill guard tripped; cooling ...${k.tail} instead of killing`);
    return;
  }
  killsInWindow++;
  k.dead = true;
  k.lastError = reason;
  console.warn(`[pool] key ...${k.tail} marked dead: ${reason}`);
  saveState();
}

function buildUpstreamHeaders(req: Request, key: string): Headers {
  const h = new Headers();
  for (const [name, value] of req.headers) {
    const n = name.toLowerCase();
    if (HOP_BY_HOP[n]) continue;
    if (n === "authorization" || n === "x-api-key") continue;
    // Let Bun negotiate its own encoding so decompression stays consistent.
    if (n === "accept-encoding") continue;
    // Cloudflare denylists `curl/*`, `python-requests/*`, `lwp`, and similar
    // substrings case-sensitively. Forwarding a client UA that matches gets a 403
    // HTML block, so every outbound request carries one neutral UA instead.
    if (n === "user-agent") continue;
    h.set(name, value);
  }
  h.set("user-agent", OUTBOUND_UA);
  // Both auth styles are interchangeable on this gateway; send the one the
  // caller used so Anthropic-native clients keep working.
  if (req.headers.has("x-api-key")) h.set("x-api-key", key);
  else h.set("authorization", `Bearer ${key}`);
  return h;
}

function clientAuthorized(req: Request): boolean {
  if (!PROXY_TOKEN) return true;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const apiKey = req.headers.get("x-api-key")?.trim();
  return bearer === PROXY_TOKEN || apiKey === PROXY_TOKEN;
}

function jsonError(status: number, message: string, type = "proxy_error") {
  return Response.json({ error: { message, type, code: "" } }, { status });
}

/**
 * Learns which models each provider serves by calling its own /v1/models with one of
 * its keys, and rebuilds the model -> provider map that routes requests. First provider
 * to claim a model id owns it, so providers.json order is the precedence.
 *
 * A provider whose probe fails keeps its previously known model set. Dropping it would
 * hand its models to another provider that does not serve them, silently misrouting the
 * request instead of returning the upstream's own error.
 */
async function discoverModels() {
  for (const p of providers) {
    const k = keys.find((x) => x.provider === p.name && !x.dead);
    if (!k) {
      p.lastError = "no live keys";
      continue;
    }
    try {
      const r = await fetch(`${p.upstream}/v1/models`, {
        headers: { authorization: `Bearer ${k.key}`, "user-agent": OUTBOUND_UA },
        signal: AbortSignal.timeout(25_000),
      });
      if (r.status !== 200) {
        p.lastError = `models ${r.status}`;
        continue;
      }
      const j = (await r.json()) as { data?: { id?: string }[] };
      const ids = (j.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
      // An empty list is a real answer (upstream has no channel), so it replaces the
      // set; a failed probe above does not. Manual models cover gateways that serve
      // chat but return an empty /v1/models.
      p.models = new Set(ids);
      p.lastError = ids.length || p.manualModels.length ? null : "no models served";
    } catch (e) {
      p.lastError = (e as Error).message.slice(0, 80);
    }
  }

  modelOwner.clear();
  for (const p of providers) {
    for (const id of p.models) if (!modelOwner.has(id)) modelOwner.set(id, p.name);
    for (const id of p.manualModels) if (!modelOwner.has(id)) modelOwner.set(id, p.name);
  }

  const summary = providers
    .map((p) => `${p.name}=${p.models.size}${p.lastError ? `(${p.lastError})` : ""}`)
    .join("  ");
  console.log(`[models] ${modelOwner.size} routable  ${summary}`);
}

/**
 * Reads authoritative per-key quota from each provider's `GET /api/usage/token/`.
 * That is the only endpoint reachable with an `sk-` key that reports real quota
 * (controller/token.go GetTokenUsage, behind TokenAuthReadOnly). It sits behind an
 * IP-scoped CriticalRateLimit, so this is serial with spacing and falls back to the
 * cheap billing endpoint when throttled.
 */
async function pollBalances() {
  let throttled = false;
  for (const k of keys) {
    const up = providerByName(k.provider)?.upstream ?? UPSTREAM;
    if (!throttled) {
      try {
        const r = await fetch(`${up}/api/usage/token/`, {
          headers: { authorization: `Bearer ${k.key}`, "user-agent": OUTBOUND_UA },
          signal: AbortSignal.timeout(20_000),
        });
        if (r.status === 429) {
          throttled = true; // IP-scoped: every remaining key would fail too
        } else if (r.status === 200) {
          const j = (await r.json()) as {
            data?: { total_used?: number; total_available?: number; total_granted?: number; unlimited_quota?: boolean };
          };
          const d = j.data ?? {};
          if (typeof d.total_used === "number") {
            k.spendCents = Math.round((d.total_used / QUOTA_PER_UNIT) * 100);
            k.sincePoll = 0;
          }
          k.unlimited = d.unlimited_quota === true;
          // Only a genuinely capped token has a knowable ceiling.
          if (!k.unlimited && typeof d.total_granted === "number" && d.total_granted > 0) {
            k.initialCents = Math.round((d.total_granted / QUOTA_PER_UNIT) * 100);
          }
          if (k.dead) {
            k.dead = false;
            k.killEvidence = 0;
            k.lastError = null;
            console.log(`[pool] key ...${k.tail} revived`);
          }
          k.coolUntil = 0;
          await Bun.sleep(150);
          continue;
        }
      } catch {
        /* fall through to the billing endpoint */
      }
    }
    // Fallback: spend only, but not IP-rate-limited.
    try {
      const r = await fetch(`${up}/v1/dashboard/billing/usage`, {
        headers: { authorization: `Bearer ${k.key}`, "user-agent": OUTBOUND_UA },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status === 200) {
        const j = (await r.json()) as { total_usage?: number };
        if (typeof j.total_usage === "number") {
          k.spendCents = j.total_usage;
          k.sincePoll = 0;
        }
        if (k.dead) {
          k.dead = false;
          k.killEvidence = 0;
          k.lastError = null;
          console.log(`[pool] key ...${k.tail} revived`);
        }
        k.coolUntil = 0;
      } else if (r.status === 401) {
        const body = await r.text();
        if (/invalid token/i.test(body) && !k.dead) {
          k.killEvidence++;
          if (k.killEvidence >= KILL_THRESHOLD) killKey(k, "401 on balance poll");
        }
      }
    } catch {
      /* transient; next poll decides */
    }
  }
  const perKey: Record<string, number> = {};
  for (const k of keys) perKey[k.tail] = k.spendCents;
  spendHistory.push({
    t: Date.now(),
    spentCents: keys.reduce((a, k) => a + k.spendCents, 0),
    perKey,
  });
  if (spendHistory.length > 500) spendHistory.shift();
  saveState();
}

async function handleProxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const now = Date.now();

  if (ipPauseUntil > now) {
    const secs = Math.ceil((ipPauseUntil - now) / 1000);
    return new Response(
      JSON.stringify({
        error: {
          message: `upstream IP-level rate limit active, retry in ${secs}s`,
          type: "proxy_ip_throttled",
        },
      }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": String(secs) } },
    );
  }

  const hasBody = !["GET", "HEAD"].includes(req.method);
  // Buffered because a retry on another key must replay it. LLM request bodies are
  // small, and this is what makes pre-first-byte failover possible at all.
  const body = hasBody ? await req.arrayBuffer() : undefined;

  // Read from the buffered copy only; the upstream body is never re-serialized.
  let model = "unknown";
  let isStream = false;
  if (body) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body)) as { model?: string; stream?: boolean };
      if (typeof parsed.model === "string") model = parsed.model;
      isStream = parsed.stream === true;
    } catch {
      /* non-JSON body: leave defaults */
    }
  }

  // Route by model: only keys belonging to the provider that serves this model are
  // eligible. Unknown model -> any provider, so a client can still reach a model that
  // discovery has not seen yet (upstream decides whether it is routable).
  const owner = modelOwner.get(model) ?? null;

  const t0 = Date.now();
  let blipCount = 0;
  const tried = new Set<number>();
  let lastStatus = 502;
  let lastBody = "";
  let lastAction: Action = "GATEWAY_RETRY";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const key = pickKey(tried, Date.now(), owner);
    if (!key) {
      // Pool momentarily empty. Cooldowns are the usual cause and they may be the
      // residue of a network outage rather than real key faults, so clear expired
      // cooldowns and retry once before failing the caller.
      if (!available(Date.now()).length) {
        const now2 = Date.now();
        for (const k of keys) if (k.coolUntil > now2 && k.coolUntil - now2 > COOL_QUOTA_MS) k.coolUntil = 0;
        if (!available(Date.now()).length) {
          return jsonError(
            503,
            `no selectable keys right now (${keys.filter((k) => k.dead).length} dead, ` +
              `${keys.filter((k) => k.coolUntil > Date.now()).length} cooling of ${keys.length})`,
            "proxy_pool_exhausted",
          );
        }
        continue;
      }
      break;
    }
    tried.add(key.id);
    lastPickedId = key.id;
    key.inflight++;
    key.lastUsed = Date.now();

    const ac = new AbortController();
    // Without this an abandoned client leaves the upstream stream running and billing.
    const onAbort = () => ac.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const base = providerByName(key.provider)?.upstream ?? UPSTREAM;
      const upstream = await fetch(`${base}${url.pathname}${url.search}`, {
        method: req.method,
        headers: buildUpstreamHeaders(req, key.key),
        body: body ? body.slice(0) : undefined,
        signal: ac.signal,
        redirect: "manual",
      });

      // fetch resolves at headers, so every classification below happens before a
      // single byte reaches the client: retrying here can never duplicate output.
      if (upstream.ok) {
        const action = classify(upstream.status, upstream.headers, "");
        if (action === "OK") {
          key.requests++;
          key.sincePoll++;
          saveState();
          record({
            t: t0,
            key: key.tail,
            model,
            path: url.pathname,
            status: upstream.status,
            ms: Date.now() - t0,
            attempts: attempt + 1,
            blips: blipCount,
            stream: isStream,
            action: "OK",
          });
          const h = new Headers();
          for (const [n, v] of upstream.headers) if (!HOP_BY_HOP[n.toLowerCase()]) h.set(n, v);
          h.set("x-proxy-key", `...${key.tail}`);
          h.set("x-proxy-attempt", String(attempt + 1));
          req.signal.removeEventListener("abort", onAbort);
          // Streamed through untouched: /v1/messages frames with \n\n\n, carries no
          // [DONE], and thinking blocks hold opaque signatures. Never re-serialize.
          return new Response(upstream.body, { status: upstream.status, headers: h });
        }
      }

      const text = await upstream.text();
      const action = classify(upstream.status, upstream.headers, text);
      lastStatus = upstream.status;
      lastBody = text;
      lastAction = action;

      switch (action) {
        case "BLIP":
          key.blips++;
          blipCount++;
          console.log(`[blip] ...${key.tail} ${upstream.status} attempt=${attempt + 1}`);
          // The blip is a per-key periodic counter, so rotating dodges it. With a pool
          // too small to rotate, the same key must stay eligible or the loop exhausts
          // after one attempt and a transient blip looks like an unroutable model.
          if (keys.length <= MAX_ATTEMPTS) tried.delete(key.id);
          continue;
        case "KEY_DEAD":
          key.killEvidence++;
          key.failures++;
          key.lastError = "401 invalid token";
          if (key.killEvidence >= KILL_THRESHOLD) killKey(key, "401 invalid token");
          else key.coolUntil = Date.now() + 60_000;
          continue;
        case "KEY_QUOTA":
          // Each key is its own account, so a dry wallet is this key's problem only.
          key.coolUntil = Date.now() + COOL_QUOTA_MS;
          key.lastError = "wallet exhausted";
          console.warn(`[pool] ...${key.tail} wallet exhausted, cooling 6h`);
          continue;
        case "KEY_THROTTLED": {
          const ra = Number(upstream.headers.get("retry-after"));
          key.coolUntil = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : COOL_RATELIMIT_MS);
          key.lastError = `throttled ${upstream.status}`;
          continue;
        }
        case "IP_THROTTLED": {
          const ra = Number(upstream.headers.get("retry-after")) || 60;
          // A short window is worth waiting out in-request: the caller gets a slow
          // success instead of an error it would only retry itself. Long windows are
          // surfaced so the client can back off properly.
          if (ra <= 15 && attempt < MAX_ATTEMPTS - 1) {
            console.warn(`[pool] IP rate limit, waiting ${ra}s (attempt ${attempt + 1})`);
            await Bun.sleep(ra * 1000 + 250);
            tried.delete(key.id); // not this key's fault; it stays eligible
            continue;
          }
          ipPauseUntil = Date.now() + ra * 1000;
          console.warn(`[pool] IP-level rate limit; pausing all traffic ${ra}s`);
          return new Response(
            JSON.stringify({
              error: { message: `upstream IP rate limit, retry in ${ra}s`, type: "proxy_ip_throttled" },
            }),
            {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": String(ra) },
            },
          );
        }
        case "CF_BLOCK":
          console.error(`[pool] edge block detected (status ${upstream.status}) - not a key fault`);
          return jsonError(502, "upstream edge blocked the request", "proxy_edge_blocked");
        case "CLIENT_FAIL": {
          const h = new Headers({ "content-type": upstream.headers.get("content-type") ?? "application/json" });
          h.set("x-proxy-key", `...${key.tail}`);
          record({
            t: t0,
            key: key.tail,
            model,
            path: url.pathname,
            status: upstream.status,
            ms: Date.now() - t0,
            attempts: attempt + 1,
            blips: blipCount,
            stream: isStream,
            action: "CLIENT_FAIL",
          });
          return new Response(text, { status: upstream.status, headers: h });
        }
        default:
          // Gateway-path failure: shared by every key, so record it for visibility but
          // do not count it against this key's health or the pool empties on an outage.
          key.lastError = `gateway ${upstream.status}`;
          await Bun.sleep(Math.random() * Math.min(4000, 400 * 2 ** attempt));
          continue;
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (req.signal.aborted) return new Response(null, { status: 499 });
      // A connect/DNS failure means OUR network is down, not that this key is bad.
      // Cooling keys here used to empty the pool during an outage and keep it empty
      // after the network returned, so only note the error and retry.
      key.lastError = msg.slice(0, 120);
      lastAction = "GATEWAY_RETRY";
      lastBody = msg;
      lastStatus = 503;
      await Bun.sleep(Math.random() * Math.min(4000, 400 * 2 ** attempt));
      continue;
    } finally {
      key.inflight--;
      req.signal.removeEventListener("abort", onAbort);
    }
  }

  const finalStatus = lastAction === "BLIP" ? 400 : lastStatus;
  record({
    t: t0,
    key: "-",
    model,
    path: url.pathname,
    status: finalStatus,
    ms: Date.now() - t0,
    attempts: tried.size,
    blips: blipCount,
    stream: isStream,
    action: lastAction,
  });

  // Every attempt hit the bodyless 403. With a multi-key pool that means the model is
  // genuinely unroutable; with a small pool it may just be the periodic blip, so the
  // message must not assert a cause it cannot prove.
  if (lastAction === "BLIP") {
    const many = keys.length > MAX_ATTEMPTS;
    return jsonError(
      many ? 400 : 503,
      many
        ? "upstream rejected this request on every key; the model name is most likely not routable"
        : `upstream returned an empty 403 on all ${tried.size || 1} attempt(s); model may be unroutable or the gateway is rate-limiting a single-key pool`,
      many ? "proxy_unroutable" : "proxy_upstream_rejected",
    );
  }
  // Never hand back a Cloudflare HTML page: clients expect JSON and an HTML body
  // shows up as an opaque hang rather than a readable error.
  const looksHtml = /^\s*<(?:!doctype|html)/i.test(lastBody);
  if (!lastBody || looksHtml) {
    return jsonError(
      503,
      `upstream unreachable after ${tried.size} attempt(s) - gateway or network problem, keys are fine`,
      "proxy_upstream_unreachable",
    );
  }
  return new Response(lastBody, {
    status: lastStatus,
    headers: { "content-type": "application/json" },
  });
}

function poolSnapshot() {
  const now = Date.now();
  return {
    upstream: providers.map((p) => p.upstream).join(", "),
    providers: providers.map((p) => {
      const own = keys.filter((k) => k.provider === p.name);
      const allModels = Array.from(new Set([...p.models, ...p.manualModels]));
      return {
        name: p.name,
        upstream: p.upstream,
        models: allModels.length,
        modelList: allModels,
        keys: own.length,
        live: own.filter((k) => !k.dead && k.coolUntil <= now).length,
        remainingUsd: +(
          own.reduce((a, k) => a + Math.max(0, k.initialCents - effectiveCents(k)), 0) / 100
        ).toFixed(2),
        lastError: p.lastError,
      };
    }),
    ipPaused: ipPauseUntil > now ? Math.ceil((ipPauseUntil - now) / 1000) : 0,
    live: keys.filter((k) => !k.dead && k.coolUntil <= now).length,
    total: keys.length,
    spentUsd: +(keys.reduce((a, k) => a + effectiveCents(k), 0) / 100).toFixed(2),
    remainingUsd: +(
      keys.reduce((a, k) => a + Math.max(0, k.initialCents - effectiveCents(k)), 0) / 100
    ).toFixed(2),
    keys: keys.map((k) => ({
      tail: `...${k.tail}`,
      provider: k.provider,
      spentUsd: +(effectiveCents(k) / 100).toFixed(2),
      remainingUsd: +(Math.max(0, k.initialCents - effectiveCents(k)) / 100).toFixed(2),
      usedPct: +(usedFraction(k) * 100).toFixed(1),
      // Upstream spend exceeding the recorded credit means the CSV baseline is stale,
      // not that the wallet is empty. Surfaced so the UI never claims a false $0.00.
      creditStale: effectiveCents(k) > k.initialCents,
      requests: k.requests,
      blips: k.blips,
      failures: k.failures,
      state: k.dead ? "dead" : k.coolUntil > now ? `cool:${Math.ceil((k.coolUntil - now) / 1000)}s` : "ready",
      lastError: k.lastError,
    })),
  };
}

/**
 * Aggregates telemetry for the dashboard. Percentiles come from measured latencies;
 * spend is derived from the authoritative billing poll, never estimated from tokens.
 */
function statsSnapshot(windowMs: number) {
  const now = Date.now();
  const since = now - windowMs;
  const win = recent.filter((r) => r.t >= since);
  const ok = win.filter((r) => r.action === "OK");

  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]! : 0);

  const byModel: Record<string, { requests: number; failures: number; avgMs: number }> = {};
  for (const r of win) {
    const m = (byModel[r.model] ??= { requests: 0, failures: 0, avgMs: 0 });
    m.requests++;
    if (r.action !== "OK") m.failures++;
    m.avgMs += r.ms;
  }
  for (const m of Object.values(byModel)) m.avgMs = Math.round(m.avgMs / Math.max(1, m.requests));

  const byAction: Record<string, number> = {};
  for (const r of win) byAction[r.action] = (byAction[r.action] ?? 0) + 1;

  const byStatus: Record<string, number> = {};
  for (const r of win) byStatus[String(r.status)] = (byStatus[String(r.status)] ?? 0) + 1;

  // Per-minute buckets for the activity chart.
  const bucketMs = windowMs <= 60 * 60 * 1000 ? 60_000 : 3_600_000;
  const buckets: Record<number, { t: number; ok: number; failed: number; blips: number; ms: number; n: number }> = {};
  for (const r of win) {
    const slot = Math.floor(r.t / bucketMs) * bucketMs;
    const b = (buckets[slot] ??= { t: slot, ok: 0, failed: 0, blips: 0, ms: 0, n: 0 });
    if (r.action === "OK") b.ok++;
    else b.failed++;
    b.blips += r.blips;
    b.ms += r.ms;
    b.n++;
  }
  const timeline = Object.values(buckets)
    .sort((a, b) => a.t - b.t)
    .map((b) => ({ t: b.t, ok: b.ok, failed: b.failed, blips: b.blips, avgMs: Math.round(b.ms / Math.max(1, b.n)) }));

  const spentCents = keys.reduce((a, k) => a + effectiveCents(k), 0);
  const initialCents = keys.reduce((a, k) => a + k.initialCents, 0);
  const totalBlips = win.reduce((a, r) => a + r.blips, 0);
  // Requests that needed >1 attempt still succeeded; this is the blip absorption rate.
  const retried = ok.filter((r) => r.attempts > 1).length;

  const burnPerReq = ok.length ? EST_REQUEST_CENTS : 0;
  const remainingCents = Math.max(0, initialCents - spentCents);

  return {
    version: VERSION,
    update: updateInfo,
    generatedAt: now,
    uptimeMs: now - startedAt,
    window: windowMs,
    money: {
      initialUsd: +(initialCents / 100).toFixed(2),
      spentUsd: +(spentCents / 100).toFixed(2),
      remainingUsd: +(remainingCents / 100).toFixed(2),
      usedPct: +((spentCents / Math.max(1, initialCents)) * 100).toFixed(1),
      estCostPerRequestUsd: +(burnPerReq / 100).toFixed(2),
      estRequestsLeft: burnPerReq ? Math.floor(remainingCents / burnPerReq) : null,
      staleCreditKeys: keys.filter((k) => effectiveCents(k) > k.initialCents).length,
    },
    traffic: {
      requests: win.length,
      ok: ok.length,
      failed: win.length - ok.length,
      successPct: win.length ? +((ok.length / win.length) * 100).toFixed(1) : 100,
      streamed: win.filter((r) => r.stream).length,
      blipsAbsorbed: totalBlips,
      retriedButSucceeded: retried,
      p50Ms: pct(50),
      p95Ms: pct(95),
      p99Ms: pct(99),
    },
    pool: poolSnapshot(),
    byModel,
    byAction,
    byStatus,
    timeline,
    spendHistory: spendHistory.map((s) => ({ t: s.t, spentUsd: +(s.spentCents / 100).toFixed(2) })),
    // Prior upstreams, so history survives a gateway switch.
    archives: archives.map((a) => ({
      label: a.label,
      keys: a.keys,
      spentUsd: a.spentUsd,
      savedAt: a.savedAt,
      active: false,
      points: a.spendHistory.length,
      top: a.top,
    })),
    lifetimeSpentUsd: +(archives.reduce((sum, a) => sum + a.spentUsd, 0) + spentCents / 100).toFixed(2),
    recent: recent.slice(-100).reverse(),
  };
}

await loadCreditOverrides();
await loadProviders();
await loadState();
await loadLog();
await loadArchives();

/** Shared by both listeners so the API port and the friendly URL behave identically. */
async function handleRequest(req: Request, srv: Bun.Server<undefined>): Promise<Response> {
  const url = new URL(req.url);
  srv.timeout(req, 0);
  {

    // The dashboard is read-only and exposes no key material, so it is gated on
    // loopback origin rather than the proxy token: a browser cannot attach headers
    // to a plain navigation. Spending still requires the token.
    const ip = srv.requestIP(req)?.address ?? "";
    const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!isLocal) return jsonError(403, "dashboard is loopback-only");
      // Read to bytes explicitly: handing Bun.serve an .html file makes Bun treat it
      // as a bundler entrypoint and rewrite the markup.
      const html = await Bun.file(DASHBOARD_FILE).arrayBuffer();
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/_stats") {
      if (!isLocal && !clientAuthorized(req)) return jsonError(401, "proxy token required");
      const w = Number(url.searchParams.get("window")) || 24 * 60 * 60 * 1000;
      return Response.json(statsSnapshot(w));
    }
    if (url.pathname === "/_pool") {
      if (!isLocal && !clientAuthorized(req)) return jsonError(401, "proxy token required");
      return Response.json(poolSnapshot());
    }

    // Add a new upstream from the dashboard: name + upstream URL + optional model list.
    // Keys are added separately via /_keys/add. Persisted to providers.json so it
    // survives a restart. Requires the token like every other mutation.
    if (url.pathname === "/_providers/add" && req.method === "POST") {
      if (!clientAuthorized(req)) return jsonError(401, "proxy token required");
      let name = "";
      let upstream = "";
      let models: string[] = [];
      try {
        const payload = (await req.json()) as { name?: string; upstream?: string; models?: string[] | string };
        name = String(payload.name ?? "").trim();
        upstream = String(payload.upstream ?? "").trim().replace(/\/+$/, "");
        const rawModels = Array.isArray(payload.models) ? payload.models : String(payload.models ?? "").split(/[\s,]+/);
        models = rawModels.map((m) => String(m).trim()).filter(Boolean);
      } catch {
        return jsonError(400, "body must be JSON: {\"name\": \"...\", \"upstream\": \"https://...\", \"models\": [\"claude-...\"]}");
      }
      if (!name || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
        return jsonError(400, "name must be 1-32 chars of [A-Za-z0-9_-]");
      }
      if (!/^https?:\/\/[^\s]+$/.test(upstream)) {
        return jsonError(400, "upstream must be an http(s) URL");
      }
      if (providerByName(name)) return jsonError(400, `provider "${name}" already exists`);
      const keysFile = `keys-${name}.txt`;
      providers.push({
        name,
        upstream,
        keysFile,
        enabled: true,
        models: new Set(),
        manualModels: models,
        lastError: keys.some((k) => k.provider === name) ? null : "no keys yet",
      });
      await saveProviders();
      await discoverModels();
      console.log(`[provider] added ${name} -> ${upstream} (${models.length} declared models)`);
      return Response.json({ added: name, upstream, models, keysFile });
    }

    // Remove an upstream and drop its keys from the live pool. Its key file is left on
    // disk (the friend may re-add it); the provider is unregistered and persisted out.
    if (url.pathname === "/_providers/remove" && req.method === "POST") {
      if (!clientAuthorized(req)) return jsonError(401, "proxy token required");
      let name = "";
      try {
        const payload = (await req.json()) as { name?: string };
        name = String(payload.name ?? "").trim();
      } catch {
        return jsonError(400, "body must be JSON: {\"name\": \"...\"}");
      }
      const prov = providerByName(name);
      if (!prov) return jsonError(400, `unknown provider "${name}"`);
      if (providers.length <= 1) return jsonError(400, "refusing to remove the last provider");
      // Drop this provider's keys from the pool, then resequence ids (they index the array).
      for (let i = keys.length - 1; i >= 0; i--) if (keys[i]!.provider === name) keys.splice(i, 1);
      keys.forEach((k, i) => (k.id = i));
      const idx = providers.findIndex((p) => p.name === name);
      providers.splice(idx, 1);
      await saveProviders();
      await discoverModels();
      saveState();
      console.log(`[provider] removed ${name}`);
      return Response.json({ removed: name, providers: providers.map((p) => p.name), poolSize: keys.length });
    }

    // Mutating the pool always requires the token, even on loopback: a browser page
    // on any origin can POST to localhost, so origin alone is not authorization.
    if (url.pathname === "/_keys/add" && req.method === "POST") {
      if (!clientAuthorized(req)) return jsonError(401, "proxy token required");
      let submitted: string[] = [];
      let target = providers[0]!.name;
      try {
        const payload = (await req.json()) as { keys?: string[] | string; provider?: string };
        const list = Array.isArray(payload.keys) ? payload.keys : String(payload.keys ?? "").split(/[\s,]+/);
        submitted = list.map((s) => String(s).trim()).filter(Boolean);
        if (payload.provider) {
          if (!providerByName(payload.provider)) {
            return jsonError(400, `unknown provider "${payload.provider}"`);
          }
          target = payload.provider;
        }
      } catch {
        return jsonError(400, "body must be JSON: {\"keys\": [\"sk-...\"], \"provider\": \"name\"}");
      }
      if (!submitted.length) return jsonError(400, "no keys supplied");

      const malformed = submitted.filter((k) => !/^sk-[A-Za-z0-9-]{20,}$/.test(k));
      if (malformed.length) {
        return jsonError(400, `${malformed.length} key(s) are not in sk-<alnum> form`);
      }

      const prov = providerByName(target)!;
      // Validate against the target provider before admitting: a key that cannot
      // authenticate would otherwise sit in the pool absorbing requests and failing.
      const checked = await Promise.all(
        submitted.map(async (key) => {
          if (keys.some((k) => k.key === key)) return { key, ok: false, why: "already in pool" };
          try {
            const r = await fetch(`${prov.upstream}/v1/models`, {
              headers: { authorization: `Bearer ${key}`, "user-agent": OUTBOUND_UA },
              signal: AbortSignal.timeout(20_000),
            });
            if (r.status === 200) return { key, ok: true, why: "validated" };
            return { key, ok: false, why: `${target} rejected with ${r.status}` };
          } catch (e) {
            return { key, ok: false, why: `probe failed: ${(e as Error).message.slice(0, 60)}` };
          }
        }),
      );

      const good = checked.filter((c) => c.ok).map((c) => c.key);
      // Re-read overrides so a credit recorded just before adding a key is picked up.
      if (good.length) await loadCreditOverrides();
      const added = good.length ? addKeys(good, await loadInitialCredits(), target) : [];
      if (added.length) {
        await persistKeysFile(good, prov.keysFile);
        await discoverModels(); // a new provider key may unlock new models
        await pollBalances();
        console.log(`[pool] added ${added.length} key(s) to ${target}: ${added.map((t) => "..." + t).join(", ")}`);
      }
      return Response.json({
        added: added.map((t) => `...${t}`),
        rejected: checked.filter((c) => !c.ok).map((c) => ({ tail: `...${c.key.slice(-5)}`, reason: c.why })),
        poolSize: keys.length,
      });
    }

    if (url.pathname === "/_keys/remove" && req.method === "POST") {
      if (!clientAuthorized(req)) return jsonError(401, "proxy token required");
      let tails: string[] = [];
      try {
        const payload = (await req.json()) as { tails?: string[] };
        tails = (payload.tails ?? []).map((t) => String(t).replace(/^\.+/, "").trim()).filter(Boolean);
      } catch {
        return jsonError(400, "body must be JSON: {\"tails\": [\"ZvlE0\"]}");
      }
      if (!tails.length) return jsonError(400, "no tails supplied");
      if (keys.length - tails.length < 1) return jsonError(400, "refusing to empty the pool");

      const removed: string[] = [];
      for (const t of tails) {
        const i = keys.findIndex((k) => k.tail === t);
        if (i >= 0) {
          removed.push(keys[i]!.tail);
          keys.splice(i, 1);
        }
      }
      // ids index into the array, so they must be resequenced after a splice.
      keys.forEach((k, i) => (k.id = i));
      if (removed.length) {
        await rewriteKeysFiles();
        saveState();
        console.log(`[pool] removed ${removed.length} key(s)`);
      }
      return Response.json({ removed: removed.map((t) => `...${t}`), poolSize: keys.length });
    }
    if (url.pathname === "/_health") {
      return Response.json({ ok: available(Date.now()).length > 0, version: VERSION });
    }
    if (url.pathname === "/_update" && req.method === "POST") {
      if (!clientAuthorized(req)) return jsonError(401, "proxy token required");
      // Detached so the child survives this process being restarted by its supervisor.
      Bun.spawn(["cmd", "/c", "tabipool.cmd", "update"], { cwd: REPO_DIR, stdio: ["ignore", "ignore", "ignore"] }).unref();
      return Response.json({ starting: true, from: VERSION, to: updateInfo.latest });
    }
    if (!url.pathname.startsWith("/v1/")) return jsonError(404, `no route for ${url.pathname}`);
    if (!clientAuthorized(req)) return jsonError(401, "proxy token required");

    // Serve the union of every provider's models so one picker shows them all. Built
    // from discovery rather than proxied, since no single upstream knows them all.
    if (url.pathname === "/v1/models" && req.method === "GET") {
      const data = [...modelOwner.entries()].map(([id, provider]) => ({
        id,
        object: "model",
        created: 1626777600,
        owned_by: provider,
      }));
      return Response.json({ object: "list", data });
    }

    return handleProxy(req);
  }
}

const serveOpts = {
  hostname: HOST,
  // Long completions must not be cut off, so per-request timeouts are disabled.
  idleTimeout: 255,
  fetch: handleRequest,
} as const;

const server = Bun.serve({ ...serveOpts, port: PORT });

// Second listener purely for the friendly http://tabi.localhost/ URL. Bound to the
// same loopback host, so it adds a hostname alias and never LAN exposure.
let uiServer: Bun.Server<undefined> | null = null;
if (UI_PORT > 0 && UI_PORT !== PORT) {
  try {
    uiServer = Bun.serve({ ...serveOpts, port: UI_PORT });
  } catch (e) {
    console.warn(`  WARN: UI port ${UI_PORT} unavailable (${(e as Error).message.slice(0, 80)})`);
  }
}

console.log(`pool proxy on http://${HOST}:${server.port}`);
for (const p of providers) {
  console.log(`  provider ${p.name.padEnd(12)} -> ${p.upstream}  (${keys.filter((k) => k.provider === p.name).length} keys)`);
}
console.log(`  keys: ${keys.length}   auth: ${PROXY_TOKEN ? "token required" : "OPEN (no PROXY_TOKEN set)"}`);
if (!PROXY_TOKEN) {
  console.warn("  WARNING: no PROXY_TOKEN set - anything that can reach this port can spend the pool");
}
console.log(`  dashboard:   http://${HOST}:${server.port}/`);
if (uiServer) console.log(`  friendly:    http://tabi.localhost/  (port ${uiServer.port})`);
console.log(`  pool status: GET /_pool    stats: GET /_stats`);

await discoverModels();
await pollBalances();
await checkForUpdate();
console.log(`  balances polled: $${poolSnapshot().remainingUsd} remaining across ${keys.length} keys`);
setInterval(pollBalances, BALANCE_POLL_MS);
setInterval(discoverModels, MODEL_POLL_MS);
setInterval(checkForUpdate, UPDATE_POLL_MS);
setInterval(flushLog, 5_000);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await flushLog();
    process.exit(0);
  });
}
