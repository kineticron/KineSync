@group(0) @binding(0) var input: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}
fn srgb(c: vec3<f32>) -> vec3<f32> {
    return select(1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055, 12.92 * c, c <= vec3<f32>(0.0031308));
}
@fragment fn fs_main(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
    let c = textureLoad(input, vec2<i32>(p.xy), 0);
    // Locked Metal advertises PostMultiplied only. Unpremultiply once here.
    if c.a <= 0.0 { return vec4<f32>(0.0); }
    return vec4<f32>(srgb(c.rgb / c.a), c.a);
}
