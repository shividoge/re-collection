import simd

/// Coordinate math shared by the GPU kernel (Shaders.metal, `unprojectKernel`)
/// and the unit tests. The server (CLAUDE.md 6.4) and the web DepthReplay use
/// the same formulas, so any change here must change there too.
///
/// Conventions:
/// - Depth pixel (u, v): integer column and row in the depth map, origin top-left, v grows down.
/// - Image-camera space: x right, y down, z forward (d meters in front of the lens).
/// - ARKit camera space: x right, y up, camera looks down -z. Converting is (x, -y, -z).
/// - World: ARKit world, meters, y up. `cameraToWorld` is `ARCamera.transform`.
enum CameraMath {
    /// Pinhole intrinsics packed as (fx, fy, cx, cy), the layout the GPU kernel expects.
    typealias Intrinsics = SIMD4<Float>

    /// Scales ARKit's intrinsics, which refer to the full-resolution captured
    /// image (1920x1440), down to the depth map's grid (256x192). Both share
    /// the 4:3 aspect, so each axis scales by a straight ratio.
    ///
    /// `K` is column-major, so fx = K[0][0], fy = K[1][1], cx = K[2][0], cy = K[2][1].
    static func depthIntrinsics(
        from K: simd_float3x3,
        imageWidth: Float, imageHeight: Float,
        depthWidth: Float, depthHeight: Float
    ) -> Intrinsics {
        let sx = depthWidth / imageWidth
        let sy = depthHeight / imageHeight
        return Intrinsics(K[0][0] * sx, K[1][1] * sy, K[2][0] * sx, K[2][1] * sy)
    }

    /// Unprojects depth pixel (u, v) at depth `d` meters into ARKit camera space.
    static func unprojectToCamera(u: Float, v: Float, depth d: Float, intrinsics k: Intrinsics) -> SIMD3<Float> {
        let fx = k.x, fy = k.y, cx = k.z, cy = k.w
        // Image-camera space: y down, z forward.
        let x = (u - cx) * d / fx
        let y = (v - cy) * d / fy
        // Flip to ARKit camera space: y up, looking down -z.
        return SIMD3<Float>(x, -y, -d)
    }

    /// Unprojects depth pixel (u, v) all the way to ARKit world space.
    static func unprojectToWorld(
        u: Float, v: Float, depth d: Float,
        intrinsics k: Intrinsics,
        cameraToWorld T: simd_float4x4
    ) -> SIMD3<Float> {
        let p = unprojectToCamera(u: u, v: v, depth: d, intrinsics: k)
        let world = T * SIMD4<Float>(p, 1)
        return SIMD3<Float>(world.x, world.y, world.z)
    }
}

/// Decides when the camera has moved enough to accumulate another depth frame
/// (IOS_CAPTURE_PLAN.md 5.2). Standing still would otherwise pile duplicate
/// points onto the same surfaces.
enum PoseDelta {
    static let minTranslationMeters: Float = 0.02
    static let minRotationRadians: Float = 2 * .pi / 180

    static func movedEnough(from a: simd_float4x4, to b: simd_float4x4) -> Bool {
        translation(from: a, to: b) > minTranslationMeters
            || rotationAngle(from: a, to: b) > minRotationRadians
    }

    static func translation(from a: simd_float4x4, to b: simd_float4x4) -> Float {
        let pa = SIMD3<Float>(a.columns.3.x, a.columns.3.y, a.columns.3.z)
        let pb = SIMD3<Float>(b.columns.3.x, b.columns.3.y, b.columns.3.z)
        return simd_distance(pa, pb)
    }

    /// Angle of the relative rotation Ra^T * Rb, from its trace: tr = 1 + 2 cos(theta).
    static func rotationAngle(from a: simd_float4x4, to b: simd_float4x4) -> Float {
        let r = rotation(a).transpose * rotation(b)
        let trace = r[0][0] + r[1][1] + r[2][2]
        let cosine = min(1, max(-1, (trace - 1) / 2))
        return acos(cosine)
    }

    private static func rotation(_ m: simd_float4x4) -> simd_float3x3 {
        simd_float3x3(
            SIMD3<Float>(m.columns.0.x, m.columns.0.y, m.columns.0.z),
            SIMD3<Float>(m.columns.1.x, m.columns.1.y, m.columns.1.z),
            SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z))
    }
}
