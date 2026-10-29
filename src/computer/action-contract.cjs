'use strict';

// Effective TRACE limits for the pinned provider, not every operation its CLI accepts.
const LIMITS = Object.freeze({ text: 8192, elementId: 512, key: 100, wheel: 2400, wheelStep: 120 });
const KEY_PATTERN = '^(?:(?:CTRL|CONTROL|ALT|SHIFT)\\+)*(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|ENTER|RETURN|TAB|ESC|ESCAPE|BACKSPACE|DELETE|HOME|END|PAGEUP|PAGEDOWN|LEFT|RIGHT|UP|DOWN|SPACE)$';
const FIELDS = {
  activate: [], click: ['x', 'y', 'elementId'], type_text: ['text'], press_key: ['key'],
  scroll: ['x', 'y', 'deltaX', 'deltaY'], drag: ['fromX', 'fromY', 'toX', 'toY'],
  invoke: ['elementId'], set_value: ['elementId', 'value'],
};
const reject = (code, message) => { throw Object.assign(new Error(message), { code, details: { outcome: 'not_dispatched' } }); };
const normalizeKey = key => key.toLowerCase().split('+').map(token => token === 'control' ? 'ctrl' : token === 'return' ? 'enter' : token).join('+');

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

module.exports = { LIMITS, KEY_PATTERN, normalizeKey, parseAction, validateAction };
