const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');

const {
  assertChannelPermissions,
} = require('../src/discord/guildResources');

test('assertChannelPermissions fails fast on missing required permissions', () => {
  const granted = new Set([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
  ]);

  const channel = {
    id: '123',
    permissionsFor: () => ({
      has: (flag) => granted.has(flag),
    }),
  };

  assert.throws(
    () =>
      assertChannelPermissions(
        channel,
        { id: 'bot' },
        [
          {
            flag: PermissionFlagsBits.ViewChannel,
            name: 'View Channel',
          },
          {
            flag: PermissionFlagsBits.ManageMessages,
            name: 'Manage Messages',
          },
        ],
        'test channel'
      ),
    /Manage Messages/
  );
});

test('assertChannelPermissions accepts a fully permitted channel', () => {
  const channel = {
    id: '123',
    permissionsFor: () => ({
      has: () => true,
    }),
  };

  assert.doesNotThrow(() =>
    assertChannelPermissions(
      channel,
      { id: 'bot' },
      [
        {
          flag: PermissionFlagsBits.ViewChannel,
          name: 'View Channel',
        },
      ],
      'test channel'
    )
  );
});
