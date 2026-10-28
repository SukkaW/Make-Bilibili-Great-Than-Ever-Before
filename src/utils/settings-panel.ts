import { noop } from 'foxts/noop';
import type { MakeBilibiliGreatThanEverBeforeModule } from '../types';

/**
 * The settings panel: every module's switch in one dialog, in a shadow root so that the page's
 * styles stay out. A switch is saved at once and applies from the next load: switch any number of
 * them, then reload once.
 */

type Module = MakeBilibiliGreatThanEverBeforeModule;

export interface ModuleSettingsStore {
  isEnabled(this: void, mod: Module): boolean,
  setEnabled(this: void, mod: Module, enabled: boolean): Promise<void>,
  reset(this: void, mod: Module): Promise<void>
}

const STYLE = `
:host { all: initial; }
dialog {
  --fg: #18191c; --muted: #61666d; --line: #e3e5e7; --hover: #f1f2f3; --bg: #fff; --accent: #fb7299;
  width: min(480px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 32px));
  padding: 0; border: none; border-radius: 12px; color: var(--fg); background: var(--bg);
  box-shadow: 0 12px 48px rgb(0 0 0 / 30%);
  font: 14px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
@media (prefers-color-scheme: dark) {
  dialog { --fg: #e3e5e7; --muted: #9499a0; --line: #2f3134; --hover: #26272a; --bg: #1c1d20; }
}
dialog::backdrop { background: rgb(0 0 0 / 40%); }
.panel { display: flex; flex-direction: column; max-height: inherit; }
header { display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px 8px; }
h2 { margin: 0; font-size: 16px; }
.hint { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
ul { margin: 0; padding: 4px 12px; overflow-y: auto; list-style: none; }
label { display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: 8px; cursor: pointer; }
label:hover { background: var(--hover); }
input { flex: none; width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--accent); }
.name { display: block; color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.pending { flex: none; margin-left: auto; color: var(--accent); font-size: 12px; white-space: nowrap; }
footer { display: flex; align-items: center; gap: 8px; padding: 12px 20px 16px; border-top: 1px solid var(--line); }
.status { margin-right: auto; color: var(--muted); font-size: 12px; }
button { padding: 6px 14px; border: 1px solid var(--line); border-radius: 6px; color: inherit; background: transparent; font: inherit; cursor: pointer; }
button:hover { background: var(--hover); }
button.primary { border-color: var(--accent); color: #fff; background: var(--accent); }
.close { margin-left: auto; padding: 0 6px; border: none; color: var(--muted); font-size: 20px; line-height: 1; }
`;

let dialog: HTMLDialogElement | null = null;
/** Brings the panel up to date with the stored switches */
let refresh: () => void = noop;

/** @param running the modules this page runs with: a switch that differs from it waits for a reload */
export function openSettingsPanel(modules: readonly Module[], running: ReadonlySet<string>, store: ModuleSettingsStore) {
  if (!dialog?.isConnected) {
    dialog = build(modules, running, store);
  }
  // Switched in another tab meanwhile
  refresh();
  if (!dialog.open) {
    dialog.showModal();
  }
}

function build(modules: readonly Module[], running: ReadonlySet<string>, store: ModuleSettingsStore) {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;

  const panel = document.createElement('dialog');
  panel.setAttribute('aria-labelledby', 'title');
  // A click on the dialog itself, not its content, is on the backdrop
  panel.addEventListener('click', (event) => {
    if (event.target === panel) {
      panel.close();
    }
  });
  // The player listens for its hotkeys on the whole page: keys pressed in the panel are not for it,
  // and it cancels Esc before the dialog could close on it
  panel.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      panel.close();
    }
  });

  const content = document.createElement('div');
  content.className = 'panel';

  const header = document.createElement('header');
  const heading = document.createElement('div');
  const title = document.createElement('h2');
  title.id = 'title';
  title.textContent = 'Make Bilibili Great Than Ever Before';
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = '开关立即保存，刷新页面后生效';
  heading.append(title, hint);
  const close = button('×', () => panel.close());
  close.className = 'close';
  close.setAttribute('aria-label', '关闭');
  header.append(heading, close);

  const list = document.createElement('ul');
  const rows = modules.map((mod) => {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      void store.setEnabled(mod, checkbox.checked).then(refresh);
    });
    const text = document.createElement('span');
    text.textContent = mod.description;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = mod.name;
    text.append(name);
    const pending = document.createElement('span');
    pending.className = 'pending';
    pending.textContent = '刷新后生效';
    label.append(checkbox, text, pending);
    item.append(label);
    list.append(item);
    return { mod, checkbox, pending };
  });

  const footer = document.createElement('footer');
  const status = document.createElement('span');
  status.className = 'status';
  const reset = button('恢复默认', () => {
    void Promise.all(modules.map(store.reset)).then(refresh);
  });
  const reload = button('刷新页面', () => unsafeWindow.location.reload());
  footer.append(status, reset, reload);

  refresh = () => {
    let changed = 0;
    for (let i = 0, len = rows.length; i < len; i++) {
      const { mod, checkbox, pending } = rows[i];
      checkbox.checked = store.isEnabled(mod);
      pending.hidden = checkbox.checked === running.has(mod.name);
      if (!pending.hidden) {
        changed++;
      }
    }
    status.textContent = changed === 0 ? '与当前页面一致' : `${changed} 项改动将在刷新页面后生效`;
    reload.classList.toggle('primary', changed > 0);
  };

  content.append(header, list, footer);
  panel.append(content);
  root.append(style, panel);
  document.documentElement.append(host);
  return panel;
}

function button(text: string, onClick: () => void) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  element.addEventListener('click', onClick);
  return element;
}
