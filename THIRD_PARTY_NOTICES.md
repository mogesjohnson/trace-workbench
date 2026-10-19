# Third-party notices

TRACE Workbench's own code is covered by the repository's [MIT license](LICENSE).

## Reverse Engineer Anything

The analysis engine and the `reverse-engineer-anything` workflow skill come from [`rea-agents@6.7.0`](https://www.npmjs.com/package/rea-agents), maintained upstream at [`morluto/rea`](https://github.com/morluto/rea). That package declares the MIT license. Its distributed license and copyright notices continue to apply to the upstream code and skill. Installing or distributing the dependency must retain those upstream notices.

TRACE Workbench depends on the upstream package rather than relabeling its engine as TRACE code. See [provenance](docs/PROVENANCE.md) for the exact package pin, integrity, and earlier method reference. The following notice was verified against `node_modules/rea-agents/LICENSE` from the pinned distribution:

```text
MIT License

Copyright (c) 2026 morluto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Computer Use dependencies

- [Microsoft winapp CLI](https://github.com/microsoft/winappCli), version `0.7.1`, supplies public UI automation and Windows Graphics Capture. Its [MIT notice](licenses/winapp.txt) is retained. The pinned distribution remains outside Git; its native libraries retain their upstream terms.
- MCP SDK server/client `2.3.1`: the distributed [SDK license text](licenses/mcp-sdk.txt) records the Apache-2.0 transition and retained MIT contributions.
- Zod `4.6.7`: [MIT notice](licenses/zod.txt).
- smol-toml `1.9.0`: [BSD-3-Clause notice](licenses/smol-toml.txt).

TRACE's window bridge is source-owned code using documented Win32 and DWM APIs. The existing Codex Computer Use executor and its private helper are not included in this repository.

## Other dependencies

The lockfile records transitive package versions. Those packages retain their own licenses and notices. TRACE's MIT license does not replace the terms of its dependencies.
