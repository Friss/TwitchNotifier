function fetch_feed(storage) {
  if(!storage.twitchStreams){
    storage.twitchStreams = []
    chrome.storage.sync.set({'twitchStreams': storage.twitchStreams}, function() {
        });
  }
  if (storage.twitchStreams.length){
    chrome.extension.sendRequest({'action' : 'fetch_feed', 'usernames' : storage.twitchStreams},
        function(response) {
          display_stories(response);
        }
      );
  }
}

function display_stories(streams) {
  for (var i = streams.length - 1; i >= 0; i--) {
    var json = streams[i]
    var $user = $('li[data-username="'+json.username+'"]');
    if (json.channel){
      var content = "<i class='fa fa-times remove'></i><i class='fa fa-video-camera'></i> <a class='online' href='http://twitch.tv/"+json.username+"'>"+json.channel.display_name+" - "+json.channel.status+"</a><ul class='list-unstyled'><li><i class='fa fa-gamepad'></i> "+json.game+"</li><li><i class='fa fa-users'></i> "+json.viewers+"</li></ul>";
      if ($user.length){
        $user.html(content);
      }else{
        $("#streamers").append("<li data-username="+json.username+">"+content+"</li>");
      }
    }else{
      var content = "<i class='fa fa-times remove'></i><a class='offline' href='http://twitch.tv/"+json.username+"'>"+json.username+"</a>";
      if($user.length){
        $user.html(content);
      }else{
        $("#streamers").append("<li data-username="+json.username+">"+content+"</li>")
      }
    }
  };
}


$(document).ready(function() {
  chrome.storage.sync.get('twitchStreams', fetch_feed);

  $("#form").submit(function (evt) {
    evt.preventDefault();
    var user = $("#username").val();
    if(user){
      chrome.storage.sync.get('twitchStreams', function(storage) {
        storage.twitchStreams.push(user);
        chrome.storage.sync.set({'twitchStreams': storage.twitchStreams}, function() {
          fetch_feed(storage);
          $("#username").val('');
        });
      });
    }
  });

  $("#streamers").on('click', '.remove', function (evt) {
    var $parent = $(this).parent()
    var user = $parent.data('username');

    chrome.storage.sync.get('twitchStreams', function(storage) {
      var index = storage.twitchStreams.indexOf(user);
      if (index > -1) {
        storage.twitchStreams.splice(index, 1);
      }
      chrome.storage.sync.set({'twitchStreams': storage.twitchStreams}, function() {
        $parent.remove();
      });
    });
  });


  $('body').on('click', 'a', function(){
   chrome.tabs.create({url: $(this).attr('href')});
   return false;
  });



});
