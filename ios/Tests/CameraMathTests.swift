import simd
import XCTest
@testable import BraindanceCapture

final class CameraMathTests: XCTestCase {
    /// iPhone-like intrinsics at 1920x1440, principal point at the center.
    private let K = simd_float3x3(
        SIMD3<Float>(1500, 0, 0),
        SIMD3<Float>(0, 1500, 0),
        SIMD3<Float>(960, 720, 1))

    private var depthK: CameraMath.Intrinsics {
        CameraMath.depthIntrinsics(from: K, imageWidth: 1920, imageHeight: 1440, depthWidth: 256, depthHeight: 192)
    }

    func testIntrinsicsScaleToDepthGrid() {
        let k = depthK
        XCTAssertEqual(k.x, 200, accuracy: 1e-4)   // fx * 256/1920
        XCTAssertEqual(k.y, 200, accuracy: 1e-4)   // fy * 192/1440
        XCTAssertEqual(k.z, 128, accuracy: 1e-4)   // cx * 256/1920
        XCTAssertEqual(k.w, 96, accuracy: 1e-4)    // cy * 192/1440
    }

    /// A flat wall 1 m in front of the camera must land at z = -1 in ARKit
    /// camera space for every pixel (IOS_CAPTURE_PLAN.md 11, coordinate flip).
    func testPlaneAtOneMeterLandsAtMinusOneZ() {
        for v in Swift.stride(from: 0, to: 192, by: 16) {
            for u in Swift.stride(from: 0, to: 256, by: 16) {
                let p = CameraMath.unprojectToCamera(u: Float(u), v: Float(v), depth: 1, intrinsics: depthK)
                XCTAssertEqual(p.z, -1, accuracy: 1e-6)
            }
        }
    }

    func testPrincipalPointIsStraightAhead() {
        let p = CameraMath.unprojectToCamera(u: 128, v: 96, depth: 2, intrinsics: depthK)
        XCTAssertEqual(p.x, 0, accuracy: 1e-5)
        XCTAssertEqual(p.y, 0, accuracy: 1e-5)
        XCTAssertEqual(p.z, -2, accuracy: 1e-6)
    }

    /// Image rows grow downward but ARKit's y points up.
    func testAxesFlipFromImageToARKit() {
        let right = CameraMath.unprojectToCamera(u: 228, v: 96, depth: 1, intrinsics: depthK)
        XCTAssertEqual(right.x, 0.5, accuracy: 1e-6)    // 100 px right at f = 200 -> 0.5 m
        XCTAssertEqual(right.y, 0, accuracy: 1e-6)

        let below = CameraMath.unprojectToCamera(u: 128, v: 196, depth: 1, intrinsics: depthK)
        XCTAssertEqual(below.y, -0.5, accuracy: 1e-6)   // lower in the image -> lower in the world
    }

    func testWorldTransformAppliesPose() {
        // Camera 1.5 m up, turned 90 degrees left (about +y): it now looks down world -x.
        let c = cos(Float.pi / 2), s = sin(Float.pi / 2)
        let T = simd_float4x4(
            SIMD4<Float>(c, 0, -s, 0),
            SIMD4<Float>(0, 1, 0, 0),
            SIMD4<Float>(s, 0, c, 0),
            SIMD4<Float>(0, 1.5, 0, 1))
        let p = CameraMath.unprojectToWorld(u: 128, v: 96, depth: 2, intrinsics: depthK, cameraToWorld: T)
        XCTAssertEqual(p.x, -2, accuracy: 1e-5)
        XCTAssertEqual(p.y, 1.5, accuracy: 1e-5)
        XCTAssertEqual(p.z, 0, accuracy: 1e-5)
    }
}

final class PoseDeltaTests: XCTestCase {
    private func pose(x: Float = 0, yawDegrees: Float = 0) -> simd_float4x4 {
        var m = simd_float4x4(simd_quatf(angle: yawDegrees * .pi / 180, axis: SIMD3<Float>(0, 1, 0)))
        m.columns.3 = SIMD4<Float>(x, 0, 0, 1)
        return m
    }

    func testStandingStillDoesNotAccumulate() {
        XCTAssertFalse(PoseDelta.movedEnough(from: pose(), to: pose(x: 0.01, yawDegrees: 1)))
    }

    func testThreeCentimetersAccumulates() {
        XCTAssertTrue(PoseDelta.movedEnough(from: pose(), to: pose(x: 0.03)))
    }

    func testThreeDegreesAccumulates() {
        XCTAssertTrue(PoseDelta.movedEnough(from: pose(), to: pose(yawDegrees: 3)))
    }

    func testRotationAngleIsMeasuredCorrectly() {
        XCTAssertEqual(PoseDelta.rotationAngle(from: pose(yawDegrees: 10), to: pose(yawDegrees: 40)),
                       30 * .pi / 180, accuracy: 1e-4)
    }
}
