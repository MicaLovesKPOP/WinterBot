'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getSchedulingNgrokSettings, startSchedulingNgrokTunnel } = require('../src/scheduling/ngrokTunnel');

const DOMAIN = 'winterbot-trial.ngrok-free.dev';
const TOKEN = 'example-test-token-that-must-not-leak';
const GOOD_ENV = Object.freeze({
  SCHEDULING_ENABLED: '1',
  SCHEDULING_TEST_MODE: '1',
  SCHEDULING_NGROK_ENABLED: '1',
  SCHEDULING_NGROK_DOMAIN: DOMAIN,
  NGROK_AUTHTOKEN: TOKEN,
});

test('ngrok is completely opt-in and not required by WinterBot normal startup', () => {
  assert.equal(getSchedulingNgrokSettings({}), null);
  assert.equal(getSchedulingNgrokSettings({ SCHEDULING_ENABLED:'1', SCHEDULING_TEST_MODE:'1' }), null);
  const sdk = require('@ngrok/ngrok');
  assert.equal(typeof sdk.forward, 'function', 'native ngrok package must load under Node 18 and newer');
});

test('an ngrok tunnel cannot run when the bot or dry-run mode is disabled', () => {
  assert.throws(() => getSchedulingNgrokSettings({ ...GOOD_ENV, SCHEDULING_ENABLED: '0' }), /requires.*TEST_MODE/);
  assert.throws(() => getSchedulingNgrokSettings({ ...GOOD_ENV, SCHEDULING_TEST_MODE: '0' }), /requires.*TEST_MODE/);
  assert.throws(() => getSchedulingNgrokSettings({ ...GOOD_ENV, SCHEDULING_TEST_MODE: '' }), /requires.*TEST_MODE/);
});

test('ngrok configuration derives the HTTPS OAuth URL from the assigned domain', () => {
  const settings = getSchedulingNgrokSettings(GOOD_ENV);
  assert.deepEqual(settings, {
    host:'127.0.0.1', port:8791, domain:DOMAIN,
    baseUrl:'https://' + DOMAIN, authtoken:TOKEN,
  });
  assert.equal(getSchedulingNgrokSettings({
    ...GOOD_ENV, SCHEDULING_NGROK_DOMAIN:'https://' + DOMAIN,
    SCHEDULING_BASE_URL:'https://' + DOMAIN + '/',
  }).baseUrl, 'https://' + DOMAIN);
});

test('ngrok configuration refuses unsafe binding, invalid domain, mismatched OAuth URL or missing secrets', () => {
  const variations = [
    [{...GOOD_ENV, SCHEDULING_HOST:'0.0.0.0'}, /127\.0\.0\.1/],
    [{...GOOD_ENV, SCHEDULING_PORT:'70000'}, /port/],
    [{...GOOD_ENV, SCHEDULING_PORT:'invalid'}, /port/],
    [{...GOOD_ENV, SCHEDULING_NGROK_DOMAIN:'https://evil.example/x'}, /domain/],
    [{...GOOD_ENV, SCHEDULING_NGROK_DOMAIN:'localhost'}, /domain/],
    [{...GOOD_ENV, SCHEDULING_NGROK_DOMAIN:'example.com:8791'}, /domain/],
    [{...GOOD_ENV, SCHEDULING_NGROK_DOMAIN:'a@ngrok-free.dev'}, /domain/],
    [{...GOOD_ENV, SCHEDULING_BASE_URL:'https://another.ngrok-free.dev'}, /does not match/],
    [{...GOOD_ENV, NGROK_AUTHTOKEN:''}, /NGROK_AUTHTOKEN/],
  ];
  for (const [env, pattern] of variations) {
    assert.throws(() => getSchedulingNgrokSettings(env), pattern);
  }
});

test('ngrok forwards localhost only and cleans up exactly once', async () => {
  const settings = getSchedulingNgrokSettings(GOOD_ENV);
  let options, closes=0;
  const fake={forward:async config=>{
    options=config;
    return {url:()=>settings.baseUrl, close:async()=>{closes++;}};
  }};
  const onStatusChange=()=>{};
  const tunnel=await startSchedulingNgrokTunnel(settings,{sdk:fake,onStatusChange});
  assert.equal(tunnel.url,settings.baseUrl);
  assert.equal(options.addr,'127.0.0.1:8791');
  assert.equal(options.authtoken,TOKEN);
  assert.equal(options.domain,DOMAIN);
  assert.equal(options.proto,'http');
  assert.deepEqual(options.schemes,['HTTPS']);
  assert.equal(options.onStatusChange,onStatusChange);
  await tunnel.close();
  await tunnel.close();
  assert.equal(closes,1);
});

test('unexpected ngrok domain fails closed and tears down the listener', async()=>{
  const settings=getSchedulingNgrokSettings(GOOD_ENV);
  let closes=0;
  const sdk={forward:async()=>({url:()=> 'https://unexpected.ngrok-free.dev',close:async()=>{closes++;}})};
  await assert.rejects(startSchedulingNgrokTunnel(settings,{sdk}),/different HTTPS domain/);
  assert.equal(closes,1);
});

test('ngrok SDK failures never leak the authentication token', async()=>{
  const settings=getSchedulingNgrokSettings(GOOD_ENV);
  const sdk={forward:async()=>{throw new Error('invalid auth token ' + TOKEN);}};
  await assert.rejects(startSchedulingNgrokTunnel(settings,{sdk}),error=>{
    assert.match(error.message,/could not start/i);
    assert.ok(!error.message.includes(TOKEN),'secret token must be scrubbed from the error');
    assert.match(error.message,/\[REDACTED\]/);
    return true;
  });
});

test('timed-out ngrok connection cannot create an orphaned public listener', async()=>{
  const settings=getSchedulingNgrokSettings(GOOD_ENV);
  let completeConnection;
  let closes=0;
  const sdk={forward:()=>new Promise(resolve=>{completeConnection=resolve;})};
  await assert.rejects(startSchedulingNgrokTunnel(settings,{sdk,timeoutMs:10}),/startup timeout/);
  completeConnection({url:()=>settings.baseUrl,close:async()=>{closes++;}});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(closes,1,'late native connection must be closed after timeout');
});
