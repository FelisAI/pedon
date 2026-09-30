import SwiftUI

struct PlantVisibilityView: View {
    @ObservedObject var flow: Flow
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    private var filtered: [PlantItem] {
        flow.plants.filter { search.isEmpty || "\($0.name) \($0.id)".localizedCaseInsensitiveContains(search) }
    }
    var body: some View {
        NavigationStack {
            List {
                if flow.plants.isEmpty {
                    Text("Make a fresh export on the Mac: ··· → See it on site. Then reload here to control individual plants.")
                } else {
                    Section {
                        HStack {
                            Button("Show all") { flow.hiddenPlants = []; if !flow.plantingGuide { flow.showPlants = true } }
                            Spacer()
                            Button("Hide all") { flow.hiddenPlants = Set(flow.plants.map(\.id)) }
                        }.buttonStyle(.borderless)
                    }
                    Section("\(flow.plants.count - flow.hiddenPlants.count) of \(flow.plants.count) visible") {
                        ForEach(filtered) { plant in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Button {
                                        flow.selectedPlantID = plant.id
                                        flow.showPlant(plant.id, true)
                                        dismiss()
                                    } label: {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(plant.name).foregroundStyle(.primary)
                                            Text(plant.id).font(.caption).foregroundStyle(.secondary)
                                        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                    }.buttonStyle(.plain).accessibilityIdentifier("select-\(plant.id)")
                                    Toggle("Show \(plant.name)", isOn: Binding(get: { !flow.hiddenPlants.contains(plant.id) },
                                                                            set: { flow.showPlant(plant.id, $0) }))
                                        .labelsHidden().accessibilityIdentifier("plant-\(plant.id)")
                                }
                                Button("Show only this") { flow.showOnly(plant.id); dismiss() }
                                    .font(.caption).buttonStyle(.borderless)
                            }
                        }
                    }
                }
            }
            .searchable(text: $search, prompt: "Plant name or ID")
            .navigationTitle("Individual plants")
            .toolbar { Button("Done") { dismiss() } }
        }
        .presentationDetents([.medium, .large])
    }
}
