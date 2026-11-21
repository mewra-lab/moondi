# Moondi PWA splash screen research

Reviewed November 21, 2026.

## Launch behavior

- **Chrome on Android.** Chrome can generate the installed app’s splash from its manifest name, background color, theme color, and a PNG icon of at least 512 × 512. The manifest background is an early paint hint while the app’s files load. Use the same background in Moondi’s initial HTML to make the browser-to-page handoff visually continuous. [Chrome for Developers](https://developer.chrome.com/docs/lighthouse/pwa/splash-screen/), [Web Application Manifest](https://www.w3.org/TR/appmanifest/#background_color-member).
- **Safari Home Screen apps.** Apple documents `apple-touch-startup-image` links for the launch image. Google’s platform guide documents matching the actual opening window dimensions and using media queries to select images. Use static PNG URLs in the initial HTML. A WebKit bug report records that `data:` and `blob:` startup images stopped displaying in some iOS 17 and 18 builds. [Apple Safari Web Content Guide](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html), [Google web.dev](https://web.dev/learn/pwa/enhancements#splash_screens), [WebKit bug 280262](https://bugs.webkit.org/show_bug.cgi?id=280262).
- **Moondi’s web loading screen.** Put the brand mark and the launch background in the first HTML response and carry the same design through React’s initial dashboard loading state. Finish as soon as the existing dashboard or error view is ready. Keep launch artwork generic because iOS can capture the app’s previous screen for launch when a startup image is unavailable. [Apple Safari Web Content Guide](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html).

## Apple image sizing

Select by logical device dimensions, pixel ratio, and orientation. For example, a 393 × 852 logical display at 3× uses a 1179 × 2556 portrait PNG and a 2556 × 1179 landscape PNG. Check device geometry directly before adding sizes. Apple distinguishes logical points, logical scale, physical pixels, and native scale, which can differ on models that downsample. As an example, Apple lists the iPhone 8 Plus at 414 × 736 points, UIKit scale 3, and physical resolution 1080 × 1920. App Store screenshot sizes provide a cross-check for asset dimensions. [Apple layout specifications](https://developer.apple.com/design/human-interface-guidelines/layout), [Apple device geometry](https://developer.apple.com/library/archive/documentation/DeviceInformation/Reference/iOSDeviceCompatibility/Displays/Displays.html), [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications).

Full-screen device images cover the matching full-screen launch configurations. iPad multitasking windows can need separate sizes beyond portrait and landscape. A single launch palette keeps the artwork consistent across installs. WebKit has an open report that some iOS versions retained the startup image chosen at installation after a system appearance change. Moondi’s web loading screen provides branded feedback once the page paints where native launch art has no match. [Google web.dev](https://web.dev/learn/pwa/enhancements#splash_screens), [WebKit bug 259328](https://bugs.webkit.org/show_bug.cgi?id=259328).

## Moondi implementation

The standalone launch color and HTML splash share the Dark Mode background (`#101114`). The build ships 40 static PNG files covering both orientations for 20 full-screen iPhone and iPad geometries. Safari can choose the matching file without running JavaScript. Workbox excludes this image set from the offline precache.

To regenerate the images and HTML links after changing the mark or supported sizes, run `python3 scripts/generate-pwa-startup-images.py` with Pillow installed. The production build uses the committed PNGs and has no Python build dependency.

An HTML retry link appears after 10 seconds if the page is still starting. The dashboard gives its initial API requests 15 seconds before it shows the normal error state and reload action.

## Verification

- Inspect the production HTML and manifest, and confirm that each startup PNG’s pixel dimensions agree with its media query. Confirm that startup assets resolve with an image content type on the served build.
- Throttle a browser launch to check the handoff from the HTML loading screen to React and then the dashboard. Check the existing error and access-denied views too.
- Verify the OS-owned splash by cold-launching the installed PWA from Android and iOS Home Screens. For iPad, check each supported orientation. Browser tab previews verify the page-level transition only. [Google web.dev](https://web.dev/learn/pwa/enhancements#splash_screens).
