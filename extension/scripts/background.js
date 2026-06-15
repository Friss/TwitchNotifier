const API_BASE_URL = 'https://twitch.theorycraft.gg';
const API_URL = `${API_BASE_URL}/channel-status`;
const WS_URL = 'wss://twitch.theorycraft.gg/ws';
const BACKGROUND_ALARM_NAME = 'backgroundFetch';
const BACKGROUND_POLL_MINUTES = 5;
const BASE_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 60000;
// Chrome (116+) resets the MV3 service-worker idle timer on WebSocket activity,
// so a steady client ping is what keeps the socket — and the worker — alive
// past the ~30s idle kill. The server auto-responds without waking the DO.
const WS_PING_INTERVAL_MS = 20000;

let webSocket = null;
let pingInterval = null;
let reconnectTimeout = null;
let reconnectAttempts = 0;
// Whether the next SNAPSHOT frame should fire notifications. Suppressed for the
// first sync after a cold start (browser launch / install) so we don't alert
// for channels that were already live; true for reconnects so we catch up on
// anything that went live while the socket was down.
let pendingSnapshotNotify = false;

// Twitch login names are 1-25 chars of lowercase alphanumerics + underscore.
// Drop anything else so a malformed stored value can't 400 the backend batch.
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;
const isValidTwitchLogin = (value) =>
  typeof value === 'string' && TWITCH_LOGIN.test(value.trim().toLowerCase());

const getPreviewUrl = (userName, width, height) =>
  `https://static-cdn.jtvnw.net/previews-ttv/live_user_${userName}-${width}x${height}.jpg`;

const createNotification = async (stream) => {
  try {
    const imageResponse = await fetch(getPreviewUrl(stream.username, 640, 360));
    const imageData = await imageResponse.blob();

    const reader = new FileReader();
    reader.readAsDataURL(imageData);
    reader.onloadend = () => {
      const notificationId = crypto.randomUUID
        ? crypto.randomUUID()
        : `${stream.username}:${Date.now()}`;
      const base64data = reader.result;
      const options = {
        type: 'image',
        title: stream.channel.display_name + ' playing ' + stream.game,
        message: stream.channel.status,
        iconUrl: '../images/logo_128.png',
        imageUrl: base64data,
        buttons: [{ title: 'View Stream' }],
      };

      chrome.notifications.create(notificationId, options, (id) => {
        chrome.storage.session.get(['notifications']).then((result) => {
          const notifications = result.notifications || {};
          notifications[id] = stream.username;
          chrome.storage.session.set({ notifications });
        });
      });
    };
  } catch (error) {
    console.error('Notification Error', error);
  }
};

const updateBadge = async () => {
  const data = await chrome.storage.local.get(['knownOnlineStreamers']);
  const known = data.knownOnlineStreamers || {};
  const count = Object.keys(known).length;
  const settings = await chrome.storage.sync.get('hideStreamersOnlineCount');

  await chrome.action.setBadgeText({
    text: settings.hideStreamersOnlineCount ? '' : count > 0 ? `${count}` : '',
  });
  await chrome.action.setTitle({
    title: `${count} channels online. ${Object.keys(known).join(', ')}`,
  });
};

const clearKnownOnlineStreamers = async () => {
  await chrome.storage.local.set({ knownOnlineStreamers: {} });
  await updateBadge();
};

const syncKnownOnlineStreamers = async (streamersLive, sendNotification) => {
  const knownOnlineStreamersData = await chrome.storage.local.get([
    'knownOnlineStreamers',
  ]);
  const knownOnlineStreamers =
    knownOnlineStreamersData.knownOnlineStreamers || {};

  for (const streamer of Object.keys(knownOnlineStreamers)) {
    if (!streamersLive[streamer]) {
      delete knownOnlineStreamers[streamer];
    }
  }

  for (const streamer of Object.keys(streamersLive)) {
    const streamData = streamersLive[streamer];
    if (!knownOnlineStreamers[streamer]) {
      knownOnlineStreamers[streamer] = true;
      if (sendNotification) {
        await createNotification(streamData);
      }
    }
  }

  await chrome.storage.local.set({ knownOnlineStreamers });
  await updateBadge();
};

const handleStreamerUpdate = async (type, channel, streamData) => {
  const data = await chrome.storage.local.get(['knownOnlineStreamers']);
  const known = data.knownOnlineStreamers || {};

  if (type === 'LIVE') {
    if (!known[channel]) {
      known[channel] = true;
      await createNotification(streamData);
    }
  } else if (type === 'OFFLINE') {
    delete known[channel];
  }

  await chrome.storage.local.set({ knownOnlineStreamers: known });
  await updateBadge();
};

const getTrackedUsernames = async () => {
  const storage = await chrome.storage.sync.get('twitchStreams');
  const stored = storage.twitchStreams || [];
  const valid = stored.filter(isValidTwitchLogin);

  // Self-heal: persist the cleaned list if any malformed values were dropped.
  if (valid.length !== stored.length) {
    await chrome.storage.sync.set({ twitchStreams: valid });
  }

  return Array.from(
    new Set(valid.map((stream) => stream.trim().toLowerCase()))
  );
};

const fetchStreamerStatus = async (
  usernames,
  callback,
  sendNotification = false
) => {
  const normalizedUsernames = Array.from(
    new Set((usernames || []).map((username) => username.toLowerCase()))
  );

  if (normalizedUsernames.length === 0) {
    await clearKnownOnlineStreamers();
    if (callback) {
      callback([]);
    }
    return;
  }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        channels: normalizedUsernames,
      }),
    });

    if (!response.ok) {
      throw new Error(`Channel status failed with ${response.status}`);
    }

    const streamersLive = await response.json();
    await syncKnownOnlineStreamers(streamersLive, sendNotification);

    if (callback) {
      callback(
        normalizedUsernames.map(
          (username) => streamersLive[username] || { username }
        )
      );
    }
  } catch (error) {
    console.error('Fetch Streamer Status Error', error);
    if (callback) {
      callback([]);
    }
  }
};

const clearReconnectTimeout = () => {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
};

const clearPingInterval = () => {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
};

const scheduleReconnect = () => {
  clearReconnectTimeout();

  // Exponential backoff with jitter, capped, so a flapping or unreachable
  // socket doesn't hammer the worker. The polling alarm acts as the data
  // fallback in the meantime.
  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempts,
    MAX_RECONNECT_DELAY_MS
  );
  const jitter = Math.random() * 1000;
  reconnectAttempts += 1;

  reconnectTimeout = setTimeout(() => {
    void connectWebSocket();
  }, delay + jitter);
};

const ensurePollingAlarm = async () => {
  const backgroundAlarm = await chrome.alarms.get(BACKGROUND_ALARM_NAME);

  if (!backgroundAlarm) {
    await chrome.alarms.create(BACKGROUND_ALARM_NAME, {
      periodInMinutes: BACKGROUND_POLL_MINUTES,
    });
  }
};

// Subscribe (or re-subscribe) the open socket to a channel set. `snapshot: true`
// asks the server to reply with one SNAPSHOT frame carrying the full live set so
// we can reconcile our entire known list in one pass.
const subscribe = (channels, notifyOnSnapshot) => {
  pendingSnapshotNotify = notifyOnSnapshot;
  webSocket.send(
    JSON.stringify({
      action: 'subscribe',
      channels,
      snapshot: true,
    })
  );
};

const connectWebSocket = async (notifyOnSnapshot = true) => {
  // Resolve usernames before the readyState check so the check and the
  // WebSocket instantiation run synchronously back-to-back. Otherwise two
  // concurrent callers could both pass the check during the await and open
  // duplicate sockets.
  const usernames = await getTrackedUsernames();

  if (usernames.length === 0) {
    return;
  }

  if (
    webSocket &&
    (webSocket.readyState === WebSocket.OPEN ||
      webSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  webSocket = new WebSocket(WS_URL);

  webSocket.onopen = () => {
    clearReconnectTimeout();
    reconnectAttempts = 0;
    subscribe(usernames, notifyOnSnapshot);

    clearPingInterval();
    pingInterval = setInterval(() => {
      if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        webSocket.send('ping');
      }
    }, WS_PING_INTERVAL_MS);
  };

  webSocket.onmessage = (event) => {
    // The server auto-responds to our keepalive ping with a 'pong' text frame;
    // it isn't JSON, so skip it before parsing.
    if (event.data === 'pong') {
      return;
    }

    try {
      const message = JSON.parse(event.data);

      if (message.type === 'SNAPSHOT') {
        // Authoritative live set for the whole subscription: add and notify for
        // newly-live channels, prune any that are no longer live. This is the
        // reconnect-time reconcile that lets the socket recover full state
        // without an HTTP poll.
        void syncKnownOnlineStreamers(
          message.live || {},
          pendingSnapshotNotify
        );
        return;
      }

      if (message.type === 'LIVE' || message.type === 'OFFLINE') {
        void handleStreamerUpdate(message.type, message.channel, message.data);
      }
    } catch (error) {
      console.error('WebSocket Message Error', error);
    }
  };

  webSocket.onclose = () => {
    webSocket = null;
    clearPingInterval();
    scheduleReconnect();
  };

  webSocket.onerror = (error) => {
    console.error('WebSocket Error', error);
  };
};

// Realtime is the only transport. Keep the alarm registered — it's the MV3
// heartbeat that wakes the killed service worker to re-open a dropped socket —
// and make sure the socket is connected.
const ensureRealtime = async (notifyOnSnapshot = true) => {
  await ensurePollingAlarm();
  await connectWebSocket(notifyOnSnapshot);
};

const refreshBackgroundState = async (sendNotification = false) => {
  const usernames = await getTrackedUsernames();
  await fetchStreamerStatus(usernames, null, sendNotification);
};

const initializeBackground = async () => {
  // Cold start: connect and let the SNAPSHOT populate state without notifying
  // (its channels were already live before launch). Only HTTP-poll if a socket
  // couldn't be opened at all (e.g. no tracked channels — which clears state).
  await ensureRealtime(false);
  if (!webSocket) {
    await refreshBackgroundState(false);
  }
};

const handleClick = (id) => {
  chrome.storage.session.get(['notifications']).then((result) => {
    if (result.notifications && result.notifications[id]) {
      chrome.tabs.create({
        url: `https://twitch.tv/${result.notifications[id]}`,
      });
    }
  });
};

const onRequest = (request, sender, callback) => {
  if (request.action === 'fetchStreamerStatus') {
    void (async () => {
      // The popup wants current status now, so fetch it directly (and return it
      // via the callback); the fetch already reconciled state, so the socket's
      // snapshot shouldn't re-notify.
      await fetchStreamerStatus(request.usernames, callback, false);
      await connectWebSocket(false);
    })();
    return true;
  }

  if (request.action === 'setBadgeText') {
    void updateBadge().then(() => callback());
    return true;
  }

  return false;
};

chrome.runtime.onMessage.addListener(onRequest);
chrome.notifications.onClicked.addListener(handleClick);
chrome.notifications.onButtonClicked.addListener(handleClick);
chrome.action.setBadgeBackgroundColor({ color: '#5cb85c' });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BACKGROUND_ALARM_NAME) {
    return;
  }

  void (async () => {
    // The alarm is the MV3 heartbeat: it may have restarted the service worker
    // (resetting module globals, webSocket=null) and is the only thing that can
    // wake us to re-open a socket that died while we were killed. Reconnect
    // rather than poll — a reconnected socket recovers its full state from the
    // server's SNAPSHOT frame, notifying for anything that went live meanwhile.
    await ensureRealtime();

    // Only fall back to an HTTP poll if no socket could be opened at all (e.g.
    // there are no tracked channels, which clears state). A connecting or open
    // socket reconciles via its snapshot.
    if (!webSocket) {
      await refreshBackgroundState(true);
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeBackground();
});

chrome.runtime.onInstalled.addListener(() => {
  void initializeBackground();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.hideStreamersOnlineCount) {
    void updateBadge();
  }

  if (area === 'sync' && changes.twitchStreams) {
    void (async () => {
      // A subscribe message replaces the session's channel set, so reuse the
      // open socket rather than tearing it down and reconnecting. The SNAPSHOT
      // reply reconciles state for the new list (including pruning removed
      // channels) without notifying — the user just edited the list.
      if (webSocket && webSocket.readyState === WebSocket.OPEN) {
        const usernames = await getTrackedUsernames();
        subscribe(usernames, false);
      } else {
        await connectWebSocket(false);
      }
    })();
  }
});
