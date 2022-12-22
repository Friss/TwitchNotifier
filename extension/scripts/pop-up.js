const getPreviewUrl = (userName, width, height) =>
  `https://static-cdn.jtvnw.net/previews-ttv/live_user_${userName}-${width}x${height}.jpg`;
let hideOffline = false;
let hidePreviews = false;
let hideStreamersOnlineCount = false;

const fetchStreamerStatus = (storage) => {
  if (!storage.twitchStreams) {
    storage.twitchStreams = [];
    chrome.storage.sync.set({ twitchStreams: storage.twitchStreams }, () => {});
  }

  if (storage.twitchStreams.length) {
    chrome.extension.sendRequest(
      {
        action: 'fetchStreamerStatus',
        usernames: Array.from(new Set(storage.twitchStreams)),
      },
      (response) => {
        displayStreamerStatus(response);
      }
    );
  } else {
    displayStreamerStatus();
  }
};

const updateSetBadgeText = (setBadgeText) => {
  chrome.extension.sendRequest(
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
            ${stream.channel.display_name} - ${stream.channel.status}
          </a>
          <ul class="list-unstyled">
            <li>
              <i class="fa fa-gamepad"></i>
              ${stream.game}
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

const displayStreamerStatus = (streams) => {
  document.getElementById('loading').classList.add('hidden');

  if (!streams) {
    document.getElementById('emptyState').classList.remove('hidden');
    return;
  }

  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('streamers').innerHTML = '';

  streams.sort(sortStreams).forEach((stream) => {
    const html = createStreamerEntry(stream);

    const entry = document.createElement('li');
    entry.innerHTML = html;
    entry.setAttribute('data-username', stream.username);
    document.getElementById('streamers').appendChild(entry);
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

  document.getElementById('addForm').addEventListener('submit', (evt) => {
    evt.preventDefault();
    const user = document.getElementById('streamerUsername').value;
    if (user) {
      chrome.storage.sync.get('twitchStreams', (storage) => {
        storage.twitchStreams.push(user);
        chrome.storage.sync.set(
          { twitchStreams: Array.from(new Set(storage.twitchStreams)) },
          () => {
            fetchStreamerStatus(storage);
            document.getElementById('streamerUsername').value = '';
          }
        );
      });
    }
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
          chrome.browserAction.setBadgeText({
            text: '',
          });
          chrome.browserAction.setTitle({
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
        const index = storage.twitchStreams.indexOf(streamer);

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
