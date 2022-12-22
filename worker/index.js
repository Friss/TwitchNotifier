const STREAMS_URI = 'https://api.twitch.tv/helix/streams?first=100';
const USERS_URI = 'https://api.twitch.tv/helix/users';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const GLOBAL_TWITCH_CACHE = {};
const LIMIT = 100;
const AUTH_HEADERS = (token) => {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-ID': CLIENT_ID,
      Accept: 'application/vnd.twitchtv.v5+json',
    },
  };
};
const RESPONSE_HEADERS = {
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
};

const previewUrl = (userName, width, height) => {
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${userName}-${width}x${height}.jpg`;
};

const AUTH_TOKEN_URI = `https://id.twitch.tv/oauth2/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=client_credentials`;

const fetchAuthToken = async () => {
  const authRes = await fetch(AUTH_TOKEN_URI, { method: 'POST' }).then((res) =>
    res.json()
  );
  return authRes.access_token;
};

const fetchUserIds = async (userNames, authToken) => {
  const response = await fetch(
    `${USERS_URI}?login=${userNames.join('&login=')}`,
    AUTH_HEADERS(authToken)
  );
  const json = await response.json();
  return json.data.map((user) => user.id);
};

const fetchLiveStreamers = async (request) => {
  const streamersRequested = await request.json();
  const streamersToFetch = [];
  const streamersResponse = {};
  const NOW = new Date().valueOf();

  streamersRequested.channels.forEach((channel) => {
    const streamersCache = GLOBAL_TWITCH_CACHE[channel];

    if (!streamersCache) {
      streamersToFetch.push(channel);
      return;
    }

    if (streamersCache.expires < NOW) {
      streamersToFetch.push(channel);
      return;
    }

    if (streamersCache.offline) {
      return;
    }

    streamersResponse[channel] = streamersCache.data;
  });

  const groups = [];
  let offset = 0;
  while (offset < streamersToFetch.length) {
    groups.push(streamersToFetch.slice(offset, offset + LIMIT));
    offset += LIMIT;
  }

  const authToken = await fetchAuthToken();

  let twitchStreamResults;

  try {
    twitchStreamResults = await Promise.all(
      groups.map(async (group) => {
        const streamersParam = group.map((u) => `user_login=${u}`).join('&');

        const api = `${STREAMS_URI}&${streamersParam}`;

        const response = await fetch(api, AUTH_HEADERS(authToken));

        return response.json();
      })
    );
  } catch (e) {
    console.error('Fetch stream results failed', e);
  }

  if (!twitchStreamResults) {
    return new Response(JSON.stringify(streamersResponse), RESPONSE_HEADERS);
  }

  twitchStreamResults.forEach((streamResults) => {
    if (!streamResults.data) {
      return;
    }

    streamResults.data.forEach((stream) => {
      stream.cached = true;
      stream.username = stream.user_login;
      stream.channel = {
        display_name: stream.user_login,
        status: stream.title,
      };
      stream.game = stream.game_name;
      stream.viewers = stream.viewer_count;
      stream.created_at = stream.started_at;

      streamersResponse[stream.user_login] = stream;
      GLOBAL_TWITCH_CACHE[stream.user_login] = {
        data: stream,
        expires: NOW + 60000,
      };
    });
  });

  streamersToFetch.forEach((streamer) => {
    if (streamersResponse[streamer]) {
      return;
    }

    GLOBAL_TWITCH_CACHE[streamer] = {
      expires: NOW + 60000,
      offline: true,
    };
  });

  return new Response(JSON.stringify(streamersResponse), RESPONSE_HEADERS);
};

const fetchUserFollows = async () => {
  // This api is not available anymore so just return an empty array.
  return new Response(JSON.stringify({ follows: [] }), RESPONSE_HEADERS);
};

const handlePreviewImage = async (url) => {
  const [_, __, userName, width, height] = url.pathname.split('/');
  const response = await fetch(previewUrl(userName, width, height));

  const imageResponse = new Response(response.body, response);
  imageResponse.headers.delete('x-served-by');
  imageResponse.headers.delete('set-cookie');
  Object.keys(CORS_HEADERS).forEach((key) => {
    imageResponse.headers.set(key, CORS_HEADERS[key]);
  });

  return imageResponse;
};

const handleOptions = (request) => {
  if (
    request.headers.get('Origin') !== null &&
    request.headers.get('Access-Control-Request-Method') !== null &&
    request.headers.get('Access-Control-Request-Headers') !== null
  ) {
    // Handle CORS pre-flight request.
    return new Response(null, {
      headers: CORS_HEADERS,
    });
  } else {
    // Handle standard OPTIONS request.
    return new Response(null, {
      headers: {
        Allow: 'GET, HEAD, POST, OPTIONS',
      },
    });
  }
};

/**
 * Fetch and log a request
 * @param {Request} request
 */
const handleRequest = async (request) => {
  try {
    const requestUrl = new URL(request.url);
    const requestPathName = requestUrl.pathname;

    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    } else if (
      request.method === 'POST' &&
      requestPathName === '/channel-status'
    ) {
      return fetchLiveStreamers(request);
    } else if (
      request.method === 'GET' &&
      requestPathName.startsWith('/user-follows')
    ) {
      return fetchUserFollows(request, requestUrl);
    } else if (
      request.method === 'GET' &&
      requestPathName.startsWith('/channel-preview')
    ) {
      return handlePreviewImage(requestUrl);
    } else if (
      request.method === 'GET' &&
      requestPathName.startsWith('/version')
    ) {
      return new Response(JSON.stringify({ version: '2022-12-22 1:28pm' }), {
        status: 200,
      });
    }

    return new Response(null, {
      status: 418,
      statusText: "I'm a teapot",
    });
  } catch (error) {
    console.log(error);
    return new Response(
      JSON.stringify({
        error: true,
        message: 'Something went wrong processing this request.',
      }),
      {
        ...RESPONSE_HEADERS,
        status: 500,
      }
    );
  }
};

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});
