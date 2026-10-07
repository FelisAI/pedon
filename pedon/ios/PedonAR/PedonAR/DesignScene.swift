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
        castNoShadows(world)
        return world
    }

    /// Nothing PEDON draws casts a grounding shadow onto the real surfaces ARKit scans (CA1).
    /// RealityKit keeps shadow maps for every casting object: the 616-object planting guide made
    /// 1.4 GB of them (five 253 MB textures from its MeshShadowProvider) the moment it was drawn
    /// over a real garden, and iOS ended the app. ARView's `.disableGroundingShadows` did not stop
    /// it; turning casting off on each object did. A plan drawn on the ground needs no shadow.
    @MainActor static func castNoShadows(_ entity: Entity) {
        entity.components.set(GroundingShadowComponent(castsShadow: false))
        for child in entity.children { castNoShadows(child) }
    }
}
