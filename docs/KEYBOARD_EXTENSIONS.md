# Keyboard extensions — item 13

The connected action schema adds INSERT, F13–F16, NUMPAD0–NUMPAD9,
NUMPAD_ADD/SUBTRACT/MULTIPLY/DECIMAL and named OEM punctuation: SEMICOLON,
EQUAL, PLUS, COMMA, MINUS, PERIOD, SLASH, GRAVE, BRACKETLEFT/RIGHT,
BACKSLASH and APOSTROPHE. Existing Ctrl/Control, Alt and Shift chords remain.
PLUS adds Shift; SHIFT+PLUS keeps one Shift. A numpad key is distinct from
its top-row counterpart. NumLock and keyboard layout still affect interpretation.
These are physical key mnemonics, not a promise of literal rendered characters.
Use literal typing for exact text. No arbitrary `vk=`, scripts or Windows keys
are accepted, and the provider's system-key opt-in flag is never added.

One alias becomes one pinned-provider SendInput chord, under existing exact focus,
single-use observation, native Job ownership and declared keyboard recovery.
The existing supervisor already declares VKs 8–254 for send-keys; no recovery
declaration or native binary change is needed. Failed delivery remains unknown.

NUMPAD_DIVIDE and NUMPAD_ENTER remain unavailable: the pinned parser does not
preserve their required extended-key distinctions. Side-specific modifier chords
are also unimplemented. This is a bounded vocabulary expansion, not every keysym.

The legacy descriptor pattern stays stable; discover the additive
`support.actions.press_key.extended` and actual connected schema. Older servers
remain compatible and cannot acquire invented extensions in the method adapter.
Focused schema/normalization checks are separate from live keyboard acceptance.

Provider encoding was checked against the pinned [0.7.1 parser](https://github.com/microsoft/winappCli/blob/v0.7.1/src/winapp-CLI/WinApp.UIAutomation/Input/KeyStringParser.cs)
and Microsoft's [virtual-key definitions](https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes).
