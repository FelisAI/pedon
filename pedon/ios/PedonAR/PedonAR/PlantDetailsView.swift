import SwiftUI

/// All dimensions come from this individual in the design, including user overrides.
enum PlantSize {
    static func length(_ metres: Double?, metric: Bool = false) -> String? {
        guard let metres, metres.isFinite, metres > 0 else { return nil }
        if metric { return String(format: "%.2f m", metres) }
        let inches = Int((metres / 0.0254).rounded())
        let feet = inches / 12, remainder = inches % 12
        if feet == 0 { return "\(max(inches, 1)) in" }
        return "\(feet) ft" + (remainder > 0 ? " \(remainder) in" : "")
    }
    static func summary(_ plant: PlantItem) -> String? {
        let values = [length(plant.mature_height_m).map { "\($0) tall" },
                      length(plant.mature_spread_m).map { "\($0) wide" }].compactMap { $0 }
        return values.isEmpty ? nil : values.joined(separator: " × ")
    }
    static func both(_ value: Double?) -> String? {
        guard let imperial = length(value), let metric = length(value, metric: true) else { return nil }
        return "\(imperial) (\(metric))"
    }
}

struct PlantDetailsView: View {
    let plant: PlantItem
    @Environment(\.dismiss) private var dismiss
    private func words(_ value: String) -> String { value.replacingOccurrences(of: "_", with: " ").capitalized }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(plant.name).font(.title2.weight(.semibold))
                    if let species = plant.species, !species.isEmpty { Text(species).italic().foregroundStyle(.secondary) }
                    LabeledContent("Plant ID", value: plant.id)
                }
                if PlantSize.summary(plant) != nil {
                    Section {
                        if let size = PlantSize.both(plant.mature_height_m) { LabeledContent("Height", value: size) }
                        if let size = PlantSize.both(plant.mature_spread_m) { LabeledContent("Width", value: size) }
                    } header: { Text("Mature size in this design") }
                      footer: { Text((plant.size_override == true ? "Custom size for this plant. " : "") + "The preview uses these planned dimensions. Actual growth varies with conditions.") }
                }
                if let facts = plant.details {
                    Section("From your plant catalogue") {
                        if let sun = facts.sun { LabeledContent("Sun", value: sun == "sun" ? "Full sun" : words(sun)) }
                        if let water = facts.water { LabeledContent("Water", value: words(water)) }
                        if let bloom = facts.bloom { LabeledContent("Flowering", value: words(bloom)) }
                        if let form = facts.form { LabeledContent("Shape", value: words(form)) }
                        if let evergreen = facts.evergreen { LabeledContent("Evergreen", value: evergreen ? "Yes" : "No") }
                        if let native = facts.ca_native { LabeledContent("California native", value: native ? "Yes" : "No") }
                        if let range = facts.flowering_height_range_m, range.count == 2,
                           let low = PlantSize.both(range[0]), let high = PlantSize.both(range[1]) {
                            LabeledContent("Height in flower", value: "\(low) – \(high)")
                        }
                        LabeledContent("Cat safety", value: facts.identity_status == "needs_identification" ? "Not verified" :
                            facts.cat_safe.map { $0 ? "Listed as safe" : "Toxic to cats" } ?? "Not verified")
                        if facts.identity_status == "needs_identification" { Text("The exact variety still needs confirmation.").foregroundStyle(.secondary) }
                    }
                    if let note = facts.note, !note.isEmpty { Section("Notes") { Text(note) } }
                } else {
                    Section { Text("No additional plant details are included in this export.").foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Plant details").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
        }
        .presentationDetents([.medium, .large])
    }
}
