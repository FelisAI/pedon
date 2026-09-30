// Measured surface picks and legacy ground samples, in the exported design frame.
import simd

/** The ground's height every `step` metres over the design, relative to the file's origin. */
struct Ground: Codable {
    let x0: Float, z0: Float, step: Float, nx: Int, nz: Int
    let h: [Float?]

    /// Bilinear between the four samples around (x, z); nil off the grid or where unmeasured.
    func height(_ x: Float, _ z: Float) -> Float? {
        let fx = (x - x0) / step, fz = (z - z0) / step
        let i = Int(fx.rounded(.down)), j = Int(fz.rounded(.down))
        guard i >= 0, j >= 0, i + 1 < nx, j + 1 < nz else { return nil }
        let tx = fx - Float(i), tz = fz - Float(j)
        let at = { (a: Int, b: Int) in self.h[b * self.nx + a] }
        guard let a = at(i, j), let b = at(i + 1, j), let c = at(i, j + 1), let d = at(i + 1, j + 1) else {
            return [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)].compactMap { $0 }.first
        }
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz
    }
}

/** A point the user picked: its measured x, y, z on the original scan. */
struct PickPoint: Codable, Equatable {
    let x: Float
    let z: Float
    let label: String
    /// Scan hits always carry their measured height. Ground fallback supports older points.
    let y: Float?

    func point(on ground: Ground?) -> SIMD3<Float> {
        SIMD3(x, y ?? ground?.height(x, z) ?? 0, z)
    }
}
