const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractUrls,
  isMediaAttachment,
  isMediaEmbed,
  evaluateMediaOnlyMessage,
} = require('../src/discord/mediaOnly');

function makeMessage({ content = '', attachments = [], embeds = [] } = {}) {
  return {
    content,
    attachments,
    embeds,
  };
}

test('extractUrls finds ordinary and angle-bracketed links', () => {
  assert.deepEqual(
    extractUrls('one https://example.com/a two <https://example.com/b>'),
    ['https://example.com/a', 'https://example.com/b']
  );
});

test('isMediaAttachment accepts image, video, and audio attachments', () => {
  assert.equal(isMediaAttachment({ contentType: 'image/png' }), true);
  assert.equal(isMediaAttachment({ contentType: 'video/mp4' }), true);
  assert.equal(isMediaAttachment({ contentType: 'audio/mpeg' }), true);
  assert.equal(isMediaAttachment({ contentType: 'application/pdf' }), false);
});

test('isMediaAttachment uses Discord media metadata when MIME type is unavailable', () => {
  assert.equal(isMediaAttachment({ width: 1920, height: 1080 }), true);
  assert.equal(isMediaAttachment({ duration: 12.5 }), true);
  assert.equal(isMediaAttachment({}), false);
});

test('isMediaEmbed accepts actual image/video media but not thumbnails alone', () => {
  assert.equal(isMediaEmbed({ type: 'video', video: { url: 'https://cdn.example/video.mp4' } }), true);
  assert.equal(isMediaEmbed({ type: 'rich', image: { url: 'https://cdn.example/image.jpg' } }), true);
  assert.equal(isMediaEmbed({ type: 'rich', thumbnail: { url: 'https://cdn.example/thumb.jpg' } }), false);
});

test('allows media attachments with an ordinary caption', () => {
  const result = evaluateMediaOnlyMessage(
    makeMessage({
      content: 'nice photo from today',
      attachments: [{ contentType: 'image/jpeg' }],
    })
  );

  assert.equal(result.allowed, true);
});

test('rejects plain text and non-media files', () => {
  assert.equal(evaluateMediaOnlyMessage(makeMessage({ content: 'hello' })).allowed, false);

  assert.equal(
    evaluateMediaOnlyMessage(
      makeMessage({
        attachments: [{ contentType: 'application/pdf' }],
      })
    ).allowed,
    false
  );
});

test('rejects a non-media attachment even when valid media is also present', () => {
  const result = evaluateMediaOnlyMessage(
    makeMessage({
      attachments: [
        { contentType: 'image/png' },
        { contentType: 'application/zip' },
      ],
    })
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason, /non-media attachment/);
});

test('allows links only when Discord resolves each one to a media embed', () => {
  const allowed = evaluateMediaOnlyMessage(
    makeMessage({
      content: 'https://youtu.be/example',
      embeds: [{ type: 'video', video: { url: 'https://video.example/embed' } }],
    })
  );

  const rejected = evaluateMediaOnlyMessage(
    makeMessage({
      content: 'https://example.com/article',
      embeds: [{ type: 'link', thumbnail: { url: 'https://example.com/thumb.jpg' } }],
    })
  );

  assert.equal(allowed.allowed, true);
  assert.equal(rejected.allowed, false);
});

test('rejects suppressed or unresolved media-looking links', () => {
  const result = evaluateMediaOnlyMessage(
    makeMessage({
      content: '<https://example.com/photo.jpg>',
      embeds: [],
    })
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason, /did not resolve/);
});

test('rejects an unrelated webpage link even when an image attachment is present', () => {
  const result = evaluateMediaOnlyMessage(
    makeMessage({
      content: 'https://example.com',
      attachments: [{ contentType: 'image/png' }],
      embeds: [{ type: 'link', thumbnail: { url: 'https://example.com/thumb.jpg' } }],
    })
  );

  assert.equal(result.allowed, false);
});

test('allows multiple media links when each produces a media embed', () => {
  const result = evaluateMediaOnlyMessage(
    makeMessage({
      content: 'https://example.com/a https://example.com/b',
      embeds: [
        { type: 'image', image: { url: 'https://cdn.example/a.jpg' } },
        { type: 'gifv', video: { url: 'https://cdn.example/b.mp4' } },
      ],
    })
  );

  assert.equal(result.allowed, true);
});

test('allows rich embeds from known audio providers', () => {
  assert.equal(
    isMediaEmbed({
      type: 'rich',
      provider: { name: 'SoundCloud', url: 'https://soundcloud.com' },
      thumbnail: { url: 'https://cdn.example/art.jpg' },
    }),
    true
  );

  assert.equal(
    isMediaEmbed({
      data: {
        type: 'rich',
        provider: { name: 'Spotify', url: 'https://open.spotify.com' },
      },
    }),
    true
  );

  assert.equal(
    isMediaEmbed({
      type: 'rich',
      provider: { name: 'Example News', url: 'https://example.com' },
      thumbnail: { url: 'https://example.com/thumb.jpg' },
    }),
    false
  );
});

test('allows repeated identical media URLs when Discord deduplicates the embed', () => {
  const result = evaluateMediaOnlyMessage(
    makeMessage({
      content: 'https://example.com/a https://example.com/a',
      embeds: [{ type: 'image', image: { url: 'https://cdn.example/a.jpg' } }],
    })
  );

  assert.equal(result.allowed, true);
});
