let hideOffline = false;
let hidePreviews = false;

const fetchStreamerStatus = storage => {
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
      response => {
        displayStreamerStatus(response);
      }
    );
  } else {
    displayStreamerStatus();
  }
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

const createStreamerEntry = stream => {
  if (!stream.channel) {
    if (hideOffline) {
      return '';
    }

    return `
      <i class='fa fa-times remove'></i>
      <a class='offline twitch-link' href='http://twitch.tv/${
        stream.username
      }'>${stream.username}</a>
    `;
  } else {
    const imageDiv = `
      <div class="col-xs-6">
        <img class="img-responsive" src="${stream.preview.medium}" />
      </div>
    `;

    return `
      <div class="row streamer-online">
        <div class="${hidePreviews ? 'col-xs-12' : 'col-xs-6'}">
          <i class='fa fa-times remove'></i>
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
              ${stream.viewers}
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

const displayStreamerStatus = streams => {
  document.getElementById('loading').classList.add('hidden');

  if (!streams) {
    document.getElementById('emptyState').classList.remove('hidden');
    return;
  }

  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('streamers').innerHTML = '';

  streams.sort(sortStreams).forEach(stream => {
    const html = createStreamerEntry(stream);

    const entry = document.createElement('li');
    entry.innerHTML = html;
    entry.setAttribute('data-username', stream.username);
    document.getElementById('streamers').appendChild(entry);
  });
};

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(
    ['hideOffline', 'hidePreviews', 'twitchStreams'],
    storage => {
      hideOffline = storage.hideOffline;
      document.getElementById('hideOffline').checked = hideOffline;

      hidePreviews = storage.hidePreviews;
      document.getElementById('hidePreviews').checked = hidePreviews;

      fetchStreamerStatus(storage);
    }
  );

  document.getElementById('addForm').addEventListener('submit', evt => {
    evt.preventDefault();
    const user = document.getElementById('streamerUsername').value;
    if (user) {
      chrome.storage.sync.get('twitchStreams', storage => {
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

  document.getElementById('syncFollowers').addEventListener('submit', evt => {
    evt.preventDefault();
    const user = document.getElementById('username').value;
    if (user) {
      chrome.extension.sendRequest(
        {
          action: 'fetchFollows',
          username: user,
        },
        response => {
          displayStreamerStatus(response);
        }
      );
      document.getElementById('username').value = '';
    }
  });

  document.body.addEventListener('click', evt => {
    if (evt.target.nodeName === 'A') {
      if (evt.target.classList.contains('twitch-link')) {
        chrome.tabs.create({ url: evt.target.getAttribute('href') });
        evt.preventDefault();
      }

      if (evt.target.classList.contains('remove-all')) {
        chrome.storage.sync.set({ twitchStreams: [] }, () => {
          document.getElementById('emptyState').classList.remove('hidden');
          document.getElementById('streamers').innerHTML = '';
        });
      }
    }

    if (evt.target.classList.contains('remove')) {
      let parent = evt.target.parentElement;

      if (parent.classList.contains('col-xs-6')) {
        parent = parent.parentElement.parentElement;
      }

      const streamer = parent.getAttribute('data-username');

      chrome.storage.sync.get('twitchStreams', storage => {
        const index = storage.twitchStreams.indexOf(streamer);

        if (index >= 0) {
          storage.twitchStreams.splice(index, 1);
        }

        chrome.storage.sync.set(
          { twitchStreams: storage.twitchStreams },
          () => {
            parent.remove();
          }
        );
      });
    }
  });

  document.getElementById('hideOffline').addEventListener('change', evt => {
    chrome.storage.sync.set({ hideOffline: evt.target.checked }, () => {
      hideOffline = evt.target.checked;
      chrome.storage.sync.get('twitchStreams', fetchStreamerStatus);
    });
  });

  document.getElementById('hidePreviews').addEventListener('change', evt => {
    chrome.storage.sync.set({ hidePreviews: evt.target.checked }, () => {
      hidePreviews = evt.target.checked;
      chrome.storage.sync.get('twitchStreams', fetchStreamerStatus);
    });
  });
});
