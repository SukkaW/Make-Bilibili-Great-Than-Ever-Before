import { logger } from '../logger';
import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';
import {
  indexedDB as mockIndexedDB
} from 'fake-indexeddb';
import { createRetrieKeywordFilter } from 'foxts/retrie';
import { createFakeNativeFunction } from '../utils/fake-native-function';
import { noop } from 'foxts/noop';

const DEFUSED_INDEXEDDB = new Set([
  'PLAYER__LOG',
  'MIRROR_TRACK_V2',
  'pbp3',
  'BILI_MIRROR_REPORT_POOL',
  'BILI_MIRROR_RESOURCE_TIME',
  'bp_nc_loader_config'
]);

const defusedPatterm = createRetrieKeywordFilter([
  'MIRROR_TRACK', '__LOG', 'BILI_MIRROR_REPORT_POOL', 'BILI_MIRROR_RESOURCE_TIME', 'reporter-pb',
  'pbp3',
  'pcdn', 'nc_loader',
  'iconify'
]);

const defuseStorage: MakeBilibiliGreatThanEverBeforeModule = {
  name: 'disable-av1',
  description: '防止叔叔用 AV1 格式燃烧你的 CPU 并省下棺材钱',
  any() {
    DEFUSED_INDEXEDDB.forEach((name) => {
      const req = mockIndexedDB.deleteDatabase(name);
      req.addEventListener('success', () => {
        logger.info('IndexedDB deleted!', { name });
      });
      req.addEventListener('error', () => {
        logger.info('IndexedDB delete failed!', { name });
      });
    });

    for (let i = 0; i < unsafeWindow.localStorage.length; i++) {
      const key = unsafeWindow.localStorage.key(i);
      if (key && defusedPatterm(key)) {
        unsafeWindow.localStorage.removeItem(key);
        logger.info('localStorage removed!', { key });
      }
    }

    ((origOpen) => {
      unsafeWindow.indexedDB.open = createFakeNativeFunction(function (this: IDBFactory, name, version) {
        if (defusedPatterm(name)) {
          logger.trace('IndexedDB mocked!', { name, version });
          return mockIndexedDB.open(name, version);
        }

        logger.trace('IndexedDB opened!', { name, version });
        return origOpen.call(this, name, version);
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- override native method
    })(unsafeWindow.indexedDB.open);

    ((orignalLocalStorage) => {
      const store = new Map<string, string>();
      const keys: string[] = Object.keys(orignalLocalStorage);

      const mockedLocalStorage: Storage = {
        setItem(key, value) {
          keys.push(key);

          if (defusedPatterm(key)) {
            logger.trace('localStorage.setItem mocked:', { key, value });
            store.set(key, value);
          } else {
            // logger.trace('localStorage.setItem:', { key, value });
            orignalLocalStorage.setItem(key, value);
          }
        },
        getItem(key) {
          if (defusedPatterm(key)) {
            const value = store.has(key) ? store.get(key)! : null;
            logger.trace('localStorage.getItem mocked:', { key, value });
            return value;
          }

          // logger.trace('localStorage.getItem:', { key });
          return orignalLocalStorage.getItem(key);
        },
        removeItem(key) {
          const keyIndex = keys.indexOf(key);
          if (keyIndex > -1) {
            keys.splice(keys.indexOf(key), 1);
          }

          if (defusedPatterm(key)) {
            logger.trace('localStorage.removeItem mocked:', { key });
            store.delete(key);
          } else {
            // logger.trace('localStorage.removeItem:', { key });
            orignalLocalStorage.removeItem(key);
          }
        },
        clear() {
          logger.trace('localStorage.clear mocked');
          store.clear();
          orignalLocalStorage.clear();

          keys.length = 0;
        },
        get length() {
          return store.size + localStorage.length;
        },
        key(index) {
          const realIndex = keys.length - index - 1;
          return keys[realIndex] ?? null;
        }
      };

      Object.defineProperty(unsafeWindow, 'localStorage', {
        get() {
          return mockedLocalStorage;
        },
        enumerable: true,
        configurable: false,
        set: noop
      });
    })(unsafeWindow.localStorage);
  }
};

export default defuseStorage;
