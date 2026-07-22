# Bundled third-party web assets

These files are committed under `public/static` and embedded into the WebSSH
binary at build time. The browser does not need a CDN connection.

| Component | Version | Local files | Upstream package |
| --- | --- | --- | --- |
| xterm.js | 5.3.0 | `vendor/xterm/xterm.min.css`, `vendor/xterm/xterm.min.js` | `xterm` |
| xterm FitAddon | 0.8.0 | `vendor/xterm/xterm-addon-fit.min.js` | `xterm-addon-fit` |
| xterm WebLinksAddon | 0.9.0 | `vendor/xterm/xterm-addon-web-links.min.js` | `xterm-addon-web-links` |
| JetBrains Mono | 5.2.5 package snapshot | `fonts/jetbrains-mono-{400,700}.woff2` | `@fontsource/jetbrains-mono` |
| Noto Sans SC | 5.2.8 package snapshot | `fonts/noto-sans-sc-{400,700}.woff2` | `@fontsource/noto-sans-sc` |

The exact upstream versions are pinned above. CDN-generated source-map comments were
removed so the browser never probes for non-bundled map files. License texts are stored
in `vendor/licenses/`. Fontsource package snapshots redistribute the original
fonts under the SIL Open Font License 1.1.

## SHA-256

```text
d9f1c41f4bc5e27c3e1d91008d54f131e744044ec69ef7f3f470e414a8bfd241  vendor/xterm/xterm-addon-fit.min.js
dcf829e4177c5a994ad533824c7440dd28ef47c6482039c7d6896a9b1f115183  vendor/xterm/xterm-addon-web-links.min.js
7d3fba9c8eac69c33ee4122ba049498126bdf3dfb4cbdd8095f9e2fa72d0b79c  vendor/xterm/xterm.min.css
73ddd59a8d7f68fd16d4ff2551c6bf45d5d5e6341481c0a0b76133384355ee54  vendor/xterm/xterm.min.js
14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb  fonts/jetbrains-mono-400.woff2
d0d4e818808f2a0ba39b2b09d1989366f63494e295f003c7ef436697378507e8  fonts/jetbrains-mono-700.woff2
eb385eca10dd39caff881c38338aefccecfaec6b42cc016fbe81434e388d6c3a  fonts/noto-sans-sc-400.woff2
70f78783862ce06f00424d43a5105475d49b3b61ad737b51bf5e561644845614  fonts/noto-sans-sc-700.woff2
```
