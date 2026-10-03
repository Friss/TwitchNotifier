const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
const quietConsole = { log() {}, warn() {}, error() {} };

class Clock {
  now = 0;
  nextId = 0;
  timers = new Map();

  setTimeout = (callback, delay) => {
    const id = ++this.nextId;
    this.timers.set(id, { callback, at: this.now + delay });
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  async advance(milliseconds) {
    const target = this.now + milliseconds;
    await flush();
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.at;
      this.timers.delete(id);
      timer.callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

function loadScript(filename, globals) {
  const context = vm.createContext(globals);
  vm.runInContext(fs.readFileSync(path.join(root, filename), 'utf8'), context);
  return context;
}

function pendingUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

function background(fetch) {
  const clock = new Clock();
  const listeners = {};
  const sockets = [];
  const requests = [];
  const notifications = [];
  const storage = { knownOnlineStreamers: { lirik: true } };
  const event = (name) => ({ addListener: (fn) => (listeners[name] = fn) });

  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = Socket.CONNECTING;
    messages = [];
    constructor() {
      sockets.push(this);
    }
    send(message) {
      this.messages.push(message);
    }
  }

  class Reader {
    result = 'data:image/jpeg;base64,test';
    readAsDataURL() {
      queueMicrotask(() => this.onloadend());
    }
  }

  const chrome = {
    runtime: {
      onMessage: event('message'),
      onStartup: event('startup'),
      onInstalled: event('installed'),
    },
    storage: {
      sync: {
        get: async () => ({ twitchStreams: ['lirik', 'stormfall33'] }),
        set: async () => {},
      },
      local: {
        get: async () => structuredClone(storage),
        set: async (data) => Object.assign(storage, plain(data)),
      },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: event('changed'),
    },
    notifications: {
      onClicked: event('clicked'),
      onButtonClicked: event('buttonClicked'),
      create: (id, options, callback) => {
        notifications.push(options);
        callback(id);
      },
    },
    action: {
      setBadgeBackgroundColor() {},
      setBadgeText: async () => {},
      setTitle: async () => {},
    },
    alarms: {
      get: async () => null,
      create: async () => {},
      onAlarm: event('alarm'),
    },
  };
  const context = loadScript('extension/scripts/background.js', {
    chrome,
    WebSocket: Socket,
    FileReader: Reader,
    AbortController,
    crypto: require('node:crypto').webcrypto,
    console: quietConsole,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    fetch: (url, options) => {
      requests.push({ url, options });
      return fetch(url, options, requests.length);
    },
  });
  return {
    context,
    clock,
    listeners,
    sockets,
    requests,
    notifications,
    storage,
  };
}

function popup(sendMessage) {
  const clock = new Clock();
  const requests = [];
  function element(hidden = false) {
    const classes = new Set(hidden ? ['hidden'] : []);
    return {
      classList: {
        add: (value) => classes.add(value),
        remove: (value) => classes.delete(value),
        contains: (value) => classes.has(value),
      },
      innerHTML: '',
      children: [],
      appendChild(child) {
        this.children.push(child);
      },
      setAttribute() {},
    };
  }
  const elements = {
    loading: element(),
    emptyState: element(true),
    errorState: element(true),
    streamers: element(),
  };
  const context = loadScript('extension/scripts/pop-up.js', {
    console: quietConsole,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    document: {
      addEventListener() {},
      getElementById: (id) => elements[id],
      createElement: () => element(),
    },
    chrome: {
      storage: { sync: { set() {} } },
      runtime: {
        sendMessage: (message) => {
          requests.push(message);
          return sendMessage(message, requests.length);
        },
      },
    },
  });
  const start = () =>
    vm.runInContext("fetchStreamerStatus({twitchStreams: ['lirik']})", context);
  return { context, clock, elements, requests, start };
}

test('hung fetches abort twice and answer the popup without clearing known live state', async () => {
  const app = background((url, options) => pendingUntilAbort(options.signal));
  const replies = [];
  assert.equal(
    app.listeners.message(
      { action: 'fetchStreamerStatus', usernames: ['lirik'] },
      null,
      (reply) => replies.push(plain(reply))
    ),
    true
  );
  await app.clock.advance(9999);
  assert.equal(replies.length, 0);
  assert.equal(app.requests[0].options.signal.aborted, false);
  await app.clock.advance(1);
  assert.equal(app.requests[0].options.signal.aborted, true);
  await app.clock.advance(750);
  assert.equal(app.requests.length, 2);
  await app.clock.advance(10000);
  assert.deepEqual(replies, [[]]);
  assert.equal(app.requests[1].options.signal.aborted, true);
  assert.deepEqual(app.storage.knownOnlineStreamers, { lirik: true });
  assert.equal(app.clock.timers.size, 0);
});

test('the fetch deadline includes a response body that never completes', async () => {
  const app = background(async (url, options) => ({
    ok: true,
    json: () => pendingUntilAbort(options.signal),
  }));
  let settled = false;
  const request = vm.runInContext("fetchChannelStatus(['lirik'])", app.context);
  const rejection = assert.rejects(request, { name: 'AbortError' }).then(() => {
    settled = true;
  });
  await app.clock.advance(20750);
  await rejection;
  assert.equal(settled, true);
  assert.equal(app.requests.length, 2);
  assert.equal(app.clock.timers.size, 0);
});

test('a timed-out fetch can recover on retry and successful timers are cleared', async () => {
  const app = background((url, options, attempt) =>
    attempt === 1
      ? pendingUntilAbort(options.signal)
      : Promise.resolve({
          ok: true,
          json: async () => ({ lirik: { username: 'lirik' } }),
        })
  );
  const request = vm.runInContext("fetchChannelStatus(['lirik'])", app.context);
  await app.clock.advance(10750);
  assert.deepEqual(plain(await request), { lirik: { username: 'lirik' } });
  assert.equal(app.requests.length, 2);
  assert.equal(app.clock.timers.size, 0);
  await app.clock.advance(30000);
  assert.equal(app.requests[1].options.signal.aborted, false);
});

test('a healthy response does not wait for its deadline or retry', async () => {
  const app = background(async () => ({ ok: true, json: async () => ({}) }));
  assert.deepEqual(
    plain(await vm.runInContext("fetchChannelStatus(['lirik'])", app.context)),
    {}
  );
  assert.equal(app.requests.length, 1);
  assert.equal(app.clock.timers.size, 0);
});

test('a missing worker reply retries once then hides the spinner and shows the error', async () => {
  const app = popup(() => new Promise(() => {}));
  app.start();
  await app.clock.advance(24999);
  assert.equal(app.requests.length, 1);
  assert.equal(app.elements.loading.classList.contains('hidden'), false);
  await app.clock.advance(1501);
  assert.equal(app.requests.length, 2);
  await app.clock.advance(25000);
  assert.equal(app.elements.loading.classList.contains('hidden'), true);
  assert.equal(app.elements.errorState.classList.contains('hidden'), false);
  assert.equal(app.elements.emptyState.classList.contains('hidden'), true);
  assert.equal(app.clock.timers.size, 0);
});

test('a late first reply cannot overwrite a successful retry', async () => {
  let lateReply;
  const app = popup((message, attempt) =>
    attempt === 1
      ? new Promise((resolve) => (lateReply = resolve))
      : Promise.resolve([{ username: 'lirik' }])
  );
  app.start();
  await app.clock.advance(26500);
  assert.equal(app.elements.streamers.children.length, 1);
  const entry = app.elements.streamers.children[0];
  lateReply([{ username: 'different_channel' }]);
  await flush();
  assert.equal(app.elements.streamers.children.length, 1);
  assert.equal(app.elements.streamers.children[0], entry);
  assert.equal(app.elements.errorState.classList.contains('hidden'), true);
  assert.equal(app.clock.timers.size, 0);
});

test('a late reply cannot remove the error state after both message deadlines', async () => {
  const replies = [];
  const app = popup(() => new Promise((resolve) => replies.push(resolve)));
  app.elements.streamers.innerHTML = 'previously rendered state';
  app.start();
  await app.clock.advance(51500);
  replies.forEach((resolve) => resolve([{ username: 'lirik' }]));
  await flush();
  assert.equal(app.elements.errorState.classList.contains('hidden'), false);
  assert.equal(app.elements.streamers.innerHTML, 'previously rendered state');
  assert.equal(app.clock.timers.size, 0);
});

test('message rejection still takes the existing retry path and clears deadlines', async () => {
  const app = popup(() => Promise.reject(new Error('Worker unavailable')));
  app.start();
  await app.clock.advance(1500);
  assert.equal(app.requests.length, 2);
  assert.equal(app.elements.errorState.classList.contains('hidden'), false);
  assert.equal(app.clock.timers.size, 0);
});

test('cold-start snapshots suppress alerts, reconnect snapshots notify missed starts', async () => {
  const app = background(async () => ({ blob: async () => ({}) }));
  app.storage.knownOnlineStreamers = {};
  app.listeners.startup();
  await flush();
  const initial = app.sockets[0];
  initial.readyState = 1;
  initial.onopen();
  initial.onmessage({
    data: JSON.stringify({
      type: 'SNAPSHOT',
      live: { lirik: { username: 'lirik' } },
    }),
  });
  await flush();
  assert.deepEqual(app.storage.knownOnlineStreamers, { lirik: true });
  assert.equal(app.notifications.length, 0);

  initial.readyState = 3;
  initial.onclose();
  await vm.runInContext('connectWebSocket()', app.context);
  const reconnect = app.sockets[1];
  reconnect.readyState = 1;
  reconnect.onopen();
  const live = {
    lirik: { username: 'lirik' },
    stormfall33: {
      username: 'stormfall33',
      channel: { display_name: 'Storm' },
      game: 'Game',
    },
  };
  reconnect.onmessage({ data: JSON.stringify({ type: 'SNAPSHOT', live }) });
  await flush();
  assert.equal(app.notifications.length, 1);
  assert.deepEqual(app.storage.knownOnlineStreamers, {
    lirik: true,
    stormfall33: true,
  });
  reconnect.onmessage({ data: JSON.stringify({ type: 'SNAPSHOT', live }) });
  await flush();
  assert.equal(app.notifications.length, 1);
});
