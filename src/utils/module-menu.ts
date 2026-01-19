import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';

const KEY_PREFIX = 'mbgtbemodule:';

export async function initModuleMenu(mod: MakeBilibiliGreatThanEverBeforeModule) {
  const enabled = await getEnabled(mod);

  GM.registerMenuCommand(labelFor(enabled, mod), async () => {
    const current = await getEnabled(mod);
    await setEnabled(mod, !current);
    try {
      unsafeWindow.location.reload();
    } catch {
      // swallow
    }
  });

  return enabled;
}

async function getEnabled(m: MakeBilibiliGreatThanEverBeforeModule) {
  const key = KEY_PREFIX + m.name;
  return GM.getValue<boolean>(key, true);
}

async function setEnabled(m: MakeBilibiliGreatThanEverBeforeModule, enabled: boolean) {
  const key = KEY_PREFIX + m.name;
  await GM.setValue(key, enabled);
}

function labelFor(enabled: boolean, m: MakeBilibiliGreatThanEverBeforeModule) {
  // use ASCII-friendly symbols to avoid linter/encoding issues
  const mark = enabled ? '[ON]' : '[OFF]';
  return `${mark} ${m.description}`;
}
