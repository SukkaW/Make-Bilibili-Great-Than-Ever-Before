import { noop } from 'foxts/noop';
import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';
import { defineReadonlyProperty } from '../utils/define-readonly-property';
import { noP2PPolicy } from './no-p2p/policy';

/**
 * The player request interceptor's policy phase: no media from P2P / PCDN hosts. The player's
 * P2P URLs are replaced by official ones
 */
const noP2P: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'no-p2p',
  description: '防止叔叔用 P2P CDN 省下纸钱',
  any({ player }) {
    class MockPCDNLoader { }

    class MockBPP2PSDK {
      on = noop;
    }

    class MockSeederSDK { }

    defineReadonlyProperty(unsafeWindow, 'PCDNLoader', MockPCDNLoader);
    defineReadonlyProperty(unsafeWindow, 'BPP2PSDK', MockBPP2PSDK);
    defineReadonlyProperty(unsafeWindow, 'SeederSDK', MockSeederSDK);

    player.registerPhase({
      type: 'policy',
      name: 'no-p2p',
      filter: noP2PPolicy
    });
  }
};

export default noP2P;
