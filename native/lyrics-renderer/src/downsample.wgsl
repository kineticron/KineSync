@group(0) @binding(0) var input: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba16float, write>;
fn linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}
@compute @workgroup_size(8, 8)
fn downsample(@builtin(global_invocation_id) gid: vec3<u32>) {
    if any(gid.xy >= textureDimensions(output)) { return; }
    var sum = vec4<f32>(0.0);
    for (var y = 0u; y < 2u; y++) { for (var x = 0u; x < 2u; x++) {
        let p = gid.xy * 2u + vec2<u32>(x, y);
        if all(p < textureDimensions(input)) {
            let c = textureLoad(input, p, 0); // Vello writes straight sRGB.
            sum += vec4<f32>(linear(c.rgb) * c.a, c.a);
        }
    }}
    textureStore(output, gid.xy, sum * 0.25);
}
