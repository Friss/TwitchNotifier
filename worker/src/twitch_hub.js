import { DurableObject } from 'cloudflare:workers';

const STREAMS_URI = 'https://api.twitch.tv/helix/streams?first=100';
const DEFAULT_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const TOKEN_CACHE_KEY = 'twitch_auth_token';
const DEFAULT_STATUS_TTL_MS = 60_000;
// A still-live channel is only rewritten when its viewer count moves
// enough to change the number the popup actually displays — there's no point
// persisting a change the user can't see. The popup abbreviates to 0.1K / 0.1M
// above 1000 (see abbreviateViewers, mirrored from pop-up.js), so the effective
// step grows with the count. The absolute floor keeps the exact (<1000) range
// from writing on ±1 jitter.
const VIEWER_WRITE_FLOOR = 5;
const TWITCH_BATCH_LIMIT = 100;
// Workers allow at most 6 simultaneous outbound connections, so cap how many
// Twitch batches we fetch in parallel.
const MAX_CONCURRENT_FETCHES = 6;
// Durable Object SQLite allows at most 100 bound parameters per statement, so
// chunk IN (...) lookups to stay under the limit for users tracking >100
// channels.
const SQL_BIND_LIMIT = 100;
// Transient Twitch failures (429 rate-limits, 5xx, network blips) are retried
// with full-jitter backoff so a brief hiccup recovers within the same tick
// instead of dropping the batch. Waits are capped so we never stall the
// request/cron path — if Twitch asks us to wait longer than the cap we bail and
// serve last-known-good cache instead.
const MAX_FETCH_RETRIES = 2;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 2000;
const MAX_RETRY_AFTER_MS = 3000;
// Twitch login names are 1-25 chars of lowercase alphanumerics + underscore but
// must NOT begin with an underscore. A single malformed value makes Helix reject
// the entire batch with a generic 400 "Malformed query params." (it never says
// which one), so drop anything that can't be a real login before it poisons a
// batch. The earlier /^[a-z0-9_]{1,25}$/ let leading-underscore values through
// (e.g. "___", "_test", "_gocchan_"), which Twitch rejects — confirmed in prod
// logs as the source of the persistent 400s. Length stays permissive (1+) so
// legacy short accounts aren't silently dropped; only the leading underscore,
// the proven offender, is excluded.
const TWITCH_LOGIN = /^[a-z0-9][a-z0-9_]{0,24}$/;

export class TwitchHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();
    // Per-channel sync freshness, kept in memory so a no-op sync never has to
    // write a row just to bump last_synced_at. Empty after eviction/restart, so
    // every channel reads as stale until re-synced — the safe default.
    this.lastSyncedAt = new Map();
    // Channel → in-flight sync Promise, so concurrent polls for the same stale
    // channel coalesce into a single Helix fetch instead of N.
    this.syncsInFlight = new Map();

    // Let the runtime answer client keepalive pings without waking the
    // hibernated DO; the WS activity is what keeps Chrome's MV3 service worker
    // from being killed for idleness.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );

    ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
      this.restoreSessions();
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== '/ws') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ channels: [] });
    this.sessions.set(server, new Set());

    console.log('ws_connect', { sessions: this.sessions.size });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async getChannelStatus(channels, options = {}) {
    const normalized = normalizeChannels(channels);

    if (normalized.length === 0) {
      return {};
    }

    const existing = this.getStoredStatuses(normalized);

    if (options.refreshIfStale !== false) {
      const staleChannels = this.getStaleChannels(
        normalized,
        Date.now(),
        this.getStatusTtlMs()
      );

      // Cold channels have no row at all — a brand-new install must not get an
      // empty response for channels we've never checked, so block on those.
      // Stale-but-present channels already have a cached row: serve it now and
      // refresh in the background so Twitch I/O stays off the request path
      // (awaiting it serialized the DO and caused ~30s RPC timeouts under load).
      const cold = staleChannels.filter((channel) => !existing.has(channel));
      const staleButPresent = staleChannels.filter((channel) =>
        existing.has(channel)
      );

      if (cold.length > 0) {
        await this.syncChannelsCoalesced(cold);
      }

      if (staleButPresent.length > 0) {
        // Fire-and-forget; the DO stays alive while the promise is pending. The
        // .catch makes an unhandled rejection impossible.
        this.syncChannelsCoalesced(staleButPresent).catch((error) => {
          console.error('background_sync_error', {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }

    return this.buildResponse(normalized, this.getStoredStatuses(normalized));
  }

  async syncTrackedChannels(metadata = {}) {
    // The cron exists to push live/offline transitions to connected
    // WebSocket clients. With no active sessions there is nothing to
    // broadcast, so skip the Twitch sync entirely and avoid burning the
    // shared Twitch rate budget. Polling clients refresh their own stale
    // statuses on demand via getChannelStatus().
    const activeSessionChannels = this.getSessionChannels();
    const sessions = this.sessions.size;

    if (activeSessionChannels.length === 0) {
      return {
        sessions,
        channelsSynced: 0,
        liveChannels: 0,
        skipped: true,
        metadata,
      };
    }

    const result = await this.syncChannelsCoalesced(activeSessionChannels);

    return {
      sessions,
      ...result,
      metadata,
    };
  }

  async webSocketMessage(ws, message) {
    const text =
      typeof message === 'string' ? message : new TextDecoder().decode(message);

    // Auto-response handles 'ping' without waking us, but tolerate bare
    // ping/pong text frames reaching the handler rather than JSON.parse-ing them.
    if (text === 'ping' || text === 'pong') {
      return;
    }

    let parsedMessage;

    try {
      parsedMessage = JSON.parse(text);
    } catch {
      return;
    }

    if (parsedMessage.action !== 'subscribe') {
      return;
    }

    const channels = normalizeChannels(parsedMessage.channels || []);
    this.sessions.set(ws, new Set(channels));
    ws.serializeAttachment({ channels });

    console.log('ws_subscribe', {
      channels: channels.length,
      sessions: this.sessions.size,
    });

    const currentState = this.buildResponse(
      channels,
      this.getStoredStatuses(channels)
    );

    // Snapshot-aware clients (subscribe with `snapshot: true`) get the full
    // live set in one frame so they can reconcile their entire known list on
    // (re)connect — notifying for newly-live channels and pruning any that are
    // no longer live — which lets them rely on reconnect instead of an HTTP
    // polling fallback. Legacy clients only understand per-channel LIVE/OFFLINE
    // frames, so keep emitting one LIVE per live channel for them.
    if (parsedMessage.snapshot === true) {
      ws.send(JSON.stringify({ type: 'SNAPSHOT', live: currentState }));
      return;
    }

    for (const channel of Object.keys(currentState)) {
      ws.send(
        JSON.stringify({
          type: 'LIVE',
          channel,
          data: currentState[channel],
        })
      );
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws);
    console.log('ws_close', { sessions: this.sessions.size });
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
    console.log('ws_error', { sessions: this.sessions.size });
  }

  initializeSchema() {
    // Drop the legacy tracked_channels table. The cron syncs the live
    // WebSocket session set (getSessionChannels, rebuilt from socket
    // attachments) and pollers refresh on demand via getChannelStatus, so
    // nothing read this table — it was write-only churn (~85% of DO row
    // writes). IF EXISTS makes this a no-op once the table is gone.
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS tracked_channels`);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_status (
        channel TEXT PRIMARY KEY,
        is_live INTEGER NOT NULL,
        payload TEXT,
        last_synced_at INTEGER NOT NULL
      )
    `);
  }

  restoreSessions() {
    this.sessions.clear();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() || { channels: [] };
      this.sessions.set(
        ws,
        new Set(normalizeChannels(attachment.channels || []))
      );
    }
  }

  getSessionChannels() {
    const channels = new Set();

    for (const subscribedChannels of this.sessions.values()) {
      for (const channel of subscribedChannels) {
        channels.add(channel);
      }
    }

    return Array.from(channels);
  }

  getStoredStatuses(channels) {
    const result = new Map();

    // SQLite caps bound parameters at 100 per statement, so chunk the IN (...)
    // lookup. Without this, status reads for users tracking >100 channels throw
    // SQLITE_ERROR ("too many SQL variables").
    for (let index = 0; index < channels.length; index += SQL_BIND_LIMIT) {
      const chunk = channels.slice(index, index + SQL_BIND_LIMIT);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.ctx.storage.sql
        .exec(
          `
            SELECT channel, is_live, payload, last_synced_at
            FROM channel_status
            WHERE channel IN (${placeholders})
          `,
          ...chunk
        )
        .toArray();

      for (const row of rows) {
        result.set(row.channel, {
          isLive: row.is_live === 1,
          payload: row.payload ? JSON.parse(row.payload) : null,
          lastSyncedAt: row.last_synced_at,
        });
      }
    }

    return result;
  }

  getStaleChannels(channels, now, ttlMs) {
    return channels.filter((channel) => {
      const syncedAt = this.lastSyncedAt.get(channel);
      return syncedAt === undefined || syncedAt < now - ttlMs;
    });
  }

  buildResponse(channels, storedStatuses) {
    const response = {};

    for (const channel of channels) {
      const cached = storedStatuses.get(channel);

      if (cached && cached.isLive && cached.payload) {
        response[channel] = cached.payload;
      }
    }

    return response;
  }

  async syncChannels(channels) {
    const normalized = normalizeChannels(channels);

    if (normalized.length === 0) {
      return {
        channelsSynced: 0,
        liveChannels: 0,
      };
    }

    const previous = this.getStoredStatuses(normalized);
    const token = await this.getAuthToken();

    if (!token) {
      return {
        channelsSynced: 0,
        liveChannels: 0,
        failed: true,
      };
    }

    const liveStreams = new Map();
    const failedChannels = new Set();

    const batches = [];
    for (
      let index = 0;
      index < normalized.length;
      index += TWITCH_BATCH_LIMIT
    ) {
      batches.push(normalized.slice(index, index + TWITCH_BATCH_LIMIT));
    }

    // Fetch batches in parallel, capped at the Workers 6-connection limit so
    // cron CPU time stays flat as the tracked-channel set grows.
    for (
      let index = 0;
      index < batches.length;
      index += MAX_CONCURRENT_FETCHES
    ) {
      const group = batches.slice(index, index + MAX_CONCURRENT_FETCHES);
      const results = await Promise.all(
        group.map(async (batch) => ({
          batch,
          streams: await this.fetchLiveBatch(batch, token),
        }))
      );

      for (const { batch, streams } of results) {
        if (!streams) {
          batch.forEach((channel) => failedChannels.add(channel));
          continue;
        }

        for (const stream of streams) {
          liveStreams.set(stream.username, stream);
        }
      }
    }

    const syncedAt = Date.now();
    let liveChannelCount = 0;
    // How many live rows we actually persisted this tick. With the write-cadence
    // gate this is normally well below liveChannels — the gap is the write
    // reduction, surfaced in the cron_sync log so the rollout is observable.
    let liveWrites = 0;

    for (const channel of normalized) {
      if (failedChannels.has(channel)) {
        continue;
      }

      // Sync succeeded for this channel; record freshness in memory so the next
      // poll can serve cache without a write. Set even when nothing changed —
      // this is what replaces the unconditional last_synced_at row bump.
      this.lastSyncedAt.set(channel, syncedAt);

      const nextStatus = liveStreams.get(channel) || null;
      const previousStatus = previous.get(channel);
      const wasLive =
        previousStatus && previousStatus.isLive && previousStatus.payload;

      if (nextStatus) {
        liveChannelCount += 1;

        // Decide whether to persist this tick. A transition into live always
        // writes (the row must exist and clients need the LIVE payload). While a
        // channel stays live we only rewrite when something a client renders
        // actually changed — title, game, uptime, name, or the *displayed*
        // viewer count. A stable stream is left untouched rather than rewriting
        // identical bytes every tick. Skipping a write doesn't make the channel
        // read stale — lastSyncedAt is bumped above every successful sync, and
        // the persisted row already holds the current state.
        const shouldWrite =
          !wasLive || this.liveStatusChanged(previousStatus, nextStatus);

        if (shouldWrite) {
          liveWrites += 1;
          this.ctx.storage.sql.exec(
            `
              INSERT INTO channel_status (channel, is_live, payload, last_synced_at)
              VALUES (?, 1, ?, ?)
              ON CONFLICT(channel) DO UPDATE SET
                is_live = 1,
                payload = excluded.payload,
                last_synced_at = excluded.last_synced_at
            `,
            channel,
            JSON.stringify(nextStatus),
            syncedAt
          );
        }

        if (!wasLive) {
          this.broadcast(channel, {
            type: 'LIVE',
            channel,
            data: nextStatus,
          });
        }
      } else if (wasLive || !previousStatus) {
        // Write on the live→offline transition, and once for a channel we've
        // never synced before — without that first row it stays "cold" forever
        // and every post-TTL poll for it awaits a Twitch fetch. Channels that
        // were already offline (the overwhelming majority) are left untouched —
        // rewriting their rows just to bump last_synced_at is the write
        // amplification we moved into the in-memory lastSyncedAt map.
        this.ctx.storage.sql.exec(
          `
            INSERT INTO channel_status (channel, is_live, payload, last_synced_at)
            VALUES (?, 0, NULL, ?)
            ON CONFLICT(channel) DO UPDATE SET
              is_live = 0,
              payload = NULL,
              last_synced_at = excluded.last_synced_at
          `,
          channel,
          syncedAt
        );

        if (wasLive) {
          this.broadcast(channel, {
            type: 'OFFLINE',
            channel,
          });
        }
      }
    }

    return {
      channelsSynced: normalized.length - failedChannels.size,
      liveChannels: liveChannelCount,
      liveWrites,
      failedChannels: failedChannels.size,
    };
  }

  // Coalescing wrapper around syncChannels: channels already being synced are
  // dropped from the fetch batch so concurrent polls for the same stale channel
  // share one Helix fetch. syncChannels stays the single place that
  // fetches/writes/broadcasts; this only tracks the in-flight promises and
  // clears them once the underlying sync settles.
  async syncChannelsCoalesced(channels) {
    const normalized = normalizeChannels(channels);
    const pending = normalized.filter(
      (channel) => !this.syncsInFlight.has(channel)
    );

    // Syncs already covering some of the requested channels. These must be
    // joined before returning — a cold-path caller awaiting [a, b] while a is
    // mid-sync elsewhere would otherwise build its response before a has any
    // stored row and wrongly report it offline. One promise can cover many
    // channels, so dedupe via Set.
    const inFlight = new Set(
      normalized
        .map((channel) => this.syncsInFlight.get(channel))
        .filter(Boolean)
    );

    if (pending.length === 0) {
      // Every requested channel is already in flight; join the existing syncs
      // but don't kick off a new fetch. Callers that spread the result (the
      // cron) get a no-op summary rather than the joined batches' shapes.
      await Promise.all(inFlight);
      return {
        channelsSynced: 0,
        liveChannels: 0,
        coalesced: true,
      };
    }

    const promise = this.syncChannels(pending).finally(() => {
      for (const channel of pending) {
        if (this.syncsInFlight.get(channel) === promise) {
          this.syncsInFlight.delete(channel);
        }
      }
    });

    for (const channel of pending) {
      this.syncsInFlight.set(channel, promise);
    }

    const [result] = await Promise.all([promise, ...inFlight]);
    return result;
  }

  async fetchLiveBatch(channels, token) {
    const query = channels
      .map((channel) => `user_login=${encodeURIComponent(channel)}`)
      .join('&');

    try {
      const response = await fetchWithRetry(`${STREAMS_URI}&${query}`, {
        headers: {
          'Client-ID': this.getClientId(),
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        // Helix returns a JSON body describing the exact failure (e.g.
        // {"error":"Bad Request","status":400,"message":"Malformed query
        // parameter \"user_login\"..."}). Surface it — plus the batch shape and
        // a channel sample — so a 400 can be traced to the offending input. Read
        // defensively: the body may be empty or non-JSON, and parsing must never
        // mask the original failure.
        let body = null;
        try {
          // Helix error bodies are tiny; the generous cap only trims a
          // pathological upstream error page, never a real Twitch message.
          body = (await response.text()).slice(0, 2000);
        } catch {
          body = '<unreadable>';
        }
        // Log the full batch (capped at TWITCH_BATCH_LIMIT = 100) rather than a
        // sample: a 400 is usually one offending login, which could sit anywhere
        // in the batch. This is an error-only path, so verbosity is cheap.
        console.error('twitch_fetch_failed', {
          status: response.status,
          statusText: response.statusText,
          body,
          batchSize: channels.length,
          channels,
        });
        // A revoked/invalidated token keeps failing until it expires; drop it
        // so the next sync fetches a fresh one.
        if (response.status === 401) {
          await this.ctx.storage.delete(TOKEN_CACHE_KEY);
        }
        return null;
      }

      const json = await response.json();

      return (json.data || []).map((stream) => this.transformStream(stream));
    } catch (error) {
      console.error('twitch_fetch_error', {
        message: error instanceof Error ? error.message : String(error),
        batchSize: channels.length,
        channels,
      });
      return null;
    }
  }

  async getAuthToken() {
    const cached = await this.ctx.storage.get(TOKEN_CACHE_KEY);

    if (cached && cached.expires > Date.now()) {
      return cached.token;
    }

    const clientSecret =
      this.env.TWITCH_CLIENT_SECRET || this.env.CLIENT_SECRET;

    if (!clientSecret) {
      console.warn('missing_twitch_client_secret');
      return null;
    }

    const params = new URLSearchParams({
      client_id: this.getClientId(),
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    });

    try {
      const response = await fetchWithRetry(
        'https://id.twitch.tv/oauth2/token',
        {
          method: 'POST',
          body: params,
        }
      );
      const data = await response.json();

      if (!data.access_token) {
        console.error('twitch_auth_failed', data);
        return null;
      }

      const token = {
        token: data.access_token,
        expires: Date.now() + 50 * 60 * 1000,
      };

      await this.ctx.storage.put(TOKEN_CACHE_KEY, token);

      return token.token;
    } catch (error) {
      console.error('twitch_auth_error', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  getClientId() {
    return this.env.TWITCH_CLIENT_ID || this.env.CLIENT_ID || DEFAULT_CLIENT_ID;
  }

  getStatusTtlMs() {
    return (
      getPositiveNumber(
        this.env.STATUS_TTL_SECONDS,
        DEFAULT_STATUS_TTL_MS / 1000
      ) * 1000
    );
  }

  // True when a field the extension renders differs between the stored payload
  // and the freshly fetched one, so a rewrite would actually change what a
  // client sees: title, game, uptime (started_at), display name, login, or the
  // *displayed* (abbreviated) viewer count. A stable stream returns false and is
  // left untouched. Missing baseline → true (write, can't reason about it).
  liveStatusChanged(previousStatus, nextStatus) {
    const prev = previousStatus?.payload;

    if (!prev) {
      return true;
    }

    return (
      this.viewersChangedEnough(previousStatus, nextStatus) ||
      prev.channel?.status !== nextStatus.channel?.status ||
      prev.game !== nextStatus.game ||
      prev.created_at !== nextStatus.created_at ||
      prev.user_name !== nextStatus.user_name ||
      prev.username !== nextStatus.username
    );
  }

  // True when the viewer count moved enough to change the abbreviated label the
  // popup would render, and the raw move cleared VIEWER_WRITE_FLOOR (so the
  // exact <1000 range doesn't write on ±1 jitter). Missing baselines (no prior
  // payload) count as changed so we never suppress a write we can't reason about.
  viewersChangedEnough(previousStatus, nextStatus) {
    const previousViewers = previousStatus?.payload?.viewers;
    const nextViewers = nextStatus?.viewers;

    if (
      typeof previousViewers !== 'number' ||
      typeof nextViewers !== 'number'
    ) {
      return true;
    }

    if (Math.abs(nextViewers - previousViewers) < VIEWER_WRITE_FLOOR) {
      return false;
    }

    return (
      abbreviateViewers(previousViewers) !== abbreviateViewers(nextViewers)
    );
  }

  transformStream(stream) {
    const username = stream.user_login.toLowerCase();

    return {
      ...stream,
      username,
      channel: {
        display_name: stream.user_name,
        status: stream.title,
      },
      game: stream.game_name,
      viewers: stream.viewer_count,
      created_at: stream.started_at,
    };
  }

  broadcast(channel, message) {
    const payload = JSON.stringify(message);
    let recipients = 0;

    for (const [ws, subscribedChannels] of this.sessions.entries()) {
      if (!subscribedChannels.has(channel)) {
        continue;
      }

      try {
        ws.send(payload);
        recipients += 1;
      } catch (error) {
        this.sessions.delete(ws);
        console.warn('websocket_send_failed', {
          channel,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Confirms LIVE/OFFLINE transitions are actually delivered. recipients: 0
    // means the transition fired but no connected session was subscribed.
    console.log('ws_broadcast', {
      type: message.type,
      channel,
      recipients,
    });
  }
}

// Exported so index.js's /channel-status handler validates with the exact same
// rules — keeping a single source of truth for TWITCH_LOGIN avoids the two
// copies drifting and letting bad logins reach the DO.
export function normalizeChannels(channels) {
  return Array.from(
    new Set(
      channels
        .filter((channel) => typeof channel === 'string')
        .map((channel) => channel.trim().toLowerCase())
        .filter((channel) => TWITCH_LOGIN.test(channel))
    )
  );
}

// Mirrors abbreviateViewerCount in extension/scripts/pop-up.js: the popup shows
// exact counts below 1000 and 0.1K / 0.1M abbreviations above, so this is the
// granularity at which a viewer change becomes visible to the user. Kept in
// sync with the extension by hand — if the popup's formatting changes, update
// both. Returns a string so callers compare displayed labels directly.
function abbreviateViewers(number) {
  if (number >= 1e6) {
    return (number / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (number >= 1e3) {
    return (number / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return String(number);
}

function getPositiveNumber(rawValue, fallback) {
  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}

// Fetch with retry on transient failures. Retries 429/5xx responses and network
// errors with full-jitter backoff, honoring a Retry-After header when present.
// Returns the final Response (which the caller still inspects for .ok); only
// rethrows when a network error persists past the last attempt.
async function fetchWithRetry(url, options = {}, retries = MAX_FETCH_RETRIES) {
  for (let attempt = 0; ; attempt++) {
    let response;

    try {
      response = await fetch(url, options);
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }
      await sleep(backoffDelay(attempt));
      continue;
    }

    if (
      response.ok ||
      !isRetryableStatus(response.status) ||
      attempt >= retries
    ) {
      return response;
    }

    const wait = retryDelay(response, attempt);

    // Retry-After longer than we're willing to block: give up now and let the
    // caller fall back to cached status rather than stalling.
    if (wait === null) {
      return response;
    }

    await sleep(wait);
  }
}

function isRetryableStatus(status) {
  // Only rate-limits and server errors are transient. We do NOT retry 400:
  // Helix's 400 "Malformed query params." is deterministic on batch content (an
  // invalid login such as a leading-underscore name poisons the whole batch),
  // so retrying just triples the call count and still fails. The fix is to keep
  // bad logins out of the batch (see TWITCH_LOGIN), not to retry.
  return status === 429 || status >= 500;
}

// Full jitter: a random wait in [0, ceiling) where the ceiling grows
// exponentially per attempt, capped so one slow batch can't stall the path.
function backoffDelay(attempt) {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

function retryDelay(response, attempt) {
  const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));

  if (retryAfter !== null) {
    return retryAfter > MAX_RETRY_AFTER_MS ? null : retryAfter;
  }

  return backoffDelay(attempt);
}

// Retry-After is either delta-seconds or an HTTP-date; return milliseconds.
function parseRetryAfter(headerValue) {
  if (!headerValue) {
    return null;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const timestamp = Date.parse(headerValue);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.max(0, timestamp - Date.now());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
