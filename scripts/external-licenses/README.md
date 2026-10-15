# License text provenance

- remark-math 6.0.0: copied verbatim from the root license at npm gitHead `d5d0660b150810a535bbb07eac6cc96a4510aa24` on 2026-10-15; the published package omits it. Source URL and byte hash are recorded by the generator.

These files supplement dependencies whose published packages omit a separate license file. The generator records source URLs, package versions and SHA-256 hashes in `Docs/dependencies/license-sources.json`.

Supplemental text is emitted with canonical LF newlines so Windows Git checkout settings do not change provenance hashes. Generated content-addressed license files are marked binary in `.gitattributes` to preserve their exact bytes in Git; this only affects line endings, not the license terms.

- alloc-stdlib, defmt-parser and webview2-rs: copied verbatim from the repository commit recorded in the generator. The webview2 macro release's earlier commit has identical license bytes.
- selectors: its source header at commit `572ecba2d1600e7c3d490586692a209faf703baa` points to Mozilla's MPL 2.0. The full text comes from `https://www.mozilla.org/media/MPL/2.0/index.txt`.
- format: the copyright line comes from `format.js` at its npm `gitHead`, `4f898096759776b7c84fa7a25b13c923dadfe46e`. The permission and warranty paragraphs are extracted from its declared license URL, `https://sjs.mit-license.org/`, retrieved on 2026-10-09. That website dynamically uses the current year; the dependency's original 2010–2013 copyright is retained. This extraction only removes HTML markup and folds whitespace.
- dlopen2 and dlopen2_derive: copied verbatim from OpenByteDev/dlopen2 at the published crates' commit `cc80e4a0a90d499b677fdf7743699b4b3a43a989`.
- libappindicator-sys: the MIT option is copied verbatim from tauri-apps/libappindicator-rs at its published crate commit `eafd1e3682a1247f595410266091e9684021cb6f`. The installed sys crate omits the repository-root license files.
- hash.js 1.1.7 and isarray 1.0.0: their full MIT license sections are extracted verbatim from upstream README files at their npm gitHead commits `fcd35edcc4e30145be4b7a737477ad54e83afc25` and `2a23a281f369e9ae06394c0fb4d2381355a6ba33`. Markdown/HTML entity spelling in the original notice is preserved. Retrieved on 2026-10-12; source URLs are recorded by the generator.
- pako 1.0.11: its root LICENSE only contains MIT terms; the additional Zlib terms and copyrights are copied verbatim from `lib/zlib/README` at npm gitHead `a718e4f6e5ce87b0964d8f84541d92a23263365b`. Retrieved on 2026-10-12 and compared with the installed package's nested README. Both texts are bundled for its declared `MIT AND Zlib` license.

These provenance records do not replace a distribution review. Generate separate filtered Cargo inventories for each target. MPL-covered source remains available from the locked crate/repository versions. The macOS objc2 family still needs full license-text review: its upstream LICENSE.md explains the license choices and Apple SDK origin but does not contain the complete permission/warranty terms. Do not count that declaration alone as a complete license text.
