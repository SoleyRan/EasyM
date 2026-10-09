# License text provenance

These files supplement dependencies whose published packages omit a separate license file. The generator records source URLs, package versions and SHA-256 hashes in `Docs/dependencies/license-sources.json`.

- alloc-stdlib, defmt-parser and webview2-rs: copied verbatim from the repository commit recorded in the generator. The webview2 macro release's earlier commit has identical license bytes.
- selectors: its source header at commit `572ecba2d1600e7c3d490586692a209faf703baa` points to Mozilla's MPL 2.0. The full text comes from `https://www.mozilla.org/media/MPL/2.0/index.txt`.
- format: the copyright line comes from `format.js` at its npm `gitHead`, `4f898096759776b7c84fa7a25b13c923dadfe46e`. The permission and warranty paragraphs are extracted from its declared license URL, `https://sjs.mit-license.org/`, retrieved on 2026-10-09. That website dynamically uses the current year; the dependency's original 2010–2013 copyright is retained. This extraction only removes HTML markup and folds whitespace.

These provenance records do not replace a distribution review. Cargo inventory is currently filtered for Windows, and MPL-covered source remains available from the locked crate/repository versions.
