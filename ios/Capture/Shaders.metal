#include <metal_stdlib>
using namespace metal;

// capturedImage is 420YpCbCr8BiPlanarFullRange, so use full-range BT.601.
// The video-range matrix here gives washed-out or green-tinted colors.
static float3 ycbcrToRGB(float y, float2 cbcr) {
    cbcr -= float2(0.5);
    return saturate(float3(y + 1.402 * cbcr.y,
                           y - 0.344136 * cbcr.x - 0.714136 * cbcr.y,
                           y + 1.772 * cbcr.x));
}

// MARK: Camera background

struct CameraVertexOut {
    float4 position [[position]];
    float2 texCoord;
};

// Full-screen quad as a triangle strip: bottom-left, bottom-right, top-left, top-right.
// Renderer.cameraTexCoords supplies matching texture coordinates in the same order.
constant float2 quadPositions[4] = {
    float2(-1.0, -1.0), float2(1.0, -1.0), float2(-1.0, 1.0), float2(1.0, 1.0)
};

vertex CameraVertexOut cameraVertex(uint vid [[vertex_id]],
                                    constant float2 *texCoords [[buffer(0)]]) {
    CameraVertexOut out;
    // Drawn first with depth writes off, so points always land on top of it.
    out.position = float4(quadPositions[vid], 0.0, 1.0);
    out.texCoord = texCoords[vid];
    return out;
}

fragment half4 cameraFragment(CameraVertexOut in [[stage_in]],
                              texture2d<float, access::sample> lumaTexture [[texture(0)]],
                              texture2d<float, access::sample> chromaTexture [[texture(1)]]) {
    constexpr sampler linearSampler(filter::linear, address::clamp_to_edge);
    float y = lumaTexture.sample(linearSampler, in.texCoord).r;
    float2 cbcr = chromaTexture.sample(linearSampler, in.texCoord).rg;
    return half4(half3(ycbcrToRGB(y, cbcr)), 1.0h);
}

// MARK: Point cloud

// 16 bytes. PointAccumulator.bytesPerPoint and the exporters depend on this layout.
struct CloudPoint {
    packed_float3 position;   // ARKit world, meters
    uchar4 color;             // sRGB, alpha unused (255)
};

// Mirrors AccumulateUniforms in PointAccumulator.swift.
struct AccumulateUniforms {
    float4x4 cameraToWorld;
    float4 intrinsics;        // fx, fy, cx, cy scaled to the depth grid
    float2 depthRange;        // min, max meters
    uint stride;
    uint maxPoints;
};

// One thread per sampled depth pixel. Same math as CameraMath.unprojectToWorld
// on the CPU; keep them identical.
kernel void unprojectKernel(uint2 gid [[thread_position_in_grid]],
                            texture2d<float, access::read> depthTexture [[texture(0)]],
                            texture2d<uint, access::read> confidenceTexture [[texture(1)]],
                            texture2d<float, access::sample> lumaTexture [[texture(2)]],
                            texture2d<float, access::sample> chromaTexture [[texture(3)]],
                            constant AccumulateUniforms &u [[buffer(0)]],
                            device CloudPoint *points [[buffer(1)]],
                            device atomic_uint *writeIndex [[buffer(2)]]) {
    uint2 pixel = gid * u.stride;
    uint width = depthTexture.get_width();
    uint height = depthTexture.get_height();
    if (pixel.x >= width || pixel.y >= height) return;

    // ARConfidenceLevel: 0 low, 1 medium, 2 high. Keep high only.
    if (confidenceTexture.read(pixel).r < 2) return;

    float d = depthTexture.read(pixel).r;
    // Written so NaN fails the test too.
    if (!(d >= u.depthRange.x && d <= u.depthRange.y)) return;

    // Image-camera space (y down, z forward), then flip to ARKit camera
    // space (y up, looking down -z), then to world.
    float fx = u.intrinsics.x, fy = u.intrinsics.y, cx = u.intrinsics.z, cy = u.intrinsics.w;
    float x = (float(pixel.x) - cx) * d / fx;
    float y = (float(pixel.y) - cy) * d / fy;
    float4 world = u.cameraToWorld * float4(x, -y, -d, 1.0);

    // Depth and image share the 4:3 aspect and orientation, so the depth
    // pixel's center maps to the image by the same normalized coordinate.
    constexpr sampler linearSampler(filter::linear, address::clamp_to_edge);
    float2 uv = (float2(pixel) + 0.5) / float2(width, height);
    float luma = lumaTexture.sample(linearSampler, uv).r;
    float2 cbcr = chromaTexture.sample(linearSampler, uv).rg;
    float3 rgb = ycbcrToRGB(luma, cbcr);

    uint index = atomic_fetch_add_explicit(writeIndex, 1, memory_order_relaxed);
    if (index >= u.maxPoints) return;   // full: the app stops accumulating
    points[index].position = packed_float3(world.xyz);
    points[index].color = uchar4(uchar3(rgb * 255.0 + 0.5), 255);
}

// Mirrors PointUniforms in Renderer.swift.
struct PointUniforms {
    float4x4 viewProjection;
    float pointSize;          // drawable pixels
    float brightness;         // >1 makes captured areas "light up" over the feed
};

struct PointVertexOut {
    float4 position [[position]];
    float pointSize [[point_size]];
    half4 color;
};

vertex PointVertexOut pointVertex(uint vid [[vertex_id]],
                                  const device CloudPoint *points [[buffer(0)]],
                                  constant PointUniforms &u [[buffer(1)]]) {
    CloudPoint p = points[vid];
    PointVertexOut out;
    out.position = u.viewProjection * float4(float3(p.position), 1.0);
    out.pointSize = u.pointSize;
    float3 rgb = saturate(float3(p.color.rgb) / 255.0 * u.brightness);
    out.color = half4(half3(rgb), 1.0h);
    return out;
}

fragment half4 pointFragment(PointVertexOut in [[stage_in]]) {
    return in.color;
}
