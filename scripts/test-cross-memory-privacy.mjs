// Run the real bridge against temporary state; no QQ/DSH or external network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(crossMemory, run) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 10001,
      allow: { private: ['10001', '10002', '10003'], groups: ['20001'] },
      socialV2: crossMemory === undefined ? {} : { crossMemory },
    },
    files: {
      'state/cross-memory.json': {
        version: 1,
        people: {
          '10001': { name: 'fixture owner' },
          '10003': { name: 'fixture peer' },
        },
      },
    },
  });
  try {
    for (const [key, marker] of [
      ['private:10001', 'OWNER_PRIVATE_MARKER'],
      ['private:10003', 'PEER_PRIVATE_MARKER'],
      ['group:20001', 'GROUP_PRIVATE_MARKER'],
    ]) {
      const state = h.getSocialV2State(key);
      state.lastIncomingAt = Date.now();
      state.recentMessages = [{ text: marker, time: Date.now(), isSelf: false }];
    }
    await run(h);
  } finally {
    await h.close();
  }
}

test('existing cross-chat data is not injected without explicit enablement', () =>
  fixture(undefined, h => {
    assert.equal(h.formatCrossMemoryV2('private:10002'), '');
  }));

test('explicit enablement permits registered peers but excludes owner and groups', () =>
  fixture({ enabled: true }, h => {
    const text = h.formatCrossMemoryV2('private:10002');
    assert.match(text, /PEER_PRIVATE_MARKER/);
    assert.doesNotMatch(text, /OWNER_PRIVATE_MARKER|GROUP_PRIVATE_MARKER/);
    assert.equal(h.formatCrossMemoryV2('group:20001'), '');
  }));

test('turning cross-chat memory off stops further injection immediately', () =>
  fixture({ enabled: true }, h => {
    assert.match(h.formatCrossMemoryV2('private:10002'), /PEER_PRIVATE_MARKER/);
    h.cfg.socialV2.crossMemory.enabled = false;
    assert.equal(h.formatCrossMemoryV2('private:10002'), '');
  }));
