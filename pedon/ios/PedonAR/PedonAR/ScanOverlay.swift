import RealityKit
import Foundation

/// An alignment reference in the SAME Y-up export frame as the proposed design.
/// Its imported root keeps the USD axis correction inside DesignScene's plain wrapper.
enum ScanOverlay {
    @MainActor static func load(_ url: URL) async throws -> Entity {
        let root = try await DesignScene.load(url)
        root.name = "original-scan-overlay"
        func removePicking(_ entity: Entity) {
            entity.components.remove(CollisionComponent.self)
            entity.components.remove(InputTargetComponent.self)
            for child in entity.children { removePicking(child) }
        }
        removePicking(root) // Never intercept a tap intended for a planting target.
        update(root, visible: false, opacity: 0.35)
        return root
    }

    @MainActor static func update(_ root: Entity, visible: Bool, opacity: Float) {
        root.isEnabled = visible
        root.components.set(OpacityComponent(opacity: max(0.15, min(0.8, opacity))))
    }
}
