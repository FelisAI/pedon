import XCTest

/// The App Store screenshots: the sample garden, never a private site. Opt-in, because they are
/// made for a listing rather than checked: `PEDON_STORE_SCREENSHOTS=1` (ios/appstore/README.md).
/// Each attachment is named in listing order.
@MainActor final class StoreScreenshots: XCTestCase {
    func testStoreScreenshots() throws {
        guard !(ProcessInfo.processInfo.environment["PEDON_STORE_SCREENSHOTS"] ?? "").isEmpty else {
            throw XCTSkip("Set PEDON_STORE_SCREENSHOTS=1 to make the App Store screenshots")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-resetConnection"]
        app.launch()
        guard app.buttons["Try the sample garden"].waitForExistence(timeout: 20) else {
            throw XCTSkip("This build carries no sample garden (ios/make_sample.py)")
        }
        app.buttons["Try the sample garden"].tap()
        let scan = app.otherElements["original-scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 60))
        sleep(2)
        let use = app.buttons["Use these two points"]
        var picked = 0
        for (x, y) in [(0.30, 0.62), (0.72, 0.56), (0.45, 0.48), (0.62, 0.66), (0.5, 0.55), (0.35, 0.5)] {
            scan.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap(); picked += 1
            if use.isEnabled && picked >= 2 { break }
        }
        sleep(1)
        shot(app, "1-pick-two-points")
        app.terminate()

        // The Simulator has no camera: the design stands on its own scan, seen from above.
        app.launchArguments = ["-previewPlaced", "-previewWide", "-server", "pedon-sample:"]
        app.launch()
        XCTAssertTrue(app.buttons["Individual plants"].waitForExistence(timeout: 60))
        app.buttons["Visible layers"].tap()
        let landmarks = app.switches["Landmarks"]
        if landmarks.waitForExistence(timeout: 5), (landmarks.value as? String) == "1" { landmarks.tap() }
        app.buttons["Visible layers"].tap()
        sleep(3)
        shot(app, "2-design-on-site")
        app.switches["Planting guide"].tap()
        sleep(2)
        app.buttons["Hide controls"].tap()
        app.buttons["Individual plants"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'select-'")).firstMatch
            .waitForExistence(timeout: 5))
        shot(app, "5-individual-plants")
        let search = app.searchFields.firstMatch
        search.tap(); search.typeText("muhly")
        // The second pink muhly; selecting it brings the preview camera to it.
        let muhly = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'select-'")).element(boundBy: 1)
        XCTAssertTrue(muhly.waitForExistence(timeout: 5))
        muhly.tap()
        sleep(3)
        shot(app, "3-planting-guide")
        app.buttons["Plant details"].tap()
        sleep(2)
        shot(app, "4-plant-details")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name; image.lifetime = .keepAlways; add(image)
    }
}
