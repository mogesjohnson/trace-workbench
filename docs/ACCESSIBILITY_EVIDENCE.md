# Accessibility evidence — item 14

Full and accessibility observations serialize the UIA tree once. Each entry in
`elements` carries a local `treeNodeId` and `parentNodeId` (null for a root), plus
`hasMoreChildren: true` when native depth truncated it. `accessibility.hierarchy`,
present only when needed, lists the selectorless structural nodes (`nodeId`,
`parentNodeId`, name, type, optional `hasMoreChildren`); together they form the
preorder forest. Duplicate labels remain distinct. Node IDs never authorize input
and must not survive a refresh as target identity.

Offscreen nodes are omitted by default and counted in
`accessibility.offscreenOmitted`; their kept descendants attach to the nearest kept
ancestor. The window root is always kept. Pass `includeOffscreen: true` to observe
them; the setting is retained server-side for that observation's action check, like
depth. See [the token cost incident](https://github.com/mogesjohnson/trace-workbench/pull/97) (C1, C2).

The focused control and its ancestors are included whatever the depth (C5). When
keyboard focus lies below the observed depth, TRACE reads winapp's root-first chain
for the focused element (`ui inspect --ancestors`) and merges the missing nodes under
their observed parent, marked `focusPath: true`. Nodes already present (same
selector, or same AutomationId, type and bounds) are reused, so nothing is listed
twice. Focus then binds only to a unique same-control match, as before. `act`
repeats the merge on its re-inspection before the keyboard focus check, so a depth-1
observation can authorize `type_text` or `press_key`. If the chain cannot be read or
ends in another control, focus stays `unresolved` and keyboard input fails closed
with `focus_not_acquired`. Focus-path controls are re-inspected only for keyboard
input; to click one, observe at a depth that reaches it.

Hierarchy names are bounded to 512 UTF-16 units. All nodes, including selectorless
ones, count toward 10000 nodes and depth 32. Cycles or malformed children reject
the observation. Native depth truncation remains explicit; a missing child is not
evidence that it does not exist. Screenshot-only output still omits accessibility.
The readable-root and existing identity/geometry/input guards remain.

Hierarchy is structure, not document text or selected text. The separate opt-in
document reader must distinguish empty, unavailable and truncated evidence and
must not substitute labels for content. No new input authority follows from it.
Focused synthetic hierarchy checks do not establish broader live app coverage.

For a document read, first obtain the control's `elementId`, then call
`trace_computer_observe` with `mode: "accessibility"` and
`documentElementId: "<observed ID>"`. The fresh tree must contain that exact ID
once. The native reader requires a unique AutomationId/type/class/bounds binding;
missing metadata returns `binding_unavailable`. Ambiguous or stale targets reject.

The `documentRead` result contains `document` and `selection`, each with an
explicit `available` flag. Available document text has `text` and `truncated`;
available selection has up to four `{text, truncated}` ranges plus a range-count
`truncated` flag. Empty strings/ranges are valid evidence, never an unavailable
marker. See [native limits](DOCUMENT_READER.md). Content is returned only on this
opt-in request and is not journaled. Ordinary observation/action refreshes do not
read document content. The read revokes any prior full observation's authority,
including on provider failure, and its new observation ID cannot authorize input.

The [owned-fixture receipt](../evidence/keyboard-accessibility/acceptance.json)
records scoped live hierarchy, bounded document/selection, empty, password and
unsupported-control checks. It includes independent state/cleanup and explicit
coverage limits; it does not establish support across arbitrary applications.
