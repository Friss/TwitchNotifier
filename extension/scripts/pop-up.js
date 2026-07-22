const escapeHtml = (unsafe) => {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const getPreviewUrl = (userName, width, height) =>
  `https://static-cdn.jtvnw.net/previews-ttv/live_user_${userName}-${width}x${height}.jpg`;

// Twitch login names are 1-25 chars of lowercase alphanumerics + underscore and
// must NOT begin with an underscore. Anything else makes the backend's Helix
// batch 400, so reject it on add and strip it from stored data on load. Keep in
// sync with the worker's TWITCH_LOGIN (worker/src/twitch_hub.js).
const TWITCH_LOGIN = /^[a-z0-9][a-z0-9_]{0,24}$/;
const isValidTwitchLogin = (value) =>
  typeof value === 'string' && TWITCH_LOGIN.test(value.trim().toLowerCase());

let hideOffline = false;
let hidePreviews = false;
let hideStreamersOnlineCount = false;

const fetchStreamerStatus = (storage, isRetry = false) => {
  if (!storage.twitchStreams) {
    storage.twitchStreams = [];
    chrome.storage.sync.set({ twitchStreams: storage.twitchStreams }, () => {});
  }

  // Auto-remove any stored values Twitch would reject, persisting the cleaned
  // list so bad entries self-heal on the next load instead of lingering.
  const validStreams = storage.twitchStreams.filter(isValidTwitchLogin);
  if (validStreams.length !== storage.twitchStreams.length) {
    storage.twitchStreams = validStreams;
    chrome.storage.sync.set({ twitchStreams: validStreams }, () => {});
  }

  if (!storage.twitchStreams.length) {
    displayStreamerStatus();
    return;
  }

  // A successful backend fetch returns one entry per tracked username (offline
  // channels come back as { username }), so an empty array or a rejected
  // message means the background's fetch failed — most often a transient blip
  // or the MV3 service worker waking up. Retry once (the spinner stays up),
  // then show an error state rather than rendering a blank popup.
  const onFailure = () => {
    if (!isRetry) {
      setTimeout(() => fetchStreamerStatus(storage, true), 1500);
    } else {
      displayStreamerStatus(null, true);
    }
  };

  chrome.runtime
    .sendMessage({
      action: 'fetchStreamerStatus',
      usernames: Array.from(
        new Set(storage.twitchStreams.map((s) => s.toLowerCase()))
      ),
    })
    .then((response) => {
      if (Array.isArray(response) && response.length > 0) {
        displayStreamerStatus(response);
      } else {
        onFailure();
      }
    })
    .catch(onFailure);
};

const updateSetBadgeText = (setBadgeText) => {
  chrome.runtime.sendMessage(
    {
      action: 'setBadgeText',
      setBadgeText,
    },
    () => {}
  );
};

const sortStreams = (streamA, streamB) => {
  if (streamA.channel && streamB.channel) {
    return streamB.viewers - streamA.viewers;
  } else if (streamA.channel && !streamB.channel) {
    return -1;
  } else if (!streamA.channel && streamB.channel) {
    return 1;
  }

  return 0;
};

const abbreviateViewerCount = (number) => {
  // regex to avoid trailing zeros
  return number >= 1e6
    ? (number / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
    : number >= 1e3
      ? (number / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
      : number;
};

const createStreamerEntry = (stream) => {
  if (!stream.channel) {
    if (hideOffline) {
      return '';
    }

    return `
      <div class="row streamer-offline">
        <div class="col-xs-12 no-padding">
          <i class='fa fa-times remove' data-username='${stream.username}'></i>
          <a class='offline twitch-link' href='http://twitch.tv/${stream.username}'>${stream.username}</a>
        </div>
      </div>
    `;
  } else {
    const imageDiv = `
      <div class="col-xs-6 no-padding">
        <img class="img-responsive" src="${getPreviewUrl(
          stream.username,
          320,
          180
        )}" />
      </div>
    `;

    return `
      <div class="row streamer-online">
        <div class="${
          hidePreviews ? 'col-xs-12 no-padding' : 'col-xs-6 no-padding'
        }">
          <i class='fa fa-times remove' data-username='${stream.username}'></i>
          <i class='fa fa-video-camera'></i>
          <a class='online twitch-link' href='http://twitch.tv/${
            stream.username
          }'>
            ${escapeHtml(stream.user_name)} - ${escapeHtml(
              stream.channel.status
            )}
          </a>
          <ul class="list-unstyled">
            <li>
              <i class="fa fa-gamepad"></i>
              ${escapeHtml(stream.game)}
            </li>
            <li>
              <i class="fa fa-users"></i>
              ${abbreviateViewerCount(stream.viewers)}
            </li>
            <li>
              <i class="fa fa-clock-o"></i>
              Live for ${dateFns.distanceInWordsToNow(stream.created_at)}
            </li>
          </ul>
        </div>
        ${hidePreviews ? '' : imageDiv}
      </div>
    `;
  }
};

const displayStreamerStatus = (streams, failed = false) => {
  document.getElementById('loading').classList.add('hidden');
  const emptyState = document.getElementById('emptyState');
  const errorState = document.getElementById('errorState');

  // Fetch failed: surface an error rather than a blank popup, and leave any
  // previously rendered list in place so the user keeps seeing last-known state.
  if (failed) {
    emptyState.classList.add('hidden');
    errorState.classList.remove('hidden');
    return;
  }
  errorState.classList.add('hidden');

  // No argument means there are no tracked channels (the genuine empty state),
  // distinct from a fetch that came back empty (handled as a failure above).
  if (!streams) {
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  const list = document.getElementById('streamers');
  list.innerHTML = '';

  streams.sort(sortStreams).forEach((stream) => {
    // Isolate each entry: a single malformed payload must not throw out of the
    // loop and leave the whole popup blank.
    try {
      const entry = document.createElement('li');
      entry.innerHTML = createStreamerEntry(stream);
      entry.setAttribute('data-username', stream.username);
      list.appendChild(entry);
    } catch (error) {
      console.error('Render error', stream && stream.username, error);
    }
  });
};

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(
    [
      'hideOffline',
      'hidePreviews',
      'hideStreamersOnlineCount',
      'twitchStreams',
    ],
    (storage) => {
      hideOffline = storage.hideOffline;
      document.getElementById('hideOffline').checked = !hideOffline;

      hidePreviews = storage.hidePreviews;
      document.getElementById('hidePreviews').checked = !hidePreviews;

      hideStreamersOnlineCount = storage.hideStreamersOnlineCount;
      document.getElementById('hideStreamersOnlineCount').checked =
        !hideStreamersOnlineCount;

      fetchStreamerStatus(storage);
    }
  );

  const usernameInput = document.getElementById('streamerUsername');

  // Clear the rejection bubble once the user starts fixing the value.
  usernameInput.addEventListener('input', () => {
    usernameInput.setCustomValidity('');
  });

  document.getElementById('addForm').addEventListener('submit', (evt) => {
    evt.preventDefault();
    const user = usernameInput.value.trim();

    if (!user) {
      return;
    }

    // Block bad values at the source so they never reach storage or the backend.
    if (!isValidTwitchLogin(user)) {
      usernameInput.setCustomValidity(
        'Enter a valid Twitch username: letters, numbers, or underscore (max 25).'
      );
      usernameInput.reportValidity();
      return;
    }

    usernameInput.setCustomValidity('');

    chrome.storage.sync.get('twitchStreams', (storage) => {
      storage.twitchStreams.push(user);
      chrome.storage.sync.set(
        { twitchStreams: Array.from(new Set(storage.twitchStreams)) },
        () => {
          fetchStreamerStatus(storage);
          usernameInput.value = '';
        }
      );
    });
  });

  document.body.addEventListener('click', (evt) => {
    if (evt.target.nodeName === 'A') {
      if (evt.target.classList.contains('twitch-link')) {
        chrome.tabs.create({ url: evt.target.getAttribute('href') });
        evt.preventDefault();
      }

      if (evt.target.classList.contains('remove-all')) {
        chrome.storage.sync.set({ twitchStreams: [] }, () => {
          document.getElementById('emptyState').classList.remove('hidden');
          document.getElementById('streamers').innerHTML = '';
          chrome.action.setBadgeText({
            text: '',
          });
          chrome.action.setTitle({
            title: '',
          });
        });
      }
    }

    if (evt.target.classList.contains('remove')) {
      let parent = evt.target.parentElement;

      if (
        parent.classList.contains('col-xs-12') ||
        parent.classList.contains('col-xs-6')
      ) {
        parent = parent.parentElement.parentElement;
      }

      const streamer = evt.target.getAttribute('data-username');

      chrome.storage.sync.get('twitchStreams', (storage) => {
        const index = storage.twitchStreams.findIndex(
          (item) => item.toLowerCase() === streamer.toLowerCase()
        );

        if (index >= 0) {
          storage.twitchStreams.splice(index, 1);
        }

        chrome.storage.sync.set(
          { twitchStreams: storage.twitchStreams },
          () => {
            parent.remove();
            fetchStreamerStatus(storage);
          }
        );
      });
    }
  });

  document.getElementById('hideOffline').addEventListener('change', (evt) => {
    chrome.storage.sync.set({ hideOffline: !evt.target.checked }, () => {
      hideOffline = !evt.target.checked;
      chrome.storage.sync.get('twitchStreams', fetchStreamerStatus);
    });
  });

  document.getElementById('hidePreviews').addEventListener('change', (evt) => {
    chrome.storage.sync.set({ hidePreviews: !evt.target.checked }, () => {
      hidePreviews = !evt.target.checked;
      chrome.storage.sync.get('twitchStreams', fetchStreamerStatus);
    });
  });

  document
    .getElementById('hideStreamersOnlineCount')
    .addEventListener('change', (evt) => {
      chrome.storage.sync.set(
        { hideStreamersOnlineCount: !evt.target.checked },
        () => {
          hideStreamersOnlineCount = !evt.target.checked;
          updateSetBadgeText(evt.target.checked);
          chrome.storage.sync.get('twitchStreams', fetchStreamerStatus);
        }
      );
    });
});
