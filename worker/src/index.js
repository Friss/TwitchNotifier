import { TwitchHub, normalizeChannels } from './twitch_hub.js';

export { TwitchHub };

const HUB_NAME = 'global';
const VERSION = '3.6.0';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

// Per-isolate, per-channel cache of the last status served, in front of the
// single global Durable Object. Polling clients overlap heavily on popular
// channels, so this sheds repeat getChannelStatus RPCs off the DO — the exact
// path that saturated it under load. Best-effort only: isolates are ephemeral
// and many, so hit rate scales with how much traffic an isolate sees.
//
// TTL is kept well under the DO's ~30min tracking TTL: a channel that's polled
// continuously still reaches the DO (and re-arms its tracking heartbeat) at
// least once per CHANNEL_CACHE_TTL_MS, so caching never lets a channel fall out
// of tracking. It's also <= the DO's own status TTL so we never serve staler
// than the DO would. A null entry is a live-negative (offline/unknown), cached
// so the 400+ offline channels don't miss on every request.
const CHANNEL_CACHE_TTL_MS = 30_000;
// Sweep expired entries once the map crosses this size so a long-lived isolate
// can't accumulate stale channels without bound. Entries are tiny, so the cap
// is generous.
const CHANNEL_CACHE_MAX_ENTRIES = 5000;
const channelStatusCache = new Map();

function pruneChannelCache(now) {
  for (const [channel, entry] of channelStatusCache) {
    if (entry.expiresAt <= now) {
      channelStatusCache.delete(channel);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }

    try {
      if (url.pathname === '/ws') {
        // Await async handlers so their rejections route through the catch
        // below and return a graceful 500 instead of escaping as an uncaught
        // exception (a `return <promise>` inside try/catch is not caught).
        return await getHubStub(env).fetch(request);
      }

      if (request.method === 'GET' && url.pathname === '/feature-flags') {
        return handleFeatureFlags(request);
      }

      if (request.method === 'POST' && url.pathname === '/channel-status') {
        return await handleChannelStatus(request, env);
      }

      if (
        request.method === 'GET' &&
        url.pathname.startsWith('/user-follows')
      ) {
        return jsonResponse({ follows: [] });
      }

      if (
        request.method === 'GET' &&
        url.pathname.startsWith('/channel-preview')
      ) {
        return await handlePreviewImage(url);
      }

      if (request.method === 'GET' && url.pathname.startsWith('/version')) {
        return jsonResponse({ version: VERSION });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('request_error', {
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse(
        {
          error: true,
          message: 'Something went wrong processing this request.',
        },
        { status: 500 }
      );
    }
  },

  async scheduled(controller, env, ctx) {
    const stub = getHubStub(env);
    // Log the per-tick outcome so the realtime cron is observable during the
    // rollout: active sessions, channels synced (≈ Twitch req/min), live count,
    // failed batches, and whether the tick was a no-op (no sessions connected).
    ctx.waitUntil(
      stub
        .syncTrackedChannels({
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
          version: VERSION,
        })
        .then((result) => {
          console.log('cron_sync', result);
        })
        .catch((error) => {
          console.error('cron_sync_error', {
            message: error instanceof Error ? error.message : String(error),
          });
        })
    );
  },
};

async function handleChannelStatus(request, env) {
  const body = await request.json();
  const channels = normalizeChannels(body.channels || []);

  if (channels.length === 0) {
    return jsonResponse({});
  }

  const now = Date.now();
  if (channelStatusCache.size > CHANNEL_CACHE_MAX_ENTRIES) {
    pruneChannelCache(now);
  }
  // Split into channels we can serve from the isolate cache vs. those we must
  // ask the DO for (missing or expired). Only the latter become an RPC.
  const toFetch = channels.filter((channel) => {
    const entry = channelStatusCache.get(channel);
    return entry === undefined || entry.expiresAt <= now;
  });

  if (toFetch.length > 0) {
    const fetched = await getHubStub(env).getChannelStatus(toFetch, {
      refreshIfStale: true,
    });
    const expiresAt = now + CHANNEL_CACHE_TTL_MS;
    // buildResponse omits offline channels, so anything in toFetch that isn't
    // in the result is offline/unknown — cache it as a null so it doesn't miss
    // every request.
    for (const channel of toFetch) {
      channelStatusCache.set(channel, {
        payload: fetched[channel] ?? null,
        expiresAt,
      });
    }
  }

  const response = {};
  for (const channel of channels) {
    const entry = channelStatusCache.get(channel);
    if (entry && entry.payload) {
      response[channel] = entry.payload;
    }
  }

  return jsonResponse(response);
}

// Realtime is fully rolled out, so every client is told to use the WebSocket
// transport. The extension still keeps polling running as an automatic fallback
// whenever its socket isn't open, so a DO hiccup degrades gracefully without a
// server-side flag. Kept as an endpoint (rather than removed) so older installs
// that still poll it keep getting a valid response.
function handleFeatureFlags(request) {
  const url = new URL(request.url);

  return jsonResponse({
    features: {
      realtimeNotifications: true,
    },
    transport: 'realtime',
    websocketUrl: `wss://${url.host}/ws`,
  });
}

async function handlePreviewImage(url) {
  const [, , userName, width, height] = url.pathname.split('/');
  const previewUrl = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${userName}-${width}x${height}.jpg`;
  const response = await fetch(previewUrl);
  const imageResponse = new Response(response.body, response);

  imageResponse.headers.delete('x-served-by');
  imageResponse.headers.delete('set-cookie');

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    imageResponse.headers.set(key, value);
  }

  return imageResponse;
}

function handleOptions(request) {
  if (
    request.headers.get('Origin') !== null &&
    request.headers.get('Access-Control-Request-Method') !== null &&
    request.headers.get('Access-Control-Request-Headers') !== null
  ) {
    // Cache the preflight for a day so the extension's per-poll JSON POST stops
    // triggering an OPTIONS round-trip every time (~46% of request volume).
    return new Response(null, {
      headers: {
        ...CORS_HEADERS,
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  return new Response(null, {
    headers: {
      Allow: 'GET, HEAD, POST, OPTIONS',
    },
  });
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(init.headers || {}),
    },
  });
}

function getHubStub(env) {
  return env.TWITCH_HUB.getByName(HUB_NAME);
}
