const CHANNEL_API_URI = 'https://twitch.theorycraft.gg/channel-status';
const PREVIEW_IMAGE_BASE_URL = 'https://static-cdn.jtvnw.net/previews-ttv/live_user_';
const NOTIFICATION_ICON_URL = '../images/logo_128.png';
const BADGE_COLOR = '#5cb85c';
const BACKGROUND_FETCH_ALARM_NAME = 'backgroundFetch';
const FETCH_INTERVAL_MINUTES = 5;

/**
 * Generates a URL for the stream preview image.
 * @param {string} userName - The username of the streamer.
 * @param {number} width - Width of the preview image.
 * @param {number} height - Height of the preview image.
 * @returns {string} - URL of the preview image.
 */
const getPreviewUrl = (userName, width, height) =>
    `${PREVIEW_IMAGE_BASE_URL}${userName}-${width}x${height}.jpg`;

/**
 * Creates and displays a Chrome notification.
 * @param {Object} stream - Stream data for the notification.
 */
const createNotification = async (stream) => {
    try {
        const imageResponse = await fetch(getPreviewUrl(stream.username, 640, 360));
        const imageData = await imageResponse.blob();

        const reader = new FileReader();
        reader.readAsDataURL(imageData);
        reader.onloadend = () => {
            const base64data = reader.result;
            const opt = {
                type: 'image',
                title: `${stream.channel.display_name} playing ${stream.game}`,
                message: stream.channel.status,
                iconUrl: NOTIFICATION_ICON_URL,
                imageUrl: base64data,
                buttons: [{title: 'View Stream'}],
            };

            chrome.notifications.create(Math.random().toString(36), opt, (id) => {
                chrome.storage.session.get(['notifications']).then((result) => {
                    const notifications = result.notifications || {};
                    notifications[id] = stream.username;
                    chrome.storage.session.set({notifications});
                });
            });
        };
    } catch (error) {
        console.error('Error creating notification:', error);
    }
};

/**
 * Fetches the online status of streamers and optionally sends notifications.
 * @param {Array<string>} usernames - List of usernames to check.
 * @param {Function} callback - Callback function to execute after fetching status.
 * @param {boolean} sendNotification - Whether to send notifications for online streamers.
 */
const fetchStreamerStatus = async (usernames, callback, sendNotification = true) => {
    try {
        const response = await fetch(CHANNEL_API_URI, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({channels: usernames.map((username) => username.toLowerCase())}),
        });

        const streamersLive = await response.json();
        const {knownOnlineStreamers = {}} = await chrome.storage.local.get('knownOnlineStreamers');

        updateKnownStreamers(streamersLive, knownOnlineStreamers);

        const numOnline = Object.keys(streamersLive).length;
        updateBadgeAndTitle(numOnline, streamersLive);

        if (sendNotification) {
            await notifyNewStreamers(streamersLive, knownOnlineStreamers);
        }

        await chrome.storage.local.set({knownOnlineStreamers});
        const hydratedData = hydrateStreamData(usernames, streamersLive);
        callback(hydratedData);
    } catch (error) {
        console.error('Error fetching streamer status:', error);
    }
};

/**
 * Updates the known streamers by removing offline ones.
 * @param {Object} streamersLive - Object containing live streamers.
 * @param {Object} knownOnlineStreamers - Object containing known online streamers.
 */
const updateKnownStreamers = (streamersLive, knownOnlineStreamers) => {
    Object.keys(knownOnlineStreamers).forEach((streamer) => {
        if (!streamersLive[streamer]) {
            delete knownOnlineStreamers[streamer];
        }
    });
};

/**
 * Updates the extension's badge text and title.
 * @param {number} numOnline - Number of online streamers.
 * @param {Object} streamersLive - Object containing live streamers.
 */
const updateBadgeAndTitle = (numOnline, streamersLive) => {
    chrome.storage.sync.get('hideStreamersOnlineCount', (storage) => {
        if (!storage.hideStreamersOnlineCount) {
            chrome.action.setBadgeText({text: `${numOnline > 0 ? numOnline : ''}`});
        }
    });

    chrome.action.setTitle({
        title: `${numOnline} channels online. ${Object.keys(streamersLive).join(', ')}`,
    });
};

/**
 * Sends notifications for new online streamers.
 * @param {Object} streamersLive - Object containing live streamers.
 * @param {Object} knownOnlineStreamers - Object containing known online streamers.
 */
const notifyNewStreamers = async (streamersLive, knownOnlineStreamers) => {
    for (const streamer of Object.keys(streamersLive)) {
        if (!knownOnlineStreamers[streamer]) {
            knownOnlineStreamers[streamer] = true;
            await createNotification(streamersLive[streamer]);
        }
    }
};

/**
 * Hydrates stream data with usernames that may not be live.
 * @param {Array<string>} usernames - List of usernames to check.
 * @param {Object} streamersLive - Object containing live streamers.
 * @returns {Array<Object>} - Hydrated stream data.
 */
const hydrateStreamData = (usernames, streamersLive) => {
    return usernames.map((username) => streamersLive[username] || {username});
};

/**
 * Handles clicks on notifications and notification buttons.
 * @param {string} id - Notification ID.
 * @param {number} buttonIndex - Index of the clicked button (optional).
 */
const handleClick = (id, buttonIndex) => {
    chrome.storage.session.get(['notifications']).then((result) => {
        const username = result.notifications[id];
        if (buttonIndex === undefined || buttonIndex === 0) {
            chrome.tabs.create({url: `https://twitch.tv/${username}`});
        }
    });
};

/**
 * Handles incoming requests from other parts of the extension.
 * @param {Object} request - Incoming request.
 * @param {Object} sender - The sender of the request.
 * @param {Function} callback - Callback to handle the response.
 * @returns {boolean} - Always returns true to indicate asynchronous response.
 */
const onRequest = async (request, sender, callback) => {
    if (request.action === 'fetchStreamerStatus') {
        try {
            const response = await fetchStreamerStatus(request.usernames);
            callback(response);
        } catch (error) {
            console.error('Error fetching streamer status:', error);
            callback({error: 'Failed to fetch streamer status'});
        }
    } else if (request.action === 'setBadgeText') {
        const {setBadgeText} = request;
        chrome.action.setBadgeText({text: setBadgeText ? '' : ''}, () => {
            callback();
        });
    }
    return true;
};

/**
 * Initializes the extension, setting up alarms and listeners.
 */
const init = () => {
    chrome.runtime.onMessage.addListener(onRequest);
    chrome.notifications.onClicked.addListener((id) => handleClick(id));
    chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => handleClick(id, buttonIndex));
    chrome.action.setBadgeBackgroundColor({color: BADGE_COLOR});

    chrome.alarms.onAlarm.addListener(() => {
        chrome.storage.sync.get('twitchStreams', async (storage) => {
            if (storage.twitchStreams) {
                try {
                    await fetchStreamerStatus(storage.twitchStreams, () => {
                    });
                } catch (e) {
                    console.error('Error fetching streamer status on alarm:', e);
                }
            }
        });
    });

    chrome.runtime.onInstalled.addListener(() => {
        chrome.alarms.get(BACKGROUND_FETCH_ALARM_NAME, (alarm) => {
            if (!alarm) {
                chrome.alarms.create(BACKGROUND_FETCH_ALARM_NAME, {periodInMinutes: FETCH_INTERVAL_MINUTES});
            }
        });
    });
};

// Start the extension
init();
