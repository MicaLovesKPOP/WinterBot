const { escapeMarkdown } = require('discord.js');
const { USER_DISPLAY_MODES } = require('../config');

function sanitizeDisplayText(value) {
  return escapeMarkdown(String(value || 'Unknown user'));
}

function formatUserDisplay({
  member = null,
  record = null,
  mode = USER_DISPLAY_MODES.BOTH,
}) {
  const displayName = sanitizeDisplayText(
    member?.displayName ||
      record?.lastKnownDisplayName ||
      record?.lastKnownUsername ||
      record?.userId ||
      'Unknown user'
  );

  const username = sanitizeDisplayText(
    member?.user?.username ||
      record?.lastKnownUsername ||
      record?.lastKnownDisplayName ||
      record?.userId ||
      'Unknown user'
  );

  if (mode === USER_DISPLAY_MODES.DISPLAY_NAME) return displayName;
  if (mode === USER_DISPLAY_MODES.USERNAME) return username;
  if (displayName === username) return displayName;
  return `${displayName} (${username})`;
}

module.exports = {
  formatUserDisplay,
  sanitizeDisplayText,
};
