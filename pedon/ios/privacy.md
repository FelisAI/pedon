# PEDON for iPhone — Privacy

Effective September 30, 2026. This policy covers the native PEDON iPhone app. The desktop editor and websites you choose to open have their own data handling.

## Your site stays with you

The PEDON app does not send your site, designs, camera images, or saved alignment to PEDON's developers. It has no developer-operated account service, advertising, tracking, or third-party analytics SDK.

## Camera and surroundings

With your permission, the camera and ARKit locate the design in the real world. Compatible devices can use depth information for occlusion. Camera frames and spatial information are processed on your iPhone. The app saves an AR world map and a camera reference picture to help recognize your location when you reopen it. It also saves pictures of the scan points you select. These are app-local files, not pictures added to your Photos library. The app does not request GPS location, microphone, contacts, or Photos-library access.

## Connecting to your Mac

You enter the address of your PEDON desktop viewer. The app requests design metadata, the design model and the original scan from that address. Like other network requests, these connections reveal your network address to the server you choose. Use a Mac and network you trust; the desktop's local connection uses HTTP. PEDON does not upload your camera images or saved AR map to that server.

## What is saved and for how long

The app keeps your downloaded design and scan, alignment points and reference pictures, saved AR map, connection address, and display preferences so you can reopen your work. Refresh replaces the downloaded design; choosing new alignment points replaces the saved alignment. The saved design, scan, AR map and pictures are excluded from device backups. Connection and interface preferences may be included in an iOS device backup. Temporary downloads can be removed by iOS.

To remove all app-local information, delete PEDON using iOS's Delete App action. Offloading the app keeps its documents and data. The separate files on your Mac are unaffected. You can revoke camera or local-network access in iPhone Settings; features that need that access will then be unavailable.

## Links and support

Opening a support or source-code link takes you to GitHub, whose privacy policy applies there. If you choose to post a support request, it is public: do not include private scans, camera pictures, addresses, or credentials. You can contact the maintainers through the [PEDON support page](https://github.com/FelisAI/pedon/blob/main/pedon/ios/support.md).

Apple may handle purchase, diagnostic, or device information under your Apple settings and Apple's privacy policy. This is separate from data sent by PEDON to its developers.

## Changes

We will update this policy when the app's data practices change. The [public policy](https://github.com/FelisAI/pedon/blob/main/pedon/ios/privacy.md) and the version included with the app describe those practices.
