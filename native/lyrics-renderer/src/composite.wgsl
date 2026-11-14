@group(0) @binding(0) var sharp: texture_2d<f32>;
@group(0) @binding(1) var near: texture_2d<f32>;
@group(0) @binding(2) var far: texture_2d<f32>;
@group(0) @binding(3) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var<uniform> band: vec4<f32>;
fn linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}
fn padded(t: texture_2d<f32>, p: vec2<i32>) -> vec4<f32> {
    if any(p < vec2<i32>(0)) || any(p >= vec2<i32>(textureDimensions(t))) { return vec4<f32>(0.0); }
    return textureLoad(t, p, 0);
}
fn reconstructed(t: texture_2d<f32>, p: vec2<u32>) -> vec4<f32> {
    let q = (vec2<f32>(p) + 0.5) * 0.5 - 0.5;
    let lo = vec2<i32>(floor(q)); let f = fract(q);
    return mix(mix(padded(t, lo), padded(t, lo + vec2<i32>(1,0)), f.x),
               mix(padded(t, lo + vec2<i32>(0,1)), padded(t, lo + vec2<i32>(1,1)), f.x), f.y);
}
@compute @workgroup_size(8, 8)
fn composite(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = textureDimensions(sharp);
    if any(gid.xy >= size) { return; }
    let d = max(max(band.x - f32(gid.y), f32(gid.y) - band.y), 0.0);
    let strength = clamp(d / (60.0 * band.w), 0.0, 1.0) * band.z;
    let far_weight = clamp((d - 160.0 * band.w) / (60.0 * band.w), 0.0, 1.0);
    let c = textureLoad(sharp, gid.xy, 0);
    var color = vec4<f32>(linear(c.rgb) * c.a, c.a);
    if strength > 0.0 {
        var blurred = reconstructed(near, gid.xy);
        if far_weight > 0.0 { blurred = mix(blurred, reconstructed(far, gid.xy), far_weight); }
        color = mix(color, blurred, strength);
    }
    let edge = min(f32(gid.y), f32(size.y - 1u - gid.y));
    // Fade alpha AND RGB together: no arbitrary left-edge background sample.
    textureStore(output, gid.xy, color * clamp(edge / 30.0, 0.0, 1.0));
}
