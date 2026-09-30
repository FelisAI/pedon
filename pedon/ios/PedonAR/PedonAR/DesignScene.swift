import RealityKit
import Foundation

/// USD imports may carry their Z-up → Y-up rotation on the returned root itself.
/// New children belong in a plain Y-up wrapper, alongside that imported root.
enum DesignScene {
    @MainActor static func load(_ url: URL) async throws -> Entity {
        let imported = try await Entity(contentsOf: url)
        let world = Entity()
        world.name = "exported-design"
        world.addChild(imported)
        return world
    }
}
