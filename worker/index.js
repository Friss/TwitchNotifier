const STREAMS_URI = 'https://api.twitch.tv/kraken/streams?offset=0&limit=100';
const USERS_URI = 'https://api.twitch.tv/helix/users';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const GLOBAL_TWITCH_CACHE = {};
const LIMIT = 100;
const CLIENT_ID = 'lsi25ppcsjm9cqenz31hg8h11mmq0n9';
const AUTH_HEADERS = { headers: { 'Client-ID': CLIENT_ID } };
const RESPONSE_HEADERS = {
  headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
};

const userApi = userName => {
  return `https://api.twitch.tv/kraken/users/${userName}/follows/channels?limit=100`;
};

const previewUrl = (userName, width, height) => {
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${userName}-${width}x${height}.jpg`;
};

const fetchUserIds = async userNames => {
  const response = await fetch(
    `${USERS_URI}?login=${userNames.join('&login=')}`
  );
  const json = await response.json();

  return json.data.map(user => user.id);
};

const fetchLiveStreamers = async request => {
  const streamersRequested = await request.json();
  const streamersToFetch = [];
  const streamersResponse = {};
  const NOW = new Date().valueOf();

  streamersRequested.channels.forEach(channel => {
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

  const twitchStreamResults = await Promise.all(
    groups.map(async group => {
      const userIds = await fetchUserIds(group);
      const streamersParam = `channel=${userIds.join(',')}`;

      const api = `${STREAMS_URI}&${streamersParam}`;

      const response = await fetch(api, AUTH_HEADERS);

      return response.json();
    })
  );

  twitchStreamResults.forEach(streamResults => {
    streamResults.streams.forEach(stream => {
      stream.cached = true;
      stream.username = stream.channel.name;

      streamersResponse[stream.channel.name] = stream;
      GLOBAL_TWITCH_CACHE[stream.channel.name] = {
        data: stream,
        expires: NOW + 60000,
      };
    });
  });

  streamersToFetch.forEach(streamer => {
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

const fetchUserFollows = async (request, requestUrl) => {
  let allFollows = [];
  let totalFollows = Infinity;

  let nextUrl = userApi(requestUrl.pathname.replace('/user-follows/', ''));

  while (allFollows.length <= totalFollows) {
    const response = await fetch(nextUrl, AUTH_HEADERS);
    const followers = await response.json();

    if (
      followers.error ||
      (followers.follows && followers.follows.length === 0)
    ) {
      break;
    }

    totalFollows = followers['_total'];

    allFollows = allFollows.concat(
      followers.follows.map(follow => {
        return follow.channel.name;
      })
    );

    nextUrl = followers['_links'].next;
  }

  return new Response(
    JSON.stringify({ follows: allFollows }),
    RESPONSE_HEADERS
  );
};

const handlePreviewImage = async url => {
  const [_, __, userName, width, height] = url.pathname.split('/');
  const response = await fetch(previewUrl(userName, width, height));

  const imageResponse = new Response(response.body, response);
  Object.keys(CORS_HEADERS).forEach(key => {
    imageResponse.headers.set(key, CORS_HEADERS[key]);
    imageResponse.headers.delete('x-served-by');
    imageResponse.headers.delete('set-cookie');
  });

  return imageResponse;
};

const handleOptions = request => {
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
const handleRequest = async request => {
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
  }

  return new Response(null, {
    status: 418,
    statusText: "I'm a teapot",
  });
};

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});
