const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractUrls,
  isMediaAttachment,
  isMediaEmbed,
  urlMatchesRequiredLinkRule,
  evaluateMediaOnly,
  evaluateRequiredLink,
  evaluateMessageRequirements,
} = require('../src/discord/messageRequirements');

function makeMessage({ content = '', attachments = [], embeds = [] } = {}) {
  return { content, attachments, embeds };
}

function workshopRule(overrides = {}) {
  return {
    type: 'requiredLink',
    domains: ['steamcommunity.com'],
    pathPrefixes: ['/sharedfiles/filedetails', '/workshop/filedetails'],
    queryParams: { id: '^\\d+$' },
    minMatches: 1,
    allowSubdomains: true,
    rejectOtherLinks: false,
    ...overrides,
  };
}

test('extractUrls finds normal and angle-bracketed links and trims punctuation', () => {
  assert.deepEqual(
    extractUrls('one https://example.com/a, two <https://example.com/b>.'),
    ['https://example.com/a', 'https://example.com/b']
  );
});

test('media detection accepts image, video, and audio attachments', () => {
  assert.equal(isMediaAttachment({ contentType: 'image/png' }), true);
  assert.equal(isMediaAttachment({ contentType: 'video/mp4' }), true);
  assert.equal(isMediaAttachment({ contentType: 'audio/mpeg' }), true);
  assert.equal(isMediaAttachment({ contentType: 'application/pdf' }), false);
});

test('media detection uses Discord media metadata when MIME type is unavailable', () => {
  assert.equal(isMediaAttachment({ width: 1920, height: 1080 }), true);
  assert.equal(isMediaAttachment({ duration: 12.5 }), true);
  assert.equal(isMediaAttachment({}), false);
});

test('media embed detection accepts actual image/video media but not thumbnails alone', () => {
  assert.equal(isMediaEmbed({ type: 'video', video: { url: 'https://cdn.example/video.mp4' } }), true);
  assert.equal(isMediaEmbed({ type: 'rich', image: { url: 'https://cdn.example/image.jpg' } }), true);
  assert.equal(isMediaEmbed({ type: 'rich', thumbnail: { url: 'https://cdn.example/thumb.jpg' } }), false);
});

test('mediaOnly allows media with captions and rejects plain text/non-media files', () => {
  assert.equal(
    evaluateMediaOnly(
      makeMessage({
        content: 'nice photo',
        attachments: [{ contentType: 'image/jpeg' }],
      })
    ).allowed,
    true
  );

  assert.equal(evaluateMediaOnly(makeMessage({ content: 'hello' })).allowed, false);
  assert.equal(
    evaluateMediaOnly(makeMessage({ attachments: [{ contentType: 'application/pdf' }] })).allowed,
    false
  );
});

test('mediaOnly rejects mixed media/non-media attachments and unrelated links', () => {
  assert.equal(
    evaluateMediaOnly(
      makeMessage({
        attachments: [{ contentType: 'image/png' }, { contentType: 'application/zip' }],
      })
    ).allowed,
    false
  );

  assert.equal(
    evaluateMediaOnly(
      makeMessage({
        content: 'https://example.com',
        attachments: [{ contentType: 'image/png' }],
        embeds: [{ type: 'link', thumbnail: { url: 'https://example.com/thumb.jpg' } }],
      })
    ).allowed,
    false
  );
});

test('mediaOnly accepts media links only when Discord resolves them to media', () => {
  assert.equal(
    evaluateMediaOnly(
      makeMessage({
        content: 'https://youtu.be/example',
        embeds: [{ type: 'video', video: { url: 'https://video.example/embed' } }],
      })
    ).allowed,
    true
  );

  assert.equal(
    evaluateMediaOnly(
      makeMessage({
        content: '<https://example.com/photo.jpg>',
        embeds: [],
      })
    ).allowed,
    false
  );
});

test('mediaOnly recognizes common audio providers and duplicate media URLs', () => {
  assert.equal(
    isMediaEmbed({
      type: 'rich',
      provider: { name: 'SoundCloud', url: 'https://soundcloud.com' },
      thumbnail: { url: 'https://cdn.example/art.jpg' },
    }),
    true
  );

  assert.equal(
    evaluateMediaOnly(
      makeMessage({
        content: 'https://example.com/a https://example.com/a',
        embeds: [{ type: 'image', image: { url: 'https://cdn.example/a.jpg' } }],
      })
    ).allowed,
    true
  );
});

test('requiredLink accepts both common Steam Workshop item URL forms', () => {
  const rule = workshopRule();

  assert.equal(
    urlMatchesRequiredLinkRule(
      'https://steamcommunity.com/sharedfiles/filedetails/?id=3722400658',
      rule
    ),
    true
  );
  assert.equal(
    urlMatchesRequiredLinkRule(
      'https://steamcommunity.com/workshop/filedetails/?id=1445498636',
      rule
    ),
    true
  );
});

test('requiredLink rejects Steam pages that are not Workshop item links', () => {
  const rule = workshopRule();

  assert.equal(
    urlMatchesRequiredLinkRule('https://steamcommunity.com/app/4000/discussions/1/', rule),
    false
  );
  assert.equal(
    urlMatchesRequiredLinkRule('https://steamcommunity.com/sharedfiles/filedetails/?id=not-a-number', rule),
    false
  );
  assert.equal(
    urlMatchesRequiredLinkRule('https://store.steampowered.com/app/4000/', rule),
    false
  );
});

test('requiredLink requires at least one matching URL but allows surrounding text', () => {
  const rule = workshopRule();

  assert.equal(
    evaluateRequiredLink(
      makeMessage({
        content:
          'Try this one: https://steamcommunity.com/sharedfiles/filedetails/?id=3722400658',
      }),
      rule
    ).allowed,
    true
  );

  assert.equal(evaluateRequiredLink(makeMessage({ content: 'no link here' }), rule).allowed, false);
});

test('requiredLink can reject additional non-matching links when configured', () => {
  const rule = workshopRule({ rejectOtherLinks: true });

  const result = evaluateRequiredLink(
    makeMessage({
      content:
        'https://steamcommunity.com/sharedfiles/filedetails/?id=3722400658 https://example.com',
    }),
    rule
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason, /does not match/);
});

test('multiple requirements are ANDed for one channel policy', () => {
  const policy = {
    ignoreBots: true,
    requirements: [
      { type: 'mediaOnly' },
      workshopRule(),
    ],
  };

  assert.equal(
    evaluateMessageRequirements(
      makeMessage({
        content: 'https://steamcommunity.com/sharedfiles/filedetails/?id=3722400658',
        embeds: [{ type: 'image', image: { url: 'https://cdn.example/workshop.jpg' } }],
      }),
      policy
    ).allowed,
    true
  );

  assert.equal(
    evaluateMessageRequirements(
      makeMessage({
        attachments: [{ contentType: 'image/png' }],
      }),
      policy
    ).allowed,
    false
  );
});


test('requiredLink works with arbitrary domains and optional subdomain matching', () => {
  const rule = {
    type: 'requiredLink',
    domains: ['example.com'],
    pathPrefixes: [],
    queryParams: {},
    minMatches: 1,
    allowSubdomains: true,
    rejectOtherLinks: false,
  };

  assert.equal(urlMatchesRequiredLinkRule('https://docs.example.com/item/42', rule), true);
  assert.equal(urlMatchesRequiredLinkRule('https://notexample.com/item/42', rule), false);

  assert.equal(
    urlMatchesRequiredLinkRule('https://docs.example.com/item/42', {
      ...rule,
      allowSubdomains: false,
    }),
    false
  );
});

test('requiredLink supports domain-only requirements without path/query constraints', () => {
  const rule = {
    type: 'requiredLink',
    domains: ['example.org'],
    pathPrefixes: [],
    queryParams: {},
    minMatches: 1,
    allowSubdomains: true,
    rejectOtherLinks: false,
  };

  assert.equal(
    evaluateRequiredLink(
      makeMessage({ content: 'See https://example.org/anything/goes?x=1' }),
      rule
    ).allowed,
    true
  );
});
