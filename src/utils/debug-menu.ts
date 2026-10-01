/** Queued until `initDebugMenu` */
const commands: Array<[label: string, run: () => void]> = [];

/** Debug builds only: a GM menu command that does something */
export function registerDebugCommand(label: string, run: () => void) {
  if (process.env.DEBUG) {
    commands.push([label, run]);
  }
}

/** Debug builds only: the commands, listed after the modules */
export function initDebugMenu() {
  if (!process.env.DEBUG) {
    return;
  }
  for (let i = 0, len = commands.length; i < len; i++) {
    const [label, run] = commands[i];
    GM.registerMenuCommand(`[DEBUG] ${label}`, run);
  }
}
