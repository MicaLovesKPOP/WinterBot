let lastDisconnectAt = 0;
let isDisconnected = false;

function registerConnectionTracking(client) {
  client.on('disconnect', () => {
    lastDisconnectAt = Date.now();
    isDisconnected = true;
  });

  client.on('reconnecting', () => {
    lastDisconnectAt = Date.now();
    isDisconnected = true;
  });

  client.on('ready', () => {
    isDisconnected = false;
  });
}

function getConnectionOfflineMs() {
  if (!lastDisconnectAt) return 0;
  return Date.now() - lastDisconnectAt;
}

function wasDisconnected() {
  return isDisconnected;
}

module.exports = {
  registerConnectionTracking,
  getConnectionOfflineMs,
  wasDisconnected,
};