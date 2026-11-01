# Accessibility evidence — item 14

Full and accessibility observations add `accessibility.hierarchy`, a bounded
preorder forest. Each node has a local `nodeId`, `parentNodeId` (null for a root),
optional observed `elementId`, type/name, `nestingDepth` and `hasMoreChildren`.
Selectorless parents remain in the hierarchy; duplicate labels remain distinct.
Flat actionable element IDs/order stay unchanged, with `treeNodeId` linking each
element to this observation's hierarchy. Node IDs never authorize input and must
not survive a refresh as target identity.

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
