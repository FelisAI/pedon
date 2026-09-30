import RealityKit

/// Own plant visibility in both modes, so leaving the guide restores normal materials.
@MainActor
final class PlantDisplay {
    private let group: Entity?
    private let nodes: [String: Entity]
    init(root: Entity, plants: [PlantItem]) {
        group = root.findEntity(named: "planting")
        nodes = Dictionary(uniqueKeysWithValues: plants.compactMap { plant in
            root.findEntity(named: plant.node).map { (plant.id, $0) }
        })
    }
    func update(models: Bool, guide: Bool, hidden: Set<String>, selected: String?) {
        group?.isEnabled = guide ? selected.map { nodes[$0] != nil && !hidden.contains($0) } ?? false : models
        for (id, entity) in nodes {
            entity.isEnabled = !hidden.contains(id) && (!guide || id == selected)
            if guide && id == selected {
                entity.components.set(OpacityComponent(opacity: 0.5))
            } else {
                entity.components.remove(OpacityComponent.self)
            }
        }
    }
}
