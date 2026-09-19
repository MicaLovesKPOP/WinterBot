const { USER_DISPLAY_MODES } = require('../config');

function formatUserDisplay({ member = null, record = null, mode = USER_DISPLAY_MODES.BOTH }) {
  const displayName =
    member?.displayName ||
    record?.lastKnownDisplayName ||
    record?.lastKnownUsername ||
    record?.userId ||
    'Unknown user';

  const username =
    member?.user?.username ||
    record?.lastKnownUsername ||
    record?.lastKnownDisplayName ||
    record?.userId ||
    'Unknown user';

  if (mode === USER_DISPLAY_MODES.DISPLAY_NAME) return displayName;
  if (mode === USER_DISPLAY_MODES.USERNAME) return username;
  if (displayName === username) return displayName;
  return `${displayName} (${username})`;
}

module.exports = { formatUserDisplay };