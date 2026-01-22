/* eslint-disable no-restricted-globals -- logger */

import { noop } from 'foxts/noop';

const consoleLog = unsafeWindow.console.log;
const consoleError = unsafeWindow.console.error;
const consoleWarn = unsafeWindow.console.warn;
const consoleInfo = unsafeWindow.console.info;
const consoleDebug = unsafeWindow.console.debug;
const consoleTrace = unsafeWindow.console.trace;

const consoleGroup = unsafeWindow.console.group;
const consoleGroupCollapsed = unsafeWindow.console.groupCollapsed;
const consoleGroupEnd = unsafeWindow.console.groupEnd;

export const logger = {
  log: consoleLog.bind(console, '[make-bilibili-great-than-ever-before]'),
  error: consoleError.bind(console, '[make-bilibili-great-than-ever-before]'),
  warn: consoleWarn.bind(console, '[make-bilibili-great-than-ever-before]'),
  info: consoleInfo.bind(console, '[make-bilibili-great-than-ever-before]'),
  debug: process.env.DEBUG ? consoleDebug.bind(console, '[make-bilibili-great-than-ever-before]') : noop,
  trace(...args: any[]) {
    consoleGroupCollapsed.bind(console, '[make-bilibili-great-than-ever-before]')(...args);
    consoleTrace(...args);
    consoleGroupEnd();
  },
  group: consoleGroup.bind(console, '[make-bilibili-great-than-ever-before]'),
  groupCollapsed: consoleGroupCollapsed.bind(console, '[make-bilibili-great-than-ever-before]'),
  groupEnd: consoleGroupEnd.bind(console)
};
