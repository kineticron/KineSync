// Linear premultiplied reduction with a phase-preserving vertical tent.
// A disjoint box loses the source's position inside a reduced texel, so
// scrolling thin strokes stick to the low-resolution grid then jump.
@group(0) @binding(0) var input: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba16float, write>;
fn linear(c: vec3<f32>) -> vec3<f32> {
    return select(pow((c + 0.055) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
}
@compute @workgroup_size(8, 8)
fn downsample(@builtin(global_invocation_id) gid: vec3<u32>) {
    let out_size = textureDimensions(output);
    if any(gid.xy >= out_size) { return; }
    let size = textureDimensions(input);
    // Match the quarter-resolution allocation even at partial edge tiles.
    let sx = 4;
    let sy = 4;
    let base = vec2<i32>(gid.xy * 4u);
    var sum = vec4<f32>(0.0);
    // At 4x: offsets -2..5, weights [1,3,5,7,7,5,3,1]/32.
    // Adjacent output rows overlap, preserving mass and vertical centroid
    // for every source-pixel phase, including fractional Vello coverage.
    let taps = 2 * sy;
    for (var y = 0; y < taps; y++) {
        let weight = f32(min(2 * y + 1, 4 * sy - 2 * y - 1)) / f32(2 * sy * sy);
        for (var x = 0; x < sx; x++) {
            let p = base + vec2<i32>(x, y - sy / 2);
            if all(p >= vec2<i32>(0)) && all(p < vec2<i32>(size)) {
                let c = textureLoad(input, p, 0);
                sum += vec4<f32>(linear(c.rgb) * c.a, c.a) * (weight / f32(sx));
            }
        }
    }
    textureStore(output, gid.xy, sum);
}
