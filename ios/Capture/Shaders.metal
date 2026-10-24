#include <metal_stdlib>
using namespace metal;

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
    out.position = float4(quadPositions[vid], 0.0, 1.0);
    out.texCoord = texCoords[vid];
    return out;
}

// capturedImage is 420YpCbCr8BiPlanarFullRange, so use full-range BT.601.
// The video-range matrix here gives washed-out or green-tinted colors.
fragment half4 cameraFragment(CameraVertexOut in [[stage_in]],
                              texture2d<float, access::sample> lumaTexture [[texture(0)]],
                              texture2d<float, access::sample> chromaTexture [[texture(1)]]) {
    constexpr sampler linearSampler(filter::linear, address::clamp_to_edge);
    float y = lumaTexture.sample(linearSampler, in.texCoord).r;
    float2 cbcr = chromaTexture.sample(linearSampler, in.texCoord).rg - float2(0.5);
    float3 rgb = float3(y + 1.402 * cbcr.y,
                        y - 0.344136 * cbcr.x - 0.714136 * cbcr.y,
                        y + 1.772 * cbcr.x);
    return half4(half3(saturate(rgb)), 1.0h);
}
