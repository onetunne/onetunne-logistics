# Barcode scanning and PDF merging: options for an embedded Shopify admin app (iPhone Safari / Android Chrome)

Retrieved 2026-11-27. Sources: shopify.dev `.md` pages, MDN content sources (raw GitHub `mdn/content`), MDN
browser-compat-data (BCD) npm package `@mdn/browser-compat-data@8.1.11` (data timestamp 2026-11-26), and npm registry
metadata/tarballs. Each fact cites its source. **NOT DOCUMENTED** means the consulted official docs do not say it.
Lines marked *Inference* are conclusions drawn from the cited facts. They are not stated in the docs.

Network limits in this session: community.shopify.dev, docs.npmjs.com, bcd.developer.mozilla.org and the GitHub API
were blocked or not enabled, so repo activity (commits, issues) was not checked. Maintenance status below comes
only from npm publish dates and the READMEs.

---

## 1. Shopify App Bridge (App Home) facts

### 1.1 Scanner API exists in current App Bridge
Source: https://shopify.dev/docs/api/app-home/latest/apis/device-and-platform-integration/scanner-api.md
(https://shopify.dev/docs/api/app-bridge-library.md redirects to https://shopify.dev/docs/api/app-home/latest.md. The
API list is at https://shopify.dev/docs/api/app-home/v2.0/apis.md, section "Device and platform integration".)

- The page says: "The Scanner API allows you to use the mobile device's camera to scan barcodes. Use this API to capture
  barcode data and integrate it into your app's workflow **on Shopify POS**."
- It is called through the `shopify` global as `shopify.scanner.capture(): Promise<ScannerPayload>`. The doc says it
  "Opens the device camera to scan a barcode", and `ScannerPayload` is `{ data: string }`.
- It scans one barcode per call: the only method is `capture`, and it returns a single payload.
- The listed use cases include "Inventory management: Scan items during inventory counts" and "Order processing: Scan
  package barcodes during fulfillment or receiving workflows".
- The page's example looks up a variant with `productVariants(first: 1, query: $barcode)`, passing the variable
  `barcode` set to the template string `barcode:${barcode}` (the search string `barcode:<value>`), through
  `fetch('shopify:admin/api/graphql.json')`. That fetch needs direct API access to be enabled
  (`[access.admin] embedded_app_direct_api_access = true`, source: https://shopify.dev/docs/api/app-home/latest.md,
  section "Direct API access").
- The page notes: "App Bridge isn't versioned with Polaris. App Bridge APIs … are identical in every App Home reference
  version."
- **NOT DOCUMENTED:**
  - which platforms support `scanner.capture()` in the current docs (no support matrix);
  - whether it works in the Shopify admin opened in **mobile Safari or Chrome** (admin.shopify.com in a browser) or on desktop;
  - what happens on an unsupported platform (whether the promise rejects, never settles, or something else).
    The page only says, in general, that `capture` "returns a Promise resolving to the scanned barcode data or an
    error", and its example wraps the call in `try/catch` with the message "Scan cancelled or failed";
  - which barcode symbologies are supported. The only hint is the API index
    (https://shopify.dev/docs/api/app-home/v2.0/apis.md, "Device and platform integration"), which describes the
    Scanner API as "Access device cameras and barcode scanners to capture product codes and QR codes". No format list
    is given;
  - whether continuous scanning is possible.

### 1.2 Legacy Scanner action: platform requirements (older API)
Source: https://shopify.dev/docs/api/app-bridge/previous-versions/actions/scanner.md, section "Requirements"
- The page is marked "This is a legacy API".
- It lists these app versions as required: **Shopify iOS v8.25.0+, Shopify Android v8.24.0+, Point of Sale iOS v5.32.0+,
  POS Android v3.25.0+**. These are native Shopify apps. Web browsers are not listed.
- Before opening the scanner, the app had to use feature detection ("To open a Scanner component, you must first use
  Feature Detection to check whether it's available"). If the action was not yet available, the app dispatched
  `Features.Action.REQUEST` with `{ feature: Group.Scanner, action: Scanner.Action.OPEN_CAMERA }`. The action table
  names it `OPEN::CAMERA`, type `APP::SCANNER::OPEN::CAMERA`. The legacy capture payload field is `scanData`
  (`String?`), not `data`. Source for the request step:
  https://shopify.dev/docs/api/app-bridge/previous-versions/actions/features.md, action `APP::FEATURES::REQUEST`,
  which "May result in an authorization dialog to appear, depending on the platform it is dispatched on".
- *Inference:* historically the scanner was a native Shopify Mobile / POS feature, not a browser feature. The current
  docs neither confirm nor deny that this still holds.

### 1.3 Environment API: detect where the app is running
Source: https://shopify.dev/docs/api/app-home/latest/apis/authentication-and-data/environment-api.md
- `shopify.environment` exposes synchronous booleans: `embedded`, `intent`, `mobile` ("running inside the Shopify Mobile
  app") and `pos` ("running inside the Shopify POS app").
- Its use cases include "Enable or disable features based on device capabilities like camera access or printing".
- App Bridge sets the CSS variable `--shopify-safe-area-inset-bottom` to the height of host UI that overlays the
  bottom of the app, such as the Sidekick bar or mobile navigation controls. The page says it "applies wherever your
  app runs, including desktop and mobile web" and defaults to `0px`. App Bridge also adds a `body::after` spacer, but
  that spacer does not move `position: fixed` elements, so add the variable to fixed bars and buttons yourself.
- **NOT DOCUMENTED:** any flag for "mobile web browser" as opposed to desktop browser. `mobile` refers only to the
  Shopify Mobile native app.

### 1.4 Print API (bulk document printing)
Source: https://shopify.dev/docs/api/app-home/latest/apis/device-and-platform-integration/print-api.md
- Apps use the standard `window.print()`.
- On desktop, `print()` "uses the browser's built-in print dialog without any App Bridge involvement".
- "On Shopify Mobile and Shopify POS devices, `print()` doesn't work natively inside the app's iframe, so App Bridge
  intercepts this method" and forwards it to the native app.
- **NOT DOCUMENTED:**
  - whether the App Bridge print interception can print a PDF Blob or URL, as opposed to the current page;
  - how `print()` behaves in mobile Safari or Chrome inside the admin iframe.

### 1.5 Navigation API: opening a top-level page
Source: https://shopify.dev/docs/api/app-home/latest/apis/user-interface-and-interactions/navigation-api.md
- `open('https://example.com', '_blank')` or `<a target="_blank">` "opens an external URL in a new browser tab or
  window … The Shopify admin remains open in the original tab".
- `open(url, '_top')` leaves the admin.
- *Inference:* a page opened this way on the app's own origin is a top-level document. MDN says the camera default
  allowlist is `self` (see §2.2), so `getUserMedia` there would not depend on Shopify's iframe `allow` attribute. That
  page is outside App Bridge, though, so session-token auth would not apply and it would need its own authentication.
  **NOT DOCUMENTED** by Shopify as a supported pattern.

### 1.6 Camera permission for the embedded iframe (`allow="camera"`)
- Searches of shopify.dev for "camera", "allow" and "iframe" found **no official statement** that Shopify admin
  delegates camera access to embedded app iframes (an `allow="camera"` attribute) or how to request it. Result:
  **NOT DOCUMENTED**.
- Not official and not verified: community.shopify.dev could not be opened from this session. Web-search snippets from
  forum threads report that:
  - Shopify does not add `allow="microphone"` to the app iframe (thread "Microphone access in embedded apps");
  - in Shopify Mobile on iOS, camera requests fail without a system permission prompt (thread "Camera scanning in
    embedded apps on Shopify Mobile (iOS)…");
  - there is a feature request for a continuous scanner (thread "Expose continuous barcode scanning to embedded apps
    in Shopify Mobile");
  - there is a report titled "Shopify App Bridge scanner API no longer working on IOS".

  These are signals for manual testing. They are not facts.
- An app cannot grant itself camera access from inside the iframe. MDN says "A Permissions Policy specified by the
  `allow` attribute implements a further restriction on top of the policy specified in the Permissions-Policy header"
  (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe, attribute `allow`). The `allow`
  attribute sits on the parent's (Shopify's) `<iframe>` element. See §2.2.

### 1.7 Framing headers (context)
Source: https://shopify.dev/docs/apps/build/security/app-server/set-up-iframe-protection.md
- An embedded app must send `Content-Security-Policy: frame-ancestors https://<shop>.myshopify.com https://admin.shopify.com`
  on every HTML route.
- The React Router template sets this through `shopify.addDocumentResponseHeaders` in `entry.server.tsx`.
- The repo already does this in `app/entry.server.tsx`, in `applySecurityHeaders`. That code sets no
  `Permissions-Policy` header.

---

## 2. Web platform facts (MDN and BCD 8.1.11)

### 2.1 BarcodeDetector (Barcode Detection API)
Sources: https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector and
https://developer.mozilla.org/en-US/docs/Web/API/Barcode_Detection_API. Compat data is from
`@mdn/browser-compat-data@8.1.11` `data.json`, key `api.BarcodeDetector`.
- Status: **experimental** and standard-track. It needs a **secure context** and is available in workers.
- `detect()` accepts `HTMLImageElement`, `SVGImageElement`, `HTMLVideoElement`, `HTMLCanvasElement`, `ImageBitmap`,
  `OffscreenCanvas`, `VideoFrame`, an image `Blob` or `ImageData`
  (https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector/detect). Each result has `rawValue`, `format`,
  `boundingBox` and `cornerPoints`.

Support by browser:

| Browser (BCD key) | Support |
|---|---|
| **Safari on iOS (`safari_ios`)** | `version_added: "17"` **only behind the flag** "Shape Detection API" (preference). BCD has no unflagged entry; the current iOS release in BCD is 27.2. **Not available by default on iPhone.** |
| WebView on iOS (`webview_ios`) | `false` |
| **Chrome Android (`chrome_android`)** | 83+ (no flag, no notes) |
| WebView Android | 83+ |
| Samsung Internet | 13.0+ |
| Firefox / Firefox Android | `false` (bug 1553738) |
| Chrome desktop | 88+, partial: "Supported on ChromeOS and macOS only" |

- **NOT DOCUMENTED (MDN/BCD):** whether Chrome Android needs Google Play Services. BCD has no note on it.
- *Inference:* BarcodeDetector cannot be the only decoder on iPhone, so a JavaScript or WebAssembly fallback is required.

### 2.2 getUserMedia and Permissions Policy inside a cross-origin iframe
Sources: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia (section "Security"),
https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/camera and
https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Permissions_Policy
- `getUserMedia` works only in secure contexts (HTTPS, `file:` or localhost). In an insecure context,
  `navigator.mediaDevices` is `undefined`.
- MDN: "Only a window's top-level document context for a valid origin can even request permission to use getUserMedia(),
  unless the top-level context expressly grants permission for a given `<iframe>` to do so using Permissions Policy."
- MDN example: `<iframe src="…" allow="camera; microphone">`.
- When the policy blocks the camera, `getUserMedia()` rejects with **`NotAllowedError`**. Source: the camera directive page.
- The default allowlist for `camera` is **`self`**. The guide says `self` means "not allowed in cross-origin documents
  in nested browsing contexts" unless the iframe's `allow` attribute grants it.
- A sandboxed iframe can call `getUserMedia` only with `allow-same-origin`. Source: getUserMedia page, "Security".
- BCD 8.1.11 support:

  | Feature | Safari iOS | Chrome Android |
  |---|---|---|
  | `html.elements.iframe.allow` | 11.3 | 60 |
  | `http.headers.Permissions-Policy` | `false` | 85 |
  | `Permissions-Policy.camera` | `false` | 88 |
  | `MediaDevices.getUserMedia` | 11 (WebView iOS 11) | 53 |

- *Inference:* on both browsers, camera use in the app iframe depends on Shopify's side: whether admin.shopify.com's
  `<iframe>` element carries `allow="camera"` covering the app origin and, on Chrome, whether admin's own
  `Permissions-Policy` header allows it (MDN: the `allow` attribute is "a further restriction on top of" the header).
  The user's permission prompt comes on top of that. Shopify does not document any of it (§1.6). Safari iOS supports
  the `allow` attribute (11.3) but BCD lists no support for the `Permissions-Policy` header.

### 2.3 File-input capture fallback
Source: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture. BCD key
`html.elements.input.capture`.
- `<input type="file" accept="image/*" capture="environment">` asks to capture a new photo with the outward-facing camera.
- BCD support: Safari iOS 10+, Chrome Android 25+, WebView iOS 10+.
- **NOT DOCUMENTED (MDN pages consulted):** whether `capture` is subject to the iframe camera Permissions Policy.
  **NOT DOCUMENTED (Shopify):** whether it works inside the admin iframe or Shopify Mobile.
- *Inference:* the photo can be decoded with BarcodeDetector or a WebAssembly/JS decoder (see §3), which needs no live
  camera stream. This is a candidate fallback that needs testing on real devices.

---

## 3. Free/OSS barcode-scanning libraries (npm registry)

Sources: `https://registry.npmjs.org/<pkg>` (fields `dist-tags.latest`, `time`, `license`, `dependencies`, `engines`,
`readme`). Sizes were measured locally from the published tarballs. The raw size is the file in the package; the gzip
figure is `gzip -9`. UMD bundles may include dependencies; tree-shaken ESM size was not measured.

| Package | Latest (published) | License | Size of main browser artifact | Maintenance / notes (source: README on registry) |
|---|---|---|---|---|
| `@zxing/library` | 0.23.0 (2026-04-29) | Apache-2.0 | `umd/index.min.js` 362 KB raw / 108 KB gz | README: "**Project in Maintenance Mode Only** … Only bug fixes and minor enhancements … no active development or roadmap". iOS limitation: camera worked only in Safari before iOS 14.3, and iOS 14.3+ supports WebRTC in third-party browsers. `engines.node: ">= 24.0.0"` since 0.22.0 (2026-04-27). The previous release, 0.21.3 (2024-08-21), had `>= 10.4.0`. The repo uses Node `>=22.12` and the local Node is v22.23.5. npm docs (https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/package-json.md, section "engines"): "Unless the user has set the `engine-strict` config flag, this field is advisory only and will only produce warnings". The repo `.npmrc` does not set `engine-strict`, so install would warn, not fail. Whether 0.23.0 actually runs on Node 22 is NOT DOCUMENTED. No remote URLs in `umd/index.min.js` (checked by grep; not a documented guarantee). |
| `@zxing/browser` | 0.2.1 (2026-07-06) | MIT | `umd/zxing-browser.min.js` 441 KB raw / 111 KB gz | Browser layer over `@zxing/library` (peer `^0.23.0`; 0.1.5 from 2024-05-22 peers `^0.21.0`): webcam, `<video>` and `<img>` scanning. README: it "does not offers support to any physical barcode readers". Its README gives no maintenance statement. It inherits the library's maintenance-mode status (*Inference*). |
| `html5-qrcode` | 2.3.8 (**2023-04-15**, no release in about 3.5 years) | Apache-2.0 | `html5-qrcode.min.js` 375 KB raw / 108 KB gz (bundles zxing-js in `third_party/`) | README: decoding "is dependent on Zxing-js". The iOS table marks Safari supported, Chrome/Firefox on iOS supported "for IOS versions >= 15.1", and Edge on iOS as partial. It ships a UI or a low-level API. There is an experimental option `useBarCodeDetectorIfSupported` (in `experimental-features.d.ts`). |
| `barcode-detector` | 3.2.5 (2026-11-24) | MIT | dependency `zxing-wasm` 3.1.8 (pinned) | A ponyfill/polyfill for the BarcodeDetector API using ZXing-C++ WebAssembly. `barcode-detector/polyfill` registers only "if it's not already present" in `globalThis`. **By default the `.wasm` file is fetched from the jsDelivr CDN.** To self-host, use `prepareZXingModule` with a `locateFile` override (needed for CSP or offline use, per the README). |
| `zxing-wasm` | 3.1.8 (2026-11-24) | MIT | `dist/reader/zxing_reader.wasm` 946 KB raw / 411 KB gz; `dist/full/zxing_full.wasm` 1.43 MB / 703 KB gz (measured; the README states "~1.04 MiB" and "~1.46 MiB", which does not match the 3.1.8 files) | ZXing-C++ compiled to WASM. Runs on Web, Node.js, Bun and Deno; can read and write barcodes. The default serve path for the `.wasm` file is the jsDelivr CDN; override with `prepareZXingModule({ overrides: { locateFile } })`. |
| `@ericblade/quagga2` | 1.14.0 (2026-11-22) | MIT | not measured | Built-in readers are linear (1D) formats only: EAN, EAN-8, CODE 128 (default), CODE 39, CODE 39 VIN, CODE 93, CODE 32, CODABAR, UPC-A, UPC-E, I2of5, 2of5, PHARMACODE. The README does not literally say "1D only", and it points to an external reader, `quagga2-reader-qr`, that can "decode QR codes" from complete images. The README's "Safari iOS: `true`" row is the result of a `navigator.mediaDevices.getUserMedia` feature check, not a tested-support claim for the library. `dist` is "only targeted to the browser". `engines.node >= 20.0`. Optional dependencies: `sharp`, `fsevents`, `ndarray-pixels`. |

- Release age: the latest `barcode-detector` (3.2.5) and `zxing-wasm` (3.1.8) were published on 2026-11-24, 3 days
  before this research, and `quagga2` 1.14.0 on 2026-11-22, 5 days before. The previous patches were 3.2.4 / 3.1.7
  (2026-11-15). For supply-chain caution, consider pinning an exact older patch version.
- *Inference:* the CLAUDE.md rule "UI kit without CDN / autonomous demo" means the WASM path would need the `.wasm` file
  self-hosted, served from the app's own assets through `locateFile`.
- **NOT DOCUMENTED:**
  - comparative decode accuracy or speed on iPhone for any of these libraries;
  - whether any of them works inside the Shopify admin iframe. That depends on §1.6/§2.2, not on the library.

---

## 4. PDF merging (bulk printing of carrier labels and invoices)

Sources: https://registry.npmjs.org/pdf-lib and https://registry.npmjs.org/@cantoo/pdf-lib (README and metadata).
Sizes were measured from the tarballs.

| Package | Latest (published) | License | Browser bundle | Node | Notes |
|---|---|---|---|---|---|
| `pdf-lib` (Hopding) | 1.17.1 (**2021-11-06**, last version about 5 years ago) | MIT | `dist/pdf-lib.min.js` 525 KB raw / 207 KB gz | Yes. README: "Tested in Node, Browser, Deno, and React Native environments"; ships `cjs/` and `es/`. | Features include "Copy pages between PDFs" (`PDFDocument.create()`, `copyPages(src, indices)`, `addPage`, `save()` → `Uint8Array`). README "Encryption Handling": "**does not currently support encrypted documents**". `load()` throws `EncryptedPDFError`, and `ignoreEncryption` "does not decrypt". README "Limitations": it can read text-field values (`PDFTextField.getText`) but "cannot extract plain text on a page outside of a form field". Dependencies: `pako ^1`, `tslib ^1`, `@pdf-lib/standard-fonts`, `@pdf-lib/upng`. |
| `@cantoo/pdf-lib` | 2.11.1 (2026-09-15) | MIT | `dist/pdf-lib.min.js` 617 KB raw / 253 KB gz | Yes (same README claim) | README: "an **actively maintained fork** of Hopding/pdf-lib. We keep the original API". It adds `PDFDocument.encrypt()` and decryption of PDFs. The maintainer "cannot guarantee support for every issue outside that roadmap". README "Encryption Handling": decryption takes a password at `load()`, and `encrypt()` needs the Web Crypto API. Dependencies: `tslib >=2`, `culori >=4`, `fflate ^0.8.2`, `node-html-better-parser >=1.5.9`; peer `html-entities >=2.3.2`. |
| `pdfkit` | 0.21.0 (2026-11-20) | MIT | — | Yes | A PDF **generation** library ("for Node and the browser"). Its README describes no merging of existing PDFs. |

- *Inference:* merging on the server in Node with `pdf-lib` avoids loading carrier PDFs into the browser and sends one
  PDF to `print()` or to a download. The README documents Node support.
- **NOT DOCUMENTED:**
  - whether the Nova Post or other carrier label PDFs are encrypted. Upstream `pdf-lib` would reject encrypted files;
    test with real sandbox PDFs;
  - App Bridge printing of a PDF on Shopify Mobile (§1.4).

---

## 5. Gaps to close by manual testing (owner's test store, real devices)
1. Does `shopify.scanner.capture()` work in (a) the Shopify Mobile iOS app, (b) the Android app, and (c) admin.shopify.com
   in iPhone Safari or Android Chrome? What happens on an unsupported platform (reject or hang)? (§1.1: NOT DOCUMENTED.)
2. Does the admin iframe grant `camera`? Test with `getUserMedia({video:{facingMode:'environment'}})` in the app under
   admin.shopify.com on iPhone Safari and Android Chrome, and record whether it raises `NotAllowedError`. (§1.6, §2.2.)
3. Does `<input type=file capture=environment>` work inside the admin iframe on iOS and Android? (§2.3.)
4. Is a top-level standalone scanner page opened with `open(url,'_blank')` acceptable, given that it needs its own auth? (§1.5.)
5. Are the carrier label PDFs encrypted? This decides between `pdf-lib` and `@cantoo/pdf-lib`. (§4.)
6. Does `print()` of a merged PDF work in Shopify Mobile? (§1.4.)

---

## Verification notes

Verified 2026-11-27 by an independent pass that re-fetched every primary source:
- the shopify.dev `.md` pages cited in §1;
- raw `mdn/content` (main) for the BarcodeDetector, detect(), Barcode Detection API, getUserMedia, Permissions-Policy
  camera, Permissions Policy guide, iframe and capture pages;
- `@mdn/browser-compat-data@8.1.11` `data.json` (timestamp 2026-11-26T11:56:15Z, still `latest` on npm);
- npm registry metadata, plus the tarballs of all nine packages, extracted and measured locally with `gzip -9`;
- npm CLI docs from the `npm/cli` repository, `latest` branch, raw GitHub.

**Confirmed unchanged:**
- Scanner API text: "on Shopify POS", `capture(): Promise<ScannerPayload>`, `{ data: string }`.
- `app-bridge-library.md` redirects to `app-home/latest.md`.
- `embedded_app_direct_api_access`.
- Legacy Scanner requirements: iOS 8.25.0, Android 8.24.0, POS iOS 5.32.0, POS Android 3.25.0.
- Environment API booleans (`embedded`, `intent`, `mobile`, `pos`) and the "camera access or printing" use case.
- Print API quotes.
- Navigation `_blank` / `_top` quotes.
- frame-ancestors page, and the repo's `applySecurityHeaders` with no `Permissions-Policy`.
- Every BCD value in §2.1–§2.3, including current releases Safari iOS 27.2 and Chrome Android 158.
- MDN quotes on the top-level document, `NotAllowedError`, the default allowlist `self`, `allow-same-origin`,
  "further restriction", and the `capture` values.
- npm: every version, publish date, license and dependency in §3–§4, and every measured size, which match to the byte
  range quoted.
- READMEs: the @zxing/library maintenance-mode text and its iOS < 14.3 note, the html5-qrcode Zxing-js dependency and
  15.1 note, the barcode-detector polyfill "if it's not already present" and its jsDelivr default, and zxing-wasm
  "Web, Node.js, Bun, and Deno".
- pdf-lib: "Tested in Node, Browser, Deno, and React Native", "Copy pages between PDFs", `EncryptedPDFError`, and
  "ignoreEncryption … does not decrypt".
- @cantoo/pdf-lib "actively maintained fork" and pdfkit "generation library for Node and the browser".

**Corrected or refined in place:**
1. §3 quagga2: "1D barcodes only (per its README)" was not a README statement. The README lists only linear readers
   built in, and it points to the external `quagga2-reader-qr` module for QR codes.
2. §3 quagga2: the "Safari iOS: true" row was presented as a library support table. It is the output of a
   getUserMedia feature-detect snippet.
3. §3 @zxing/library: "effect on npm install NOT VERIFIED" is now answered from the npm docs. `engines` is advisory and
   only warns unless `engine-strict` is set, and the repo `.npmrc` does not set it. Also added: the engines bump to
   `>= 24.0.0` happened in 0.22.0, while 0.21.3 had `>= 10.4.0`. Runtime on Node 22 remains NOT DOCUMENTED.
4. §3 zxing-wasm: the file paths now carry the `dist/` prefix. Added that the README's stated sizes (~1.04 / ~1.46 MiB)
   do not match the measured 3.1.8 files.
5. §1.1: the example query passes `barcode:<value>` as a GraphQL variable, not inline. Added that the docs say
   `capture` resolves "or an error", with a try/catch example for cancel or failure, and that the API index mentions
   "product codes and QR codes". The behaviour on an unsupported platform is still NOT DOCUMENTED.
6. §1.2: exact legacy names, `OPEN::CAMERA` / `APP::SCANNER::OPEN::CAMERA` / `Scanner.Action.OPEN_CAMERA`. Legacy
   payload field `scanData`.
7. §1.3: `--shopify-safe-area-inset-bottom` is not mobile-only. The doc says it "applies wherever your app runs,
   including desktop and mobile web".
8. §2.1: the `detect()` source list now includes `SVGImageElement` and `OffscreenCanvas`.
9. §2.2 inference: added admin's own `Permissions-Policy` header (Chrome) as a second Shopify-side gate. Noted that
   Safari iOS supports the iframe `allow` attribute but not the header.
10. §4 pdf-lib: "cannot extract page text" now gives the README's exact scope: form-field text can be read, plain page
    text cannot.

**Not re-verifiable here:**
- The forum-thread titles in §1.6. community.shopify.dev is still unreachable, so they stay labelled unofficial.
- The absence of a Shopify statement on `allow="camera"`. Re-checked with no mention found on `app-home/latest.md`,
  the API index, Environment, Print, Navigation, iframe protection and `apps/build/mobile-support.md`. A site-wide
  search was not possible, so the claim is "not found in the pages checked".
- GitHub repository activity for any library.
