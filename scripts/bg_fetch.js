var cache = {};
var notifications = {};

function fetch_feed(usernames, callback) {
  var usernamesString = "";
  for (var i = usernames.length - 1; i >= 0; i--) {
    usernamesString += usernames[i]+","
  };
  $.getJSON( "https://api.twitch.tv/kraken/streams?offset=0&limit=100&channel="+usernamesString, function(response) {
      var streams = response.streams;

      for (var i = streams.length - 1; i >= 0; i--) {
        var stream = streams[i]

        stream.username = stream.channel.name;

        var status = cache[stream.channel.name];

        if(!status){
          var xhr = new XMLHttpRequest();
          xhr.open('GET', "http://friss.me/dev/twitch/imagegrabber.php?url="+stream.preview.large, true);
          xhr.responseType = 'blob';
          xhr.onload = function(e) {
            var opt = {
              type: "image",
              title: stream.channel.display_name+" playing "+stream.game,
              message: stream.channel.status,
              iconUrl: 'images/icon_128.png',
              imageUrl: window.URL.createObjectURL(this.response),
              buttons: [
                {
                  "title": "View Stream"
                }
              ]
            }

            chrome.notifications.create("", opt, function(id){notifications[id]=stream.username;});
          };

          xhr.send();
        }

        cache[stream.username] = true;
        var index = usernames.indexOf(stream.username);
        if (index > -1) {
          usernames.splice(index, 1);
        }
      };

      if (usernames.length){
        for (var i = usernames.length - 1; i >= 0; i--) {
          cache[usernames[i]] = false;
          streams.push({"username": usernames[i]})
        };
      }

      callback(streams);
  });
}


function handleClick (id) {
  var url = "http://twitch.tv/"+notifications[id];
  chrome.tabs.create({ url: url });
}


function onRequest(request, sender, callback) {
  if (request.action == 'fetch_feed') {
        fetch_feed(request.usernames, callback);
      }
}

// Wire up the listener.
chrome.extension.onRequest.addListener(onRequest);
chrome.notifications.onClicked.addListener(handleClick);
chrome.notifications.onButtonClicked.addListener(handleClick)

var pollInterval = 1000 * 60; // 1 minute, in milliseconds

function poller(){
    chrome.storage.sync.get('twitchStreams', function(storage){
      if(storage.twitchStreams){
        var len = storage.twitchStreams.length;
        for (var i = 0; i < len; i++){
          stream = storage.twitchStreams[i];
          fetch_feed(stream, function(){})
        }
      }
      window.setTimeout(poller, pollInterval);
    });
}

window.setTimeout(poller, pollInterval);
