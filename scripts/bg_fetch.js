var cache = {};
var notifications = {};

function fetch_feed(usernames, callback) {
  var usernamesString = "";
  for (var i = usernames.length - 1; i >= 0; i--) {
    usernamesString += usernames[i]+","
  };
  if(usernamesString !== ""){
    $.getJSON( "https://api.twitch.tv/kraken/streams?offset=0&limit=100&channel="+usernamesString, function(response) {
      var streams = response.streams;
      for (var i = streams.length - 1; i >= 0; i--) {
        var stream = streams[i];

        stream.username = stream.channel.name;

        var status = cache[stream.channel.name];

        if(!status){
          createNotification(stream);
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
}

function createNotification (stream) {
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

    chrome.notifications.create(stream.username, opt, function(id){notifications[id]=stream.username;});
    mixpanel.track("Notification: Create Notification");
  };

  xhr.send();
}


function handleClick (id) {
  var url = "http://twitch.tv/"+notifications[id];
  chrome.tabs.create({ url: url });
  mixpanel.track("Notification: View Stream");
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
        fetch_feed(storage.twitchStreams, function(){})
      }
      window.setTimeout(poller, pollInterval);
    });
}

window.setTimeout(poller, pollInterval);

function getRandomToken() {
    // E.g. 8 * 32 = 256 bits token
    var randomPool = new Uint8Array(32);
    crypto.getRandomValues(randomPool);
    var hex = '';
    for (var i = 0; i < randomPool.length; ++i) {
        hex += randomPool[i].toString(16);
    }
    // E.g. db18458e2782b2b77e36769c569e263a53885a9944dd0a861e5064eac16f1a
    return hex;
}

chrome.storage.sync.get('userid', function(items) {
    var userid = items.userid;
    if (userid) {
        useToken(userid);
    } else {
        userid = getRandomToken();
        chrome.storage.sync.set({userid: userid}, function() {
            useToken(userid);
        });
    }
    function useToken(userid) {
      mixpanel.identify(userid);
      chrome.storage.sync.get('twitchStreams', function(storage) {
        mixpanel.people.set({
          "streamersFollow": storage.twitchStreams.length
        });
      });
    }
});
