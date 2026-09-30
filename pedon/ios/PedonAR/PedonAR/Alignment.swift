// Align two original-scan surface picks with the same points marked on real ground.
// Solve one turn about vertical and one translation. ARKit is already level (+Y up),
// so there is no tilt to solve and scale stays 1: the exported geometry is in metres.
// Pure math, tested on the Mac without ARKit or RealityKit.
import simd

struct Alignment: Equatable {
    /// Turn about +Y, applied to the design's frame.
    let rotation: simd_quatf
    /// Then this move, in metres.
    let translation: SIMD3<Float>
    /// Horizontal metres between the two taps, and between the same landmarks in the file.
    /// They should agree: a mismatch means a wrong spot was tapped, or tracking drifted.
    let tappedApart: Float
    let plannedApart: Float

    /// How far the taps disagree with the plan, as a fraction: 0.02 is 2% too far apart.
    var stretch: Float { tappedApart / plannedApart - 1 }

    /// Design frame -> world, as the one matrix an anchor carries.
    var matrix: simd_float4x4 {
        var m = simd_float4x4(rotation)
        m.columns.3 = SIMD4<Float>(translation, 1)
        return m
    }

    func apply(_ p: SIMD3<Float>) -> SIMD3<Float> { rotation.act(p) + translation }

    /// The two landmarks are closer than this in plan: a turn fixed by two points a metre
    /// apart is only good to degrees, and a degree is 17 cm at a bed 10 m away.
    static let minimumApart: Float = 2

    /// `planA`, `planB`: the landmarks in the design file's frame. `tapA`, `tapB`: where the user
    /// tapped them on the real ground, in ARKit's world. The design is pinned at A — A lands
    /// exactly on his first tap, height and all — and turned so B points at his second tap.
    static func solve(planA: SIMD3<Float>, planB: SIMD3<Float>,
                      tapA: SIMD3<Float>, tapB: SIMD3<Float>) -> Alignment? {
        let u = SIMD2<Float>(planB.x - planA.x, planB.z - planA.z)
        let v = SIMD2<Float>(tapB.x - tapA.x, tapB.z - tapA.z)
        let lu = simd_length(u), lv = simd_length(v)
        guard lu >= minimumApart, lv >= minimumApart / 2 else { return nil }
        // the turn about +Y that carries u onto v. Rotating (x, z) by θ about +Y gives
        // (x cosθ + z sinθ, -x sinθ + z cosθ), so sinθ ∝ u.y·v.x - u.x·v.y (in x,z terms)
        let theta = atan2(u.y * v.x - u.x * v.y, u.x * v.x + u.y * v.y)
        let q = simd_quatf(angle: theta, axis: SIMD3<Float>(0, 1, 0))
        return Alignment(rotation: q, translation: tapA - q.act(planA), tappedApart: lv, plannedApart: lu)
    }

    /// A small correction by hand after the taps: turn about the first landmark (which
    /// stays where the user put it), or slide the whole design.
    func turned(by radians: Float, about planA: SIMD3<Float>) -> Alignment {
        let pivot = apply(planA)
        let q = simd_quatf(angle: radians, axis: SIMD3<Float>(0, 1, 0)) * rotation
        return Alignment(rotation: q, translation: pivot - q.act(planA),
                         tappedApart: tappedApart, plannedApart: plannedApart)
    }

    func moved(by d: SIMD3<Float>) -> Alignment {
        Alignment(rotation: rotation, translation: translation + d,
                  tappedApart: tappedApart, plannedApart: plannedApart)
    }

    /// A slide measured from where the user STANDS (AZ2, *"Lining it up"*): `forward` metres
    /// along the ground the way the phone faces, `right` metres across it. North means
    /// nothing in the garden; "away from me" and "to my left" do. `look` is the camera's
    /// -Z and `screenUp` its +Y, in world: a phone aimed straight down at the ground (how
    /// it is held to mark) has no heading in its look, so the top of the screen gives it.
    func slid(forward: Float, right: Float, look: SIMD3<Float>, screenUp: SIMD3<Float>) -> Alignment {
        func flat(_ v: SIMD3<Float>) -> SIMD3<Float>? {
            let h = SIMD3<Float>(v.x, 0, v.z)
            return simd_length(h) > 0.3 ? simd_normalize(h) : nil
        }
        guard let f = flat(look) ?? flat(screenUp) else { return self }
        let r = SIMD3<Float>(-f.z, 0, f.x)          // f turned a quarter to the right, about +Y
        return moved(by: f * forward + r * right)
    }
}
