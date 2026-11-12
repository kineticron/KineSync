// One shared image per tier, not one filter per lyric or glyph.
@group(0) @binding(0) var input: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
// x/y: axis, z: sigma, w: unused. Dimensions come from the texture.
@group(0) @binding(2) var<uniform> params: vec4<f32>;

@compute @workgroup_size(8, 8)
fn blur(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = textureDimensions(input);
    if any(gid.xy >= size) { return; }
    let p = vec2<i32>(gid.xy);
    let axis = vec2<i32>(params.xy);
    let radius = i32(ceil(params.z * 3.0));
    var sum = vec4<f32>(0.0);
    var weights = 0.0;
    for (var i = -radius; i <= radius; i += 1) {
        let weight = exp(-f32(i*i) / (2.0 * params.z * params.z));
        let q = clamp(p + axis * i, vec2<i32>(0), vec2<i32>(size) - 1);
        sum += textureLoad(input, q, 0) * weight;
        weights += weight;
    }
    textureStore(output, p, sum / weights);
}
