import { TwitchHub } from './twitch_hub.js';

export { TwitchHub };

const HUB_NAME = 'global';
const VERSION = '3.4.0';
// Twitch login names are 1-25 chars of lowercase alphanumerics + underscore.
// Drop anything else so one malformed value can't 400 a whole Helix batch.
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;
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

  const response = await getHubStub(env).getChannelStatus(channels, {
    refreshIfStale: true,
  });

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
