import XCTest
import Foundation

@MainActor final class ScanFlowTests: XCTestCase {
    private func server() throws -> String {
        guard let value = ProcessInfo.processInfo.environment["PEDON_TEST_SERVER"],
              value.hasPrefix("http") else {
            throw XCTSkip("Set PEDON_TEST_SERVER to an exported site with a textured scan")
        }
        return value
    }

    func testRealScanPickingAndConnectionSettings() throws {
        let connection = try server()
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-resetConnection"]
        app.launch()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        XCTAssertFalse((field.value as? String ?? "").contains("localhost"))
        field.tap()
        field.typeText(connection)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.staticTexts["Original 3D scan"].waitForExistence(timeout: 60))
        let scan = app.otherElements["original-scan"]
        XCTAssertTrue(scan.waitForExistence(timeout: 10))
        attach(app, "Original scan")
        for attempt in 0..<3 {
            if attempt == 1 {
                scan.pinch(withScale: 4, velocity: 2)
                app.buttons["Show whole scan"].tap()
            }
            let use = app.buttons["Use these two points"]
            var newHit = false
            for (x,y) in [(0.45,0.48),(0.75,0.4),(0.3,0.6),(0.65,0.55),(0.4,0.4),
                          (0.6,0.4),(0.5,0.6),(0.25,0.5),(0.7,0.5),(0.5,0.3),(0.5,0.7)] {
                scan.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
                if !use.isEnabled { newHit = true }
                if newHit && use.exists && use.isEnabled { break }
            }
            attach(app, "Scan picks, visit \(attempt + 1)")
            XCTAssertTrue(newHit && use.isEnabled, "Must be able to pick again after returning")
            use.tap()
            XCTAssertTrue(app.buttons["Mark it"].waitForExistence(timeout: 5))
            app.buttons["Change points"].tap()
            XCTAssertTrue(app.staticTexts["Original 3D scan"].waitForExistence(timeout: 5))
        }
    }

    func testPlantingGuideAndCompactControls() async throws {
        let connection = try server()
        let (data, _) = try await URLSession.shared.data(from: URL(string: connection)!.appendingPathComponent("current.json"))
        let current = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let info = try XCTUnwrap(current["info"] as? [String: Any])
        let items = try XCTUnwrap(info["plant_items"] as? [[String: Any]])
        let item = try XCTUnwrap(items.first { $0["species"] as? String != nil })
        let id = try XCTUnwrap(item["id"] as? String)
        let species = try XCTUnwrap(item["species"] as? String)
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-previewPlaced", "-server", connection]
        app.launch()
        XCTAssertTrue(app.buttons["Individual plants"].waitForExistence(timeout: 60))
        attach(app, "Aligned controls")
        let guide = app.switches["Planting guide"]
        guide.tap()
        XCTAssertEqual(guide.value as? String, "1")
        app.buttons["Hide controls"].tap()
        XCTAssertTrue(app.buttons["3D view"].exists)
        XCTAssertTrue(app.buttons["Controls"].exists)
        XCTAssertFalse(app.buttons["Hide controls"].exists)
        attach(app, "Compact planting guide")
        app.buttons["Individual plants"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText(id)
        let plant = app.switches["plant-\(id)"]
        XCTAssertTrue(plant.waitForExistence(timeout: 5))
        XCTAssertEqual(plant.value as? String, "1")
        plant.tap()
        attach(app, "Plant toggle off")
        XCTAssertEqual(plant.value as? String, "0")
        plant.tap()
        XCTAssertEqual(plant.value as? String, "1")
        attach(app, "Find and show or hide a real plant")
        app.buttons["select-\(id)"].tap()
        XCTAssertTrue(app.buttons["Hide"].waitForExistence(timeout: 5))
        app.buttons["Hide"].tap()
        XCTAssertTrue(app.buttons["Show"].exists)
        app.buttons["Show"].tap()
        XCTAssertTrue(app.buttons["3D view"].exists, "Selecting a plant must keep the guide on")
        // The preview uses a real capture and centers this target; tap its projected center.
        app.buttons["Deselect plant"].tap()
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Hide"].waitForExistence(timeout: 5), "Ground targets must be selectable")
        attach(app, "Selected translucent plant")
        app.buttons["Plant details"].tap()
        XCTAssertTrue(app.staticTexts[species].waitForExistence(timeout: 5))
        attach(app, "Plant details")
        if let details = item["details"] as? [String: Any], details["cat_safe"] is NSNull {
            let catStatus = app.descendants(matching: .any).matching(NSPredicate(format:
                "label CONTAINS[c] 'Not verified' OR value CONTAINS[c] 'Not verified'")).firstMatch
            for _ in 0..<4 {
                if catStatus.exists { break }
                app.collectionViews.firstMatch.swipeUp()
            }
            attach(app, "Plant catalogue facts")
            XCTAssertTrue(catStatus.waitForExistence(timeout: 5))
        }
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["3D view"].exists)
        app.buttons["Controls"].tap()
        app.buttons["Adjust alignment"].tap()
        XCTAssertTrue(app.buttons["Other points"].exists)
        app.buttons["Other points"].tap()
        XCTAssertTrue(app.staticTexts["Original 3D scan"].waitForExistence(timeout: 5))
        attach(app, "Reselect after alignment")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name; image.lifetime = .keepAlways; add(image)
    }
}
