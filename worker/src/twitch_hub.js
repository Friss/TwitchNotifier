import { DurableObject } from 'cloudflare:workers';

const STREAMS_URI = 'https://api.twitch.tv/helix/streams?first=100';
const DEFAULT_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const TOKEN_CACHE_KEY = 'twitch_auth_token';
const DEFAULT_STATUS_TTL_MS = 60_000;
const DEFAULT_TRACKING_TTL_MS = 30 * 60_000;
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
// Twitch login names are 1-25 chars of lowercase alphanumerics + underscore. A
// single malformed value makes Helix reject the entire batch with a generic
// 400 (it never says which one), so drop anything that can't be a real login
// before it poisons a batch.
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;

export class TwitchHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();

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

    await this.trackChannels(normalized);

    const existing = this.getStoredStatuses(normalized);
    const staleChannels =
      options.refreshIfStale === false
        ? []
        : this.getStaleChannels(
            normalized,
            existing,
            Date.now(),
            this.getStatusTtlMs()
          );

    if (staleChannels.length > 0) {
      await this.syncChannels(staleChannels);
    }

    return this.buildResponse(normalized, this.getStoredStatuses(normalized));
  }

  async syncTrackedChannels(metadata = {}) {
    const now = Date.now();

    // Prune expired tracking rows regardless of whether we sync this tick.
    this.ctx.storage.sql.exec(
      'DELETE FROM tracked_channels WHERE tracked_until < ?',
      now
    );

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

    await this.trackChannels(activeSessionChannels, now);

    const result = await this.syncChannels(activeSessionChannels);

    return {
      sessions,
      ...result,
      metadata,
    };
  }

  async webSocketMessage(ws, message) {
    const text =
      typeof message === 'string' ? message : new TextDecoder().decode(message);

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

    await this.trackChannels(channels);

    const currentState = this.buildResponse(
      channels,
      this.getStoredStatuses(channels)
    );

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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tracked_channels (
        channel TEXT PRIMARY KEY,
        tracked_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

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

  async trackChannels(channels, now = Date.now()) {
    const trackedUntil = now + this.getTrackingTtlMs();

    for (const channel of channels) {
      this.ctx.storage.sql.exec(
        `
          INSERT INTO tracked_channels (channel, tracked_until, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(channel) DO UPDATE SET
            tracked_until = MAX(tracked_channels.tracked_until, excluded.tracked_until),
            updated_at = excluded.updated_at
        `,
        channel,
        trackedUntil,
        now
      );
    }
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

  getStaleChannels(channels, existing, now, ttlMs) {
    return channels.filter((channel) => {
      const cached = existing.get(channel);
      return !cached || cached.lastSyncedAt < now - ttlMs;
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

    for (const channel of normalized) {
      if (failedChannels.has(channel)) {
        continue;
      }

      const nextStatus = liveStreams.get(channel) || null;
      const previousStatus = previous.get(channel);
      const wasLive =
        previousStatus && previousStatus.isLive && previousStatus.payload;

      if (nextStatus) {
        liveChannelCount += 1;
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

        if (!wasLive) {
          this.broadcast(channel, {
            type: 'LIVE',
            channel,
            data: nextStatus,
          });
        }
      } else {
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
      failedChannels: failedChannels.size,
    };
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
        console.error('twitch_fetch_failed', {
          status: response.status,
          statusText: response.statusText,
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
      const response = await fetchWithRetry('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        body: params,
      });
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

  getTrackingTtlMs() {
    return (
      getPositiveNumber(
        this.env.TRACKED_CHANNEL_TTL_SECONDS,
        DEFAULT_TRACKING_TTL_MS / 1000
      ) * 1000
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

function normalizeChannels(channels) {
  return Array.from(
    new Set(
      channels
        .filter((channel) => typeof channel === 'string')
        .map((channel) => channel.trim().toLowerCase())
        .filter((channel) => TWITCH_LOGIN.test(channel))
    )
  );
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

    if (response.ok || !isRetryableStatus(response.status) || attempt >= retries) {
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
