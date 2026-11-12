@group(0) @binding(0) var sharp: texture_2d<f32>;
@group(0) @binding(1) var near: texture_2d<f32>;
@group(0) @binding(2) var far: texture_2d<f32>;
@group(0) @binding(3) var output: texture_storage_2d<rgba8unorm, write>;
// Protected top/bottom, blur enable, unused.
@group(0) @binding(4) var<uniform> band: vec4<f32>;

@compute @workgroup_size(8, 8)
fn composite(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = textureDimensions(sharp);
    if any(gid.xy >= size) { return; }
    let p = vec2<i32>(gid.xy);
    let d = max(max(band.x - f32(gid.y), f32(gid.y) - band.y), 0.0);
    // Same protection/near/cross distances as native-shared-blur.tsx spicy profile.
    let strength = clamp(d / 60.0, 0.0, 1.0) * band.z;
    let far_weight = clamp((d - 160.0) / 60.0, 0.0, 1.0);
    let blurred = mix(textureLoad(near, p, 0), textureLoad(far, p, 0), far_weight);
    let color = mix(textureLoad(sharp, p, 0), blurred, strength);
    // A subtle viewport fade keeps clipped edge lines unobtrusive.
    let edge = min(f32(gid.y), f32(size.y - 1u - gid.y));
    let fade = clamp(edge / 30.0, 0.0, 1.0);
    let background = textureLoad(sharp, vec2<i32>(0, p.y), 0);
    textureStore(output, p, mix(background, color, fade));
}
