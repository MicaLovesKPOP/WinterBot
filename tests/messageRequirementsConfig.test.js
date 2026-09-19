const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeMessageRequirements,
  loadMessageRequirements,
  parseSnowflakeList,
} = require('../src/config/messageRequirements');

test('parseSnowflakeList deduplicates valid channel IDs', () => {
  assert.deepEqual(
    parseSnowflakeList(
      '123456789012345678, 234567890123456789 123456789012345678',
      'TEST_IDS'
    ),
    ['123456789012345678', '234567890123456789']
  );
});

test('message requirement config normalizes policies and rule defaults', () => {
  const config = normalizeMessageRequirements({
    '123456789012345678': {
      requirements: [
        {
          type: 'requiredLink',
          domains: ['www.Example.com'],
        },
      ],
    },
  });

  assert.equal(config['123456789012345678'].ignoreBots, true);
  assert.deepEqual(config['123456789012345678'].requirements[0], {
    type: 'requiredLink',
    domains: ['example.com'],
    pathPrefixes: [],
    queryParams: {},
    minMatches: 1,
    allowSubdomains: true,
    rejectOtherLinks: false,
  });
});

test('message requirement config rejects unknown rule types', () => {
  assert.throws(
    () =>
      normalizeMessageRequirements({
        '123456789012345678': {
          requirements: [{ type: 'futureMagicRule' }],
        },
      }),
    /Unsupported requirement type/
  );
});

test('message requirement config validates link constraints', () => {
  assert.throws(
    () =>
      normalizeMessageRequirements({
        '123456789012345678': {
          requirements: [{ type: 'requiredLink', domains: [] }],
        },
      }),
    /at least one domain/
  );

  assert.throws(
    () =>
      normalizeMessageRequirements({
        '123456789012345678': {
          requirements: [
            {
              type: 'requiredLink',
              domains: ['example.com'],
              queryParams: { id: '[' },
            },
          ],
        },
      }),
    /Invalid regular expression/
  );
});

test('legacy MEDIA_ONLY_CHANNEL_IDS is merged as mediaOnly requirements', () => {
  const config = loadMessageRequirements({
    filePath: null,
    legacyMediaOnlyChannelIds: ['123456789012345678'],
  });

  assert.deepEqual(config['123456789012345678'], {
    ignoreBots: true,
    requirements: [{ type: 'mediaOnly' }],
  });
});

test('MESSAGE_REQUIREMENTS_JSON overrides the same channel from a file-like config source', () => {
  const config = loadMessageRequirements({
    filePath: null,
    jsonValue: JSON.stringify({
      '123456789012345678': {
        ignoreBots: false,
        requirements: [{ type: 'mediaOnly' }],
      },
    }),
  });

  assert.equal(config['123456789012345678'].ignoreBots, false);
});
