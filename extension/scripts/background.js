const CHANNEL_API_URI = 'https://twitch.theorycraft.gg/channel-status';

const getPreviewUrl = (userName, width, height) =>
  `https://static-cdn.jtvnw.net/previews-ttv/live_user_${userName}-${width}x${height}.jpg`;

const createNotification = async (stream) => {
  const imageResponse = await fetch(getPreviewUrl(stream.username, 640, 360));
  const imageData = await imageResponse.blob();

  const reader = new FileReader();
  reader.readAsDataURL(imageData);
  reader.onloadend = () => {
    const base64data = reader.result;
    const opt = {
      type: 'image',
      title: stream.channel.display_name + ' playing ' + stream.game,
      message: stream.channel.status,
      iconUrl: '../images/logo_128.png',
      imageUrl: base64data,
      buttons: [
        {
          title: 'View Stream',
        },
      ],
    };

    chrome.notifications.create(Math.random().toString(36), opt, (id) => {
      chrome.storage.session.get(['notifications']).then((result) => {
        if (!result.notifications) {
          result.notifications = {};
        }
        result.notifications[id] = stream.username;
        chrome.storage.session.set({ notifications: result.notifications });
      });
    });
  };
};

const fetchStreamerStatus = async (
  usernames,
  callback,
  sendNotification = true
) => {
  const response = await fetch(CHANNEL_API_URI, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      channels: usernames.map((username) => username.toLowerCase()),
    }),
  });

  const streamersLive = await response.json();

  const knownOnlineStreamersData = await chrome.storage.local.get([
    'knownOnlineStreamers',
  ]);

  const knownOnlineStreamers =
    knownOnlineStreamersData && knownOnlineStreamersData.knownOnlineStreamers
      ? knownOnlineStreamersData.knownOnlineStreamers
      : {};

  for (let streamer of Object.keys(knownOnlineStreamers)) {
    if (!streamersLive[streamer]) {
      delete knownOnlineStreamers[streamer];
    }
  }

  const numOnline = Object.keys(streamersLive).length;

  chrome.storage.sync.get('hideStreamersOnlineCount', (storage) => {
    if (!storage.hideStreamersOnlineCount) {
      chrome.action.setBadgeText({
        text: `${numOnline > 0 ? numOnline : ''}`,
      });
    }
  });

  chrome.action.setTitle({
    title: `${numOnline} channels online. ${Object.keys(streamersLive).join(
      ', '
    )}`,
  });

  const currentStreamers = Object.keys(streamersLive);
  for (let i = 0; i < currentStreamers.length; i++) {
    const streamer = currentStreamers[i];
    const streamData = streamersLive[streamer];
    const alreadySentNotification = knownOnlineStreamers[streamer];
    if (!alreadySentNotification) {
      knownOnlineStreamers[streamer] = true;
      if (sendNotification) {
        await createNotification(streamData);
      }
    }
  }

  await chrome.storage.local.set({ knownOnlineStreamers });

  const hydratedData = usernames.map((username) => {
    return streamersLive[username] || { username };
  });

  callback(hydratedData);
};

const handleClick = (id) => {
  chrome.storage.local.get(['notifications']).then((result) => {
    const url = 'https://twitch.tv/' + result.notifications[id];
    chrome.tabs.create({ url: url });
  });
};

const onRequest = (request, sender, callback) => {
  if (request.action == 'fetchStreamerStatus') {
    fetchStreamerStatus(request.usernames, callback);
  } else if (request.action === 'setBadgeText') {
    const setBadgeText = request.setBadgeText;

    if (!setBadgeText) {
      chrome.action.setBadgeText({
        text: '',
      });
    }
    callback();
  }
  return true;
};

// Wire up the listener.
chrome.runtime.onMessage.addListener(onRequest);
chrome.notifications.onClicked.addListener(handleClick);
chrome.notifications.onButtonClicked.addListener(handleClick);
chrome.action.setBadgeBackgroundColor({ color: '#5cb85c' });
chrome.alarms.onAlarm.addListener(() => {
  chrome.storage.sync.get('twitchStreams', async (storage) => {
    if (storage.twitchStreams) {
      try {
        await fetchStreamerStatus(storage.twitchStreams, () => {});
      } catch (e) {}
    }
  });
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.alarms.get('backgroundFetch', (alarm) => {
    if (!alarm) {
      chrome.alarms.create('backgroundFetch', { periodInMinutes: 5 });
    }
  });
});
