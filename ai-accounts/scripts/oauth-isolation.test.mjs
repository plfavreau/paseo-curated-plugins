import assert from 'node:assert/strict';
import { afterAll, beforeEach, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'ai-accounts-oauth-'));
process.env.XDG_DATA_HOME = scratch;
process.env.XDG_CONFIG_HOME = join(scratch, 'config');
process.env.PASEO_AGENT_ID = 'fixture-owner';
const path = join(scratch, 'ai-accounts', 'accounts.json');
await mkdir(join(scratch, 'ai-accounts'));
const { default: plugin } = await import('../opencode-plugin.ts');
const { ensureFreshAccount, forceRefreshAccount, refreshUsage } = await import('../server/account-store.ts');
const oldFetch = globalThis.fetch;
let calls, vendor;
const seed = (expires, extra = {}) => writeFile(path, JSON.stringify({version: 2, defaultAccountIds: {}, assignments: {'anthropic:fixture-owner': 'fixture'}, accounts: [{id:'fixture', provider:'anthropic', email:'fixture@example.invalid', access:'dummy-old-access', refresh:'dummy-old-refresh', expires, updatedAt:'2026-01-01', ...extra}]}));
const account = async () => JSON.parse(await readFile(path, 'utf8')).accounts[0];
const renewed = () => Response.json({access_token:'dummy-new-access', refresh_token:'dummy-new-refresh', expires_in:28800});
const handler = async () => {
  const hooks = await plugin({client:{}, directory:scratch});
  return hooks.auth.loader(() => {throw Error('managed login fell back to native auth');}, {models:{}});
};
const request = (loaded) => loaded.fetch('https://api.anthropic.com/v1/messages', {method:'POST'});
beforeEach(() => {
  calls = [];
  vendor = () => {throw Error('unexpected fixture request');};
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    assert.ok(['platform.claude.com', 'api.anthropic.com'].includes(url.hostname));
    calls.push(url.pathname);
    return vendor(url, init);
  };
});
afterAll(async () => {globalThis.fetch = oldFetch; await rm(scratch,{recursive:true, force:true});});

test('auth loader neither renews nor rewrites an expired managed login; only Claude request fails', async () => {
  await seed(Date.now()-60_000);
  const before = await readFile(path,'utf8');
  vendor = () => new Response('sensitive-fixture-body', {status:429,headers:{'Retry-After':'60'}});
  const loaded = await handler();
  assert.deepEqual(calls, []);
  assert.equal(await readFile(path,'utf8'), before);
  await assert.rejects(request(loaded), /backing off/);
  await assert.rejects(request(loaded), /backing off/);
  assert.deepEqual(calls,['/v1/oauth/token']);
  assert.ok(!(await account()).needsReauth);
});

test('actual vendor loader uses broker rotation at inference and never falls back for a managed login', async () => {
  await seed(Date.now()-60_000);
  vendor = (url, init) => {
    if (url.pathname === '/v1/oauth/token') return renewed();
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer dummy-new-access');
    return new Response('fixture-ok');
  };
  const loaded = await handler();
  assert.equal(await (await request(loaded)).text(),'fixture-ok');
  assert.deepEqual(calls,['/v1/oauth/token','/v1/messages']);
  await writeFile(path,JSON.stringify({version:2,accounts:[],assignments:{},defaultAccountIds:{}}));
  await assert.rejects(request(loaded), /no longer available/);
  assert.deepEqual(calls,['/v1/oauth/token','/v1/messages']);
});

test('no broker account preserves native auth without sending the internal session header', async () => {
  await writeFile(path,JSON.stringify({version:2,accounts:[],assignments:{},defaultAccountIds:{}}));
  const hooks = await plugin({client:{},directory:scratch});
  const loaded = await hooks.auth.loader(async () => ({type:'oauth',access:'native-fixture',refresh:'unused',expires:Date.now()+60_000}),{models:{}});
  vendor = (url, init) => {
    assert.equal(url.pathname,'/v1/messages');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer native-fixture');
    assert.equal(new Headers(init.headers).has('x-paseo-opencode-session'),false);
    return new Response(null,{status:401});
  };
  assert.equal((await loaded.fetch('https://api.anthropic.com/v1/messages',{headers:{'x-paseo-opencode-session':'fixture-session'}})).status,401);
  assert.deepEqual(calls,['/v1/messages']);
});

test('an existing native OAuth adapter picks up a broker account added after discovery', async () => {
  await writeFile(path,JSON.stringify({version:2,accounts:[],assignments:{},defaultAccountIds:{}}));
  const hooks = await plugin({client:{},directory:scratch});
  const loaded = await hooks.auth.loader(async () => ({type:'oauth',access:'native-fixture',refresh:'unused',expires:Date.now()+60_000}),{models:{}});
  await seed(Date.now()+3_600_000);
  vendor = (url, init) => {
    assert.equal(url.pathname,'/v1/messages');
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer dummy-old-access');
    return new Response('fixture-ok');
  };
  assert.equal(await (await request(loaded)).text(),'fixture-ok');
  assert.deepEqual(calls,['/v1/messages']);
});

for (const status of [400, 429]) test(`out-of-range Retry-After on ${status} cannot prevent persisted backoff`, async () => {
  await seed(Date.now()-60_000);
  vendor = () => new Response(null,{status,headers:{'Retry-After':'99999999999999999999999999'}});
  await assert.rejects(ensureFreshAccount('anthropic'),status===400?/sign in again/:/backing off/);
  const stored = await account();
  assert.ok(Date.parse(stored.refreshRetryAt) > Date.now());
  assert.equal(Boolean(stored.needsReauth),status===400);
});

test('rejected credentials retain the existing one-hour delay despite a long Retry-After', async () => {
  await seed(Date.now()-60_000);
  vendor = () => new Response(null,{status:400,headers:{'Retry-After':'3153600000'}});
  const before = Date.now();
  await assert.rejects(ensureFreshAccount('anthropic'), /sign in again/);
  const stored = await account();
  const deadline = Date.parse(stored.refreshRetryAt);
  assert.ok(deadline >= before + 3_600_000 && deadline <= Date.now() + 3_600_000);
  assert.ok(stored.needsReauth);
});

for (const status of [401, 200]) test(`late usage ${status} cannot mutate a rotated credential`, async () => {
  await seed(Date.now()+3_600_000);
  let started, finish;
  const entered = new Promise(r => started=r);
  const pending = new Promise(r => finish=r);
  vendor = url => url.pathname === '/api/oauth/usage' ? (started(), pending) : renewed();
  const probe = refreshUsage('fixture');
  await entered;
  await forceRefreshAccount('anthropic');
  const snapshot = await account();
  finish(status===401 ? new Response(null,{status}) : Response.json({fixture:true}));
  await probe;
  assert.deepEqual(await account(),snapshot);
});

test('safe failure telemetry preserves retry behavior and does not log raw errors or vendor bodies', async () => {
  await seed(Date.now()-60_000);
  const errors=[];const log=console.error;console.error=(...args)=>errors.push(args);
  try {
    for (const status of [429, 503, 'timeout', 400]) {
      await seed(Date.now()-60_000);
      vendor=()=>{if(status==='timeout')throw new DOMException('sensitive-fixture-exception','TimeoutError');return new Response('sensitive-fixture-body',{status,headers:{'Retry-After':'60'}});};
      await assert.rejects(ensureFreshAccount('anthropic'),status===400?/sign in again/:/backing off/);
      assert.equal(Boolean((await account()).needsReauth),status===400);
    }
  } finally {console.error=log;}
  const text=JSON.stringify(errors);
  assert.doesNotMatch(text,/sensitive-fixture|fixture@example\.invalid|dummy-old/);
  for (const expected of ['429','503','timeout','400','retryAfterMs','backoff','reauth']) assert.ok(text.includes(expected));
});
