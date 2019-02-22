const knownOnlineStreamers = {};
const notifications = {};
const CHANNEL_API_URI = 'https://twitch.theorycraft.gg/channel-status';
const FOLLOW_API_URI = 'https://twitch.theorycraft.gg/user-follows';
const PREVIEW_API = 'https://twitch.theorycraft.gg/channel-preview';

const asyncForEach = async (array, callback) => {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
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
      channels: usernames,
    }),
  });

  const streamersLive = await response.json();

  Object.keys(knownOnlineStreamers).forEach(streamer => {
    if (!streamersLive[streamer]) {
      knownOnlineStreamers[streamer] = false;
    }
  });

  await asyncForEach(Object.keys(streamersLive), async streamer => {
    const streamData = streamersLive[streamer];
    const alreadySentNotification = knownOnlineStreamers[streamer];
    if (!alreadySentNotification) {
      knownOnlineStreamers[streamer] = true;
      if (sendNotification) {
        await createNotification(streamData);
      }
    }
  });

  const hydratedData = usernames.map(username => {
    return streamersLive[username] || { username };
  });

  callback(hydratedData);
};

const fetchFollows = async (username, callback) => {
  const response = await fetch(`${FOLLOW_API_URI}/${username}`, {
    headers: {
      Accept: 'application/json',
    },
  });
  const followers = await response.json();

  chrome.storage.sync.get('twitchStreams', async storage => {
    if (storage.twitchStreams) {
      const twitchStreams = Array.from(
        new Set(storage.twitchStreams.concat(followers.follows))
      );
      chrome.storage.sync.set({ twitchStreams }, () => {
        fetchStreamerStatus(twitchStreams, callback, false);
      });
    }
  });
};

const createNotification = async stream => {
  const imageResponse = await fetch(
    `${PREVIEW_API}/${stream.username}/640/360`
  );
  const imageData = await imageResponse.blob();

  var opt = {
    type: 'image',
    title: stream.channel.display_name + ' playing ' + stream.game,
    message: stream.channel.status,
    iconUrl: 'images/icon_128.png',
    imageUrl: window.URL.createObjectURL(imageData),
    buttons: [
      {
        title: 'View Stream',
      },
    ],
  };

  chrome.notifications.create(Math.random().toString(36), opt, id => {
    notifications[id] = stream.username;
  });
};

const handleClick = id => {
  var url = 'http://twitch.tv/' + notifications[id];
  chrome.tabs.create({ url: url });
};

const onRequest = (request, sender, callback) => {
  if (request.action == 'fetchStreamerStatus') {
    fetchStreamerStatus(request.usernames, callback);
  } else if (request.action === 'fetchFollows') {
    fetchFollows(request.username, callback);
  }
};

// Wire up the listener.
chrome.extension.onRequest.addListener(onRequest);
chrome.notifications.onClicked.addListener(handleClick);
chrome.notifications.onButtonClicked.addListener(handleClick);

var pollInterval = 1000 * 60; // 1 minute, in milliseconds

const poller = async () => {
  chrome.storage.sync.get('twitchStreams', async storage => {
    if (storage.twitchStreams) {
      try {
        await fetchStreamerStatus(storage.twitchStreams, () => {});
      } catch (e) {}
    }
    window.setTimeout(poller, pollInterval);
  });
};

window.setTimeout(poller, pollInterval);
