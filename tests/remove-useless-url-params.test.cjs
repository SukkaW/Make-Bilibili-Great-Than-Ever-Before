const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { after, before, test } = require('node:test');
const { rollup } = require('rollup');
const commonjs = require('@rollup/plugin-commonjs');
const { nodeResolve } = require('@rollup/plugin-node-resolve');
const { swc } = require('rollup-plugin-swc3');

const original = {
  unsafeWindow: Reflect.get(globalThis, 'unsafeWindow'),
  location: Reflect.get(globalThis, 'location')
};
let removeUselessUrlParams;

before(async () => {
  globalThis.unsafeWindow = { console: Reflect.get(globalThis, 'console') };
  const bundle = await rollup({
    input: 'src/modules/remove-useless-url-params.ts',
    plugins: [commonjs(), nodeResolve(), swc({ jsc: { target: 'es2022' } })]
  });
  try {
    const { output } = await bundle.generate({ format: 'es' });
    ({ default: removeUselessUrlParams } = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`));
  } finally {
    await bundle.close();
  }
});

after(() => {
  Object.assign(globalThis, original);
});

function page(href) {
  const calls = [];
  const location = { href };
  const history = {
    pushState(_state, _unused, url) { calls.push(['push', url]); },
    replaceState(_state, _unused, url) { calls.push(['replace', url]); }
  };
  Reflect.set(globalThis, 'location', location);
  Reflect.set(globalThis.unsafeWindow, 'location', location);
  globalThis.unsafeWindow.history = history;
  removeUselessUrlParams.any();
  return { history, calls };
}

function params(url) {
  return new URL(url).searchParams;
}

test('keeps mid on both copyright pages during page load and history changes', () => {
  const { history, calls } = page('https://www.bilibili.com/pc/community/copyright/role?mid=123&spm_id_from=feed');
  assert.equal(params(calls[0][1]).get('mid'), '123');
  assert.equal(params(calls[0][1]).has('spm_id_from'), false);

  history.pushState(null, '', '/v/copyright/intro?mid=456&vd_source=share&step=2');
  assert.equal(params(calls[1][1]).get('mid'), '456');
  assert.equal(params(calls[1][1]).has('vd_source'), false);
  assert.equal(params(calls[1][1]).get('step'), '2');

  history.replaceState(null, '', '/pc/community/copyright/role?mid=789&share_source=copy');
  assert.equal(params(calls[2][1]).get('mid'), '789');
  assert.equal(params(calls[2][1]).has('share_source'), false);
});

test('removes mid outside the two exact copyright paths', () => {
  const { history, calls } = page('https://www.bilibili.com/video/BV1?mid=123&spm_id_from=feed');
  assert.equal(params(calls[0][1]).has('mid'), false);
  assert.equal(params(calls[0][1]).has('spm_id_from'), false);

  history.pushState(null, '', '/pc/community/copyright/role/next?mid=456');
  assert.equal(params(calls[1][1]).has('mid'), false);

  history.replaceState(null, '', 'https://example.com/v/copyright/intro?mid=789');
  assert.equal(params(calls[2][1]).has('mid'), false);
});
