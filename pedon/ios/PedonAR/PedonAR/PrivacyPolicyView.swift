import SwiftUI

/// The same policy published in the repository is bundled for offline reading.
struct PrivacyPolicyView: View {
    private var paragraphs: [String] {
        guard let url = Bundle.main.url(forResource: "privacy", withExtension: "md"),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            return ["The privacy policy could not be loaded. Open the public policy below."]
        }
        return text.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                    if paragraph.hasPrefix("# ") {
                        Text(String(paragraph.dropFirst(2))).font(.title2.bold())
                    } else if paragraph.hasPrefix("## ") {
                        Text(String(paragraph.dropFirst(3))).font(.headline).padding(.top, 8)
                    } else {
                        Text(.init(paragraph)).font(.body)
                    }
                }
                Link("Public privacy policy", destination: URL(string: "https://github.com/FelisAI/pedon/blob/main/pedon/ios/privacy.md")!)
            }
            .frame(maxWidth: 650, alignment: .leading).padding(20)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Privacy")
        .navigationBarTitleDisplayMode(.inline)
    }
}
