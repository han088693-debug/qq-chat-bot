import assert from 'node:assert/strict';
import dns from 'node:dns';
import { test } from 'node:test';

let sequence = 0;
async function withPolicy({ allow, block, addresses }, run) {
  const originalLookup = dns.promises.lookup;
  const originalAllow = process.env.SAFE_FETCH_ALLOW_FAKE_IP;
  const originalBlock = process.env.SAFE_FETCH_BLOCK_FAKE_IP;
  for (const [name, value] of [['SAFE_FETCH_ALLOW_FAKE_IP', allow], ['SAFE_FETCH_BLOCK_FAKE_IP', block]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  dns.promises.lookup = async () => addresses;
  try {
    const moduleUrl = new URL('../src/safe-fetch.js', import.meta.url);
    moduleUrl.searchParams.set('policy-test', String(++sequence));
    await run(await import(moduleUrl.href));
  } finally {
    dns.promises.lookup = originalLookup;
    for (const [name, value] of [['SAFE_FETCH_ALLOW_FAKE_IP', originalAllow], ['SAFE_FETCH_BLOCK_FAKE_IP', originalBlock]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const fakeAddresses = [
  { address: '198.18.0.1', family: 4 },
  { address: '2001:2::1', family: 6 },
];

test('arbitrary domains resolving to proxy benchmark ranges are rejected by default', async () => {
  for (const address of fakeAddresses) {
    await withPolicy({ addresses: [address] }, async ({ resolveSafeAddresses }) => {
      await assert.rejects(resolveSafeAddresses('fixture.example'), /已阻止/);
    });
  }
});

test('the existing Tencent media exception remains available by default', async () => {
  await withPolicy({ addresses: fakeAddresses }, async ({ resolveSafeAddresses }) => {
    assert.deepEqual(await resolveSafeAddresses('media.qpic.cn'), fakeAddresses.map(({ address }) => address));
    await assert.rejects(resolveSafeAddresses('evilqpic.cn'), /已阻止/);
  });
});

test('general proxy fake-IP support requires an explicit opt-in', async () => {
  await withPolicy({ allow: '1', addresses: fakeAddresses }, async ({ resolveSafeAddresses }) => {
    assert.deepEqual(await resolveSafeAddresses('fixture.example'), fakeAddresses.map(({ address }) => address));
  });
});

test('force blocking overrides both the opt-in and the Tencent media exception', async () => {
  await withPolicy({ allow: '1', block: '1', addresses: fakeAddresses }, async ({ resolveSafeAddresses }) => {
    await assert.rejects(resolveSafeAddresses('fixture.example'), /已阻止/);
    await assert.rejects(resolveSafeAddresses('media.qpic.cn'), /已阻止/);
  });
});

test('opting in never permits private DNS answers or direct fake-IP literals', async () => {
  await withPolicy({ allow: '1', addresses: [{ address: '192.168.1.1', family: 4 }] }, async ({ resolveSafeAddresses }) => {
    await assert.rejects(resolveSafeAddresses('fixture.example'), /已阻止/);
    for (const literal of ['198.18.0.1', '2001:2::1', '127.0.0.1', '192.168.1.1']) {
      await assert.rejects(resolveSafeAddresses(literal), /禁止访问/);
    }
  });
});

test('every DNS answer is still checked when general fake-IP support is enabled', async () => {
  await withPolicy({
    allow: '1',
    addresses: [fakeAddresses[0], { address: '10.0.0.1', family: 4 }],
  }, async ({ resolveSafeAddresses }) => {
    await assert.rejects(resolveSafeAddresses('fixture.example'), /已阻止/);
  });
});
