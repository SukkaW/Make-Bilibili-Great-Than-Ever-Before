import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';
import { openSettingsPanel } from './settings-panel';
import type { ModuleSettingsStore } from './settings-panel';

/**
 * Which modules run: the userscript manager stores each one's switch. A single menu command opens
 * the settings panel, where any number of them are switched before one reload applies them all:
 * a module's injections can't be undone in a running page.
 */

const KEY_PREFIX = 'mbgtbemodule:';

export function isModuleEnabled(mod: MakeBilibiliGreatThanEverBeforeModule) {
  return GM_getValue<boolean>(KEY_PREFIX + mod.name, mod.defaultEnabled ?? true);
}

const store: ModuleSettingsStore = {
  isEnabled: isModuleEnabled,
  setEnabled: (mod, enabled) => GM.setValue(KEY_PREFIX + mod.name, enabled),
  // Back to `defaultEnabled`
  reset: mod => GM.deleteValue(KEY_PREFIX + mod.name)
};

/** @param modules every module, as this page runs them */
export function initModuleMenu(modules: readonly MakeBilibiliGreatThanEverBeforeModule[]) {
  const running = new Set<string>();
  for (let i = 0, len = modules.length; i < len; i++) {
    if (isModuleEnabled(modules[i])) {
      running.add(modules[i].name);
    }
  }
  GM.registerMenuCommand('打开设置', () => openSettingsPanel(modules, running, store));
}
