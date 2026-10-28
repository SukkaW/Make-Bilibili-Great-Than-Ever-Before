/**
 * The player's statistics panel (视频统计信息) shows as Video Host and Audio Host the host of the URL
 * the player asked for. With a policy or serve phase registered, that is not where the bytes come
 * from: no-p2p sends the request to another host, thread-ripper fetches it from many at once. Both
 * lines then show where the player's latest request of their kind got its bytes from: the host
 * that sent the most, and how many others helped (each one's share on hover).
 */

import type { MediaFile, MediaKind } from './registry';

/** media kind -> where its latest request got its bytes: hostname -> bytes, `0` when the browser fetched it */
const latest = new Map<MediaKind, ReadonlyMap<string, number>>();
let watching = false;

/**
 * The latest request of the file's kind gets its bytes from `bytes`' hosts. The map may still
 * grow: each redraw of the panel reads it again
 */
export function noteSources(file: MediaFile, bytes: ReadonlyMap<string, number>) {
  latest.set(file.kind, bytes);
  if (!watching) {
    watching = true;
    watchPanel();
  }
}

/**
 * The panel is created the first time it opens, and the player redraws its lines every second:
 * each redraw is rewritten before it is painted
 */
function watchPanel() {
  const observed = new WeakSet<Element>();
  self.setInterval(() => {
    const panel = document.querySelector('.bpx-player-info-panel');
    if (panel === null) {
      return;
    }
    if (!observed.has(panel)) {
      observed.add(panel);
      new MutationObserver(() => rewrite(panel)).observe(panel, { childList: true });
    }
    rewrite(panel);
  }, 1000);
}

function rewrite(panel: Element) {
  const lines = panel.querySelectorAll('.info-line');
  for (let i = 0, len = lines.length; i < len; i++) {
    const kind = kindOf(lines[i].querySelector('.info-title')?.textContent);
    const bytes = kind === null ? undefined : latest.get(kind);
    const data = lines[i].querySelector<HTMLElement>('.info-data');
    if (data === null || bytes === undefined || bytes.size === 0) {
      continue;
    }
    const [text, details] = describe(bytes);
    if (data.textContent !== text) {
      data.textContent = text;
    }
    // An empty title shows no tooltip
    data.title = details;
  }
}

function kindOf(title: string | null | undefined): MediaKind | null {
  switch (title?.trim()) {
    case 'Video Host:':
      return 'video';
    case 'Audio Host:':
      return 'audio';
    default:
      return null;
  }
}

/**
 * `host +2`: the host that sent the most, and how many others sent some. thread-ripper gives most
 * of a request to the hosts expected to finish first, so the first one is the fastest as well. On
 * hover, every host with its share of the bytes (a per-host speed would mislead: a small piece from
 * a warm cache arrives in one burst)
 */
function describe(bytes: ReadonlyMap<string, number>): [text: string, details: string] {
  const hosts = Array.from(bytes).sort((a, b) => b[1] - a[1]);
  const text = hosts.length > 1 ? `${hosts[0][0]} +${hosts.length - 1}` : hosts[0][0];
  let total = 0;
  for (let i = 0, len = hosts.length; i < len; i++) {
    total += hosts[i][1];
  }
  if (total === 0) {
    return [text, ''];
  }
  return [text, hosts.map(([hostname, sent]) => `${hostname}  ${Math.round(sent * 100 / total)}%`).join('\n')];
}
