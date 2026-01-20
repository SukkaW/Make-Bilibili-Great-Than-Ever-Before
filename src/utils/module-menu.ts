import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';

const KEY_PREFIX = 'mbgtbemodule:';

export function initModuleMenu(mod: MakeBilibiliGreatThanEverBeforeModule) {
  const enabled = getEnabled(mod);

  GM.registerMenuCommand(labelFor(enabled, mod), async () => {
    const current = getEnabled(mod);
    await setEnabled(mod, !current);
    try {
      unsafeWindow.location.reload();
    } catch {
      // swallow
    }
  });

  return enabled;
}

function getEnabled(m: MakeBilibiliGreatThanEverBeforeModule) {
  return GM_getValue<boolean>(KEY_PREFIX + m.name, true);
}

async function setEnabled(m: MakeBilibiliGreatThanEverBeforeModule, enabled: boolean) {
  return GM.setValue(KEY_PREFIX + m.name, enabled);
}

function labelFor(enabled: boolean, m: MakeBilibiliGreatThanEverBeforeModule) {
  // use ASCII-friendly symbols to avoid linter/encoding issues
  const mark = enabled ? '[ON]' : '[OFF]';
  return `${mark} ${m.description}`;
}
