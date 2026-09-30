import XCTest
import RealityKit
@testable import PedonAR

@MainActor final class PlantGuideTests: XCTestCase {
    func testRealExportTargetsAndIndividualVisibility() async throws {
        guard let server = ProcessInfo.processInfo.environment["PEDON_TEST_SERVER"],
              server.hasPrefix("http"), let base = URL(string: server) else {
            throw XCTSkip("Set PEDON_TEST_SERVER to exercise your real exported design")
        }
        let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("current.json"))
        let current = try JSONDecoder().decode(Current.self, from: data)
        let items = try XCTUnwrap(current.info?.plant_items)
        XCTAssertGreaterThanOrEqual(items.count, 2, "Export a design with at least two plants")
        let (file, _) = try await URLSession.shared.download(from: base.appendingPathComponent(current.name!))
        let local = file.appendingPathExtension("usdz")
        try FileManager.default.moveItem(at: file, to: local)
        defer { try? FileManager.default.removeItem(at: local) }
        let design = try await DesignScene.load(local)
        try checkGuide(design: design, items: items)
    }

    func testGuidePreviewWithoutSite() throws {
        let items = try JSONDecoder().decode([PlantItem].self, from: Data(#"""
        [{"id":"p1","name":"Example sage","node":"plant_1","at":[1,0.2,2],
          "mature_height_m":0.9144,"mature_spread_m":0.9144,"details":{"water":"low","cat_safe":null}},
         {"id":"p2","name":"Example grass","node":"plant_2","at":[-3,0.8,1]}]
        """#.utf8))
        let design = Entity(), planting = Entity()
        planting.name = "planting"; design.addChild(planting)
        for plant in items {
            let node = ModelEntity(mesh: .generateBox(size: 1))
            node.name = plant.node; node.position = try XCTUnwrap(plant.point)
            planting.addChild(node)
        }
        XCTAssertEqual(PlantSize.summary(items[0]), "3 ft tall × 3 ft wide")
        XCTAssertEqual(items[0].details?.water, "low")
        XCTAssertNil(items[0].details?.cat_safe)
        XCTAssertNil(PlantSize.summary(items[1]))
        try checkGuide(design: design, items: items)
    }

    private func checkGuide(design: Entity, items: [PlantItem]) throws {
        let guide = PlantingGuide(plants: items)
        design.addChild(guide.root)
        XCTAssertEqual(guide.targets.count, items.count)
        // Aligning/turning the design must carry its guide in exactly the same frame.
        let parent = Entity()
        parent.orientation = simd_quatf(angle: 25 * .pi / 180, axis: [0,1,0])
        parent.position = [3,-2,1]
        parent.addChild(design)
        var entities = Set<ObjectIdentifier>()
        for plant in items {
            let entity = try XCTUnwrap(design.findEntity(named: plant.node))
            XCTAssertTrue(entities.insert(ObjectIdentifier(entity)).inserted)
            let point = try XCTUnwrap(plant.point)
            let target = try XCTUnwrap(guide.targets[plant.id])
            let center = entity.visualBounds(relativeTo: design).center
            XCTAssertEqual(center.x, point.x, accuracy: 0.002, plant.id)
            XCTAssertEqual(center.z, point.z, accuracy: 0.002, plant.id)
            XCTAssertLessThan(simd_distance(target.position(relativeTo: nil), design.convert(position: point, to: nil)), 0.00001)
            entity.isEnabled = false
            XCTAssertFalse(entity.isEnabled)
            entity.isEnabled = true
        }
        let display = PlantDisplay(root: design, plants: items)
        let first = items[0], next = items[1]
        let firstEntity = try XCTUnwrap(design.findEntity(named: first.node))
        let nextEntity = try XCTUnwrap(design.findEntity(named: next.node))
        let planting = try XCTUnwrap(design.findEntity(named: "planting"))
        let firstBounds = firstEntity.visualBounds(relativeTo: design)
        display.update(models: true, guide: true, hidden: [], selected: first.id)
        XCTAssertTrue(planting.isEnabled)
        XCTAssertTrue(firstEntity.isEnabled)
        XCTAssertFalse(nextEntity.isEnabled)
        XCTAssertEqual(firstEntity.components[OpacityComponent.self]?.opacity, 0.5)
        XCTAssertEqual(firstEntity.visualBounds(relativeTo: design).extents, firstBounds.extents)
        display.update(models: true, guide: true, hidden: [], selected: next.id)
        XCTAssertFalse(firstEntity.isEnabled)
        XCTAssertNil(firstEntity.components[OpacityComponent.self])
        XCTAssertEqual(nextEntity.components[OpacityComponent.self]?.opacity, 0.5)
        display.update(models: true, guide: true, hidden: [next.id], selected: next.id)
        XCTAssertFalse(planting.isEnabled)
        display.update(models: true, guide: true, hidden: [], selected: nil)
        XCTAssertFalse(planting.isEnabled)
        display.update(models: true, guide: false, hidden: [first.id], selected: next.id)
        XCTAssertTrue(planting.isEnabled)
        XCTAssertFalse(firstEntity.isEnabled)
        XCTAssertTrue(nextEntity.isEnabled)
        XCTAssertNil(nextEntity.components[OpacityComponent.self])
        let hidden = items[0].id, selected = items[1].id
        guide.update(on: true, hidden: [hidden], selected: selected)
        XCTAssertTrue(guide.root.isEnabled)
        XCTAssertFalse(guide.targets[hidden]!.isEnabled)
        XCTAssertTrue(guide.targets[selected]!.isEnabled)
        XCTAssertEqual(guide.targets.values.filter(\.isEnabled).count, items.count-1)
        guide.update(on: false, hidden: [], selected: nil)
        XCTAssertFalse(guide.root.isEnabled)
        XCTAssertTrue(guide.targets[hidden]!.isEnabled)
    }
}
