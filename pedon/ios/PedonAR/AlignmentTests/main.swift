// cd ios/PedonAR && swiftc -O PedonAR/Alignment.swift PedonAR/PlanPick.swift PedonAR/DesignSource.swift AlignmentTests/main.swift -o /tmp/align && /tmp/align
//
// The two-tap alignment, checked the only way that means anything: put the design in the
// world with a turn and a move we CHOSE, tap where its landmarks would really be, and see
// the solver give that turn and move back — so every other plant lands where it should.
import simd
import Foundation

var failed = 0
func check(_ ok: Bool, _ what: String) { if !ok { failed += 1; print("FAIL", what) } }

// Synthetic reference points on sloping ground; start is the origin.
let start = SIMD3<Float>(0, 0, 0)
let fence = SIMD3<Float>(6.5, -1.4, 14.3)
let house = SIMD3<Float>(-15.7, 3.4, 2.3)
let plant = SIMD3<Float>(4.1, -0.7, 6.2)          // somewhere in a bed

var rng = SystemRandomNumberGenerator()
for trial in 0..<500 {
    let theta = Float.random(in: -Float.pi...Float.pi, using: &rng)
    let truth = Alignment(rotation: simd_quatf(angle: theta, axis: [0, 1, 0]),
                          translation: SIMD3<Float>(.random(in: -50...50, using: &rng), .random(in: -3...3, using: &rng),
                                                    .random(in: -50...50, using: &rng)),
                          tappedApart: 0, plannedApart: 0)
    let a = trial % 2 == 0 ? start : house, b = fence
    // he taps the real ground where the landmarks really are; the second tap's HEIGHT does
    // not matter (only its direction does), so it is thrown off on purpose
    let tapA = truth.apply(a), tapB = truth.apply(b) + SIMD3<Float>(0, .random(in: -1...1, using: &rng), 0)
    guard let fit = Alignment.solve(planA: a, planB: b, tapA: tapA, tapB: tapB) else { check(false, "no fit"); continue }
    check(simd_distance(fit.apply(a), tapA) < 1e-3, "the first landmark is not on his first tap")
    check(simd_distance(fit.apply(plant), truth.apply(plant)) < 2e-3,
          "a plant lands \(simd_distance(fit.apply(plant), truth.apply(plant))) m from where it belongs (θ=\(theta))")
    check(abs(fit.stretch) < 1e-4, "taps at the true spots read as stretched: \(fit.stretch)")
}

// a tap 10 cm off at a landmark 15.7 m away moves a plant 7 m further on by ~5 cm, not metres
do {
    let truth = Alignment(rotation: simd_quatf(angle: 0.7, axis: [0, 1, 0]), translation: [3, 0.2, -8], tappedApart: 0, plannedApart: 0)
    let fit = Alignment.solve(planA: start, planB: fence, tapA: truth.apply(start), tapB: truth.apply(fence) + [0.1, 0, 0])!
    let off = simd_distance(fit.apply(plant), truth.apply(plant))
    check(off < 0.08, "a 10 cm slip at the far landmark throws a bed plant \(off) m")
}
// the stretch is SAID: taps 5% too far apart
do {
    let fit = Alignment.solve(planA: start, planB: fence, tapA: .zero, tapB: fence * 1.05)!
    check(abs(fit.stretch - 0.05) < 1e-3, "a 5% stretch reads as \(fit.stretch)")
}
// two landmarks on top of each other fix no turn: refused, not guessed
check(Alignment.solve(planA: start, planB: [0.5, 0, 0.5], tapA: .zero, tapB: [3, 0, 0]) == nil, "a turn from landmarks 0.7 m apart")
check(Alignment.solve(planA: start, planB: fence, tapA: .zero, tapB: [0.2, 0, 0.1]) == nil, "the same spot tapped twice")
// a nudge turns about the first landmark, which stays put
do {
    let fit = Alignment.solve(planA: house, planB: fence, tapA: [1, 2, 3], tapB: [10, 2, 20])!
    let t = fit.turned(by: 0.01, about: house)
    check(simd_distance(t.apply(house), [1, 2, 3]) < 1e-4, "a nudge moved the first landmark")
    check(simd_distance(t.apply(fence), fit.apply(fence)) > 0.1, "a nudge did not turn anything")
}

// ── picking your own marks on the plan (AR1) ───────────────────────────────────
do {
    // the ground's height anywhere, between the samples
    let g = try! JSONDecoder().decode(Ground.self, from: #"{"x0":0,"z0":0,"step":1,"nx":3,"nz":3,"h":[0,1,2,0,1,2,0,1,null]}"#.data(using: .utf8)!)
    check(abs((g.height(0.5, 0.5) ?? -9) - 0.5) < 1e-5, "bilinear height: \(String(describing: g.height(0.5, 0.5)))")
    check(g.height(5, 5) == nil, "a height off the grid was invented")
    check(abs(PickPoint(x: 1.5, z: 0.5, label: "x", y: nil).point(on: g).y - 1.5) < 1e-5, "a picked point takes the ground's height")
    check(PickPoint(x: 1.5, z: 0.5, label: "x", y: 7).point(on: g).y == 7, "a landmark's own height was overridden")
}

// ── lining it up by hand (AZ2): slide from where he STANDS ─────────────────
// *"Lining it up"* — once marked, only a half-degree turn; a mark 20 cm off meant redoing
// both. "Away from me" must move the design away from the phone whatever way it faces,
// and a phone aimed nearly straight at the ground (how it is held to mark) still has a way.
do {
    let fit = Alignment.solve(planA: start, planB: fence, tapA: [2, 0, 3], tapB: [2 + 6.5, 0, 3 + 14.3])!
    for heading in [Float(0.3), 1.9, -2.4] {
        // the phone faces `heading` about +Y, tilted 30 degrees down; ARKit cameras look along -Z
        let look = simd_quatf(angle: heading, axis: [0, 1, 0]).act(simd_normalize(SIMD3<Float>(0, -0.5, -0.866)))
        let up = simd_quatf(angle: heading, axis: [0, 1, 0]).act(simd_normalize(SIMD3<Float>(0, 0.866, -0.5)))
        let flat = simd_normalize(SIMD3<Float>(look.x, 0, look.z))
        let away = fit.slid(forward: 0.05, right: 0, look: look, screenUp: up)
        check(simd_distance(away.apply(plant) - fit.apply(plant), flat * 0.05) < 1e-4, "away is not away from the phone at \(heading)")
        let right = fit.slid(forward: 0, right: 0.05, look: look, screenUp: up)
        let r = right.apply(plant) - fit.apply(plant)
        check(abs(simd_dot(r, flat)) < 1e-4 && abs(simd_length(r) - 0.05) < 1e-4, "right is not across the view at \(heading)")
        check(simd_cross(flat, r).y < 0, "right went left at \(heading)")
        check(right.rotation == fit.rotation, "a slide turned the design")
    }
    // aimed straight down at the ground: the look has no heading, so the top of the screen gives it
    let down = SIMD3<Float>(0, -1, 0), screenUp = SIMD3<Float>(0, 0, -1)
    let away = fit.slid(forward: 0.05, right: 0, look: down, screenUp: screenUp)
    check(simd_distance(away.apply(plant) - fit.apply(plant), [0, 0, -0.05]) < 1e-4, "no way to slide when aimed straight down")
}

print(failed == 0 ? "ALL PASS (\(500) random placements, picking, and sliding)" : "\(failed) FAILED")
exit(failed == 0 ? 0 : 1)
