import XCTest
@testable import PedonAR

final class ReleaseResourcesTests: XCTestCase {
    func testPrivacyResourcesShipInTheAppBundle() throws {
        let bundle = Bundle(for: ARGarden.self)
        let policy = try XCTUnwrap(bundle.url(forResource: "privacy", withExtension: "md"))
        XCTAssertTrue(try String(contentsOf: policy, encoding: .utf8).contains("Your site stays with you"))
        let manifestURL = try XCTUnwrap(bundle.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
        let manifest = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: manifestURL), format: nil) as? [String: Any])
        XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
        XCTAssertEqual((manifest["NSPrivacyCollectedDataTypes"] as? [Any])?.count, 0)
        let apis = try XCTUnwrap(manifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        let defaults = try XCTUnwrap(apis.first { $0["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategoryUserDefaults" })
        XCTAssertEqual(defaults["NSPrivacyAccessedAPITypeReasons"] as? [String], ["CA92.1"])
    }
}
