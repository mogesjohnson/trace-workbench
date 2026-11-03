'use strict';

// Effective TRACE limits for the pinned provider, not every operation its CLI accepts.
const LIMITS = Object.freeze({ text: 8192, elementId: 512, key: 100, wheel: 2400, wheelStep: 120 });
const KEY_NAMES = ['ENTER', 'RETURN', 'TAB', 'ESC', 'ESCAPE', 'BACKSPACE', 'DELETE', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN', 'LEFT', 'RIGHT', 'UP', 'DOWN', 'SPACE'];
const MODIFIERS = ['CTRL', 'CONTROL', 'ALT', 'SHIFT'];
const alternatives = words => words.map(word => word.replace(/[A-Z]/g, letter => `[${letter}${letter.toLowerCase()}]`)).join('|');
// JSON Schema has no regexp flags; encode case folding in the pattern itself.
const keyPattern = (names, fRange) => `^(?:(?:${alternatives(MODIFIERS)})\\+)*(?:[A-Za-z0-9]|[Ff](?:[1-9]|${fRange})|${alternatives(names)})(?![\\s\\S])`;
const LEGACY_KEY_PATTERN = keyPattern(KEY_NAMES, '1[0-2]');
const KEY_ALIASES = Object.freeze({ INSERT: 'insert', SEMICOLON: 'vk=0xba', EQUAL: 'vk=0xbb', PLUS: 'vk=0xbb',
  COMMA: 'vk=0xbc', MINUS: 'vk=0xbd', PERIOD: 'vk=0xbe', SLASH: 'vk=0xbf', GRAVE: 'vk=0xc0',
  BRACKETLEFT: 'vk=0xdb', BACKSLASH: 'vk=0xdc', BRACKETRIGHT: 'vk=0xdd', APOSTROPHE: 'vk=0xde',
  NUMPAD_ADD: 'vk=0x6b', NUMPAD_SUBTRACT: 'vk=0x6d', NUMPAD_MULTIPLY: 'vk=0x6a', NUMPAD_DECIMAL: 'vk=0x6e',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`NUMPAD${n}`, `vk=0x${(0x60 + n).toString(16)}`])) });
const KEY_PATTERN = keyPattern([...KEY_NAMES, ...Object.keys(KEY_ALIASES)], '1[0-6]');
const FIELDS = {
  activate: [], click: ['x', 'y', 'elementId', 'button', 'count'], type_text: ['text'], press_key: ['key'],
  scroll: ['x', 'y', 'deltaX', 'deltaY', 'placement'], drag: ['fromX', 'fromY', 'toX', 'toY'],
  invoke: ['elementId'], set_value: ['elementId', 'value'],
};
const reject = (code, message) => { throw Object.assign(new Error(message), { code, details: { outcome: 'not_dispatched' } }); };
function normalizeKey(key) {
  const tokens = key.toLowerCase().split('+').map(token => token === 'control' ? 'ctrl' : token === 'return' ? 'enter' : token);
  const name = tokens.pop(), mapped = KEY_ALIASES[name.toUpperCase()];
  if (name === 'plus' && !tokens.includes('shift')) tokens.push('shift');
  return [...tokens, mapped ?? name].join('+');
}

// Static support checks run before observation consumption or native helper work.
function parseAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) reject('invalid_action', 'Provide an action object.');
  const fields = Object.hasOwn(FIELDS, action.type) ? FIELDS[action.type] : null;
  if (!fields || Object.keys(action).some(key => key !== 'type' && !fields.includes(key))) reject('invalid_action', 'Unknown action type or field.');
  const text = (key, maximum, empty = false) => {
    if (typeof action[key] !== 'string' || (!empty && !action[key].length) || action[key].length > maximum || action[key].includes('\0')) reject('invalid_action', `${key} must be a bounded string without NUL.`);
  };
  const point = (x, y) => {
    if (![action[x], action[y]].every(value => Number.isInteger(value) && value >= 0)) reject('invalid_coordinates', 'Use nonnegative integer coordinates.');
  };
  switch (action.type) {
    case 'click':
      if (action.button !== undefined && !['left', 'right', 'middle'].includes(action.button)) reject('unsupported_action', 'Choose left, right or middle.');
      if (action.count !== undefined && ![1, 2].includes(action.count)) reject('unsupported_action', 'Click count must be 1 or 2.');
      if (action.count === 2 && (action.button ?? 'left') !== 'left') reject('unsupported_action', 'Double-click supports the left button only.');
      if (action.elementId !== undefined) {
        if (action.x !== undefined || action.y !== undefined) reject('invalid_action', 'Choose elementId or coordinates, not both.');
        text('elementId', LIMITS.elementId);
      } else point('x', 'y');
      break;
    case 'type_text': text('text', LIMITS.text); break;
    case 'press_key':
      text('key', LIMITS.key);
      if (!new RegExp(KEY_PATTERN, 'i').test(action.key)) reject('invalid_key', 'Use a supported key or Ctrl/Alt/Shift chord.');
      break;
    case 'scroll':
      point('x', 'y');
      if (![action.deltaX, action.deltaY].every(value => Number.isInteger(value) && Math.abs(value) <= LIMITS.wheel)) reject('invalid_action', 'Scroll deltas exceed the supported integer limits.');
      if (action.placement !== undefined) {
        if (action.placement !== 'point' || (!action.deltaX && !action.deltaY)
          || action.deltaX % LIMITS.wheelStep || action.deltaY % LIMITS.wheelStep) reject('unsupported_action', 'Point wheel requires a nonzero pair of bounded 120-unit deltas.');
        break;
      }
      if (action.deltaX !== 0 || !action.deltaY || action.deltaY % LIMITS.wheelStep) reject('unsupported_action', 'Use vertical 120-unit wheel notches, positive down; horizontal scroll is unavailable.');
      break;
    case 'drag': point('fromX', 'fromY'); point('toX', 'toY'); break;
    case 'invoke': text('elementId', LIMITS.elementId); break;
    case 'set_value': text('elementId', LIMITS.elementId); text('value', LIMITS.text, true); break;
  }
  return { ...action };
}

function validateAction(action, observation) {
  const checked = parseAction(action);
  const points = action.type === 'drag' ? [['fromX', 'fromY'], ['toX', 'toY']]
    : action.type === 'scroll' || (action.type === 'click' && action.elementId === undefined) ? [['x', 'y']] : [];
  for (const [x, y] of points) {
    if (action[x] >= observation.bounds.width || action[y] >= observation.bounds.height) reject('invalid_coordinates', 'Use integer coordinates inside the observed window.');
  }
  if (action.elementId !== undefined && !(observation.elements ?? []).some(item => item.id === action.elementId && item.enabled !== false)) reject('unknown_element', 'Choose an enabled element from the latest observation.');
  return checked;
}

function actionSupport(observationTtlMs = 60000) {
  return {
    contractVersion: 1, scope: 'trace-wrapper-contract', engine: { name: 'winapp', version: require('./winapp-pin.json').version },
    platform: 'win32', architecture: 'x64', limits: { ...LIMITS }, stringUnits: 'utf-16-code-units',
    coordinateSpace: 'window-local-physical-pixels', origin: 'validated-intersection-crop',
    actions: {
      activate: { target: 'session-window' },
      click: { targets: ['point', 'elementId'], button: 'left', count: 1, pointTransport: 'same-point-button-down-up',
        variants: { buttons: ['left', 'right', 'middle'], counts: [1, 2], doubleButton: 'left', transport: 'supervised-public-win32', requiresSupervisor: true } },
      type_text: { minLength: 1, maxLength: LIMITS.text, nul: false },
      press_key: { pattern: LEGACY_KEY_PATTERN, maxLength: LIMITS.key, caseSensitive: false,
        modifiers: [...MODIFIERS], namedKeys: [...KEY_NAMES], normalization: { CONTROL: 'ctrl', RETURN: 'enter' },
        extended: { pattern: KEY_PATTERN, aliases: { ...KEY_ALIASES }, functionKeys: 16, plusAddsShift: true,
          semantics: 'physical-virtual-key-layout-dependent', unavailable: ['NUMPAD_DIVIDE', 'NUMPAD_ENTER', 'side-specific modifiers'] } },
      scroll: { deltaX: 0, minDeltaY: -LIMITS.wheel, maxDeltaY: LIMITS.wheel, step: LIMITS.wheelStep,
        nonzero: true, positive: 'down', target: 'smallest-enabled-onscreen-element-containing-point', placement: 'element-center',
        point: { maxAbsDelta: LIMITS.wheel, step: LIMITS.wheelStep, nonzeroPair: true, positiveX: 'right', positiveY: 'down',
          order: ['y', 'x'], placement: 'requested-point', requiresSupervisor: true, transport: 'supervised-public-win32' } },
      drag: { targets: ['fromPoint', 'toPoint'], button: 'left' },
      invoke: { target: 'enabled-elementId' },
      set_value: { target: 'enabled-elementId', minLength: 0, maxLength: LIMITS.text, nul: false },
    },
    observation: { defaultDepth: 8, minDepth: 1, maxDepth: 32, ttlMs: observationTtlMs,
      maxImageBytes: 6 * 1024 * 1024, requiresReadableUiaRoot: true },
  };
}

function compatibleSupport(support) {
  const ttl = support?.observation?.ttlMs;
  if (!Number.isFinite(ttl) || ttl < 0) return false;
  const matches = (actual, expected) => {
    if (expected === null || typeof expected !== 'object') return actual === expected;
    if (!actual || typeof actual !== 'object' || Array.isArray(actual) !== Array.isArray(expected)) return false;
    if (Array.isArray(expected) && actual.length !== expected.length) return false;
    return Object.keys(expected).every(key => Object.hasOwn(actual, key) && matches(actual[key], expected[key]));
  };
  const expected = actionSupport(ttl);
  if (!Object.hasOwn(support?.actions?.click ?? {}, 'variants')) delete expected.actions.click.variants;
  if (!Object.hasOwn(support?.actions?.scroll ?? {}, 'point')) delete expected.actions.scroll.point;
  if (!Object.hasOwn(support?.actions?.press_key ?? {}, 'extended')) delete expected.actions.press_key.extended;
  return matches(support, expected);
}

module.exports = { LIMITS, KEY_PATTERN, normalizeKey, parseAction, validateAction, actionSupport, compatibleSupport };
