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
