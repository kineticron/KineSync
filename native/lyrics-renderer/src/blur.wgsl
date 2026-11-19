// Half-resolution linear premultiplied images, transparent zero padding.
@group(0) @binding(0) var input: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba16float, write>;
struct Params { axis_sigma: vec4<f32>, weights: array<vec4<f32>, 40> }
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(8, 8)
fn blur(@builtin(global_invocation_id) gid: vec3<u32>) {
    let size = textureDimensions(input);
    if any(gid.xy >= size) { return; }
    let p = vec2<i32>(gid.xy);
    let axis = vec2<i32>(params.axis_sigma.xy);
    let radius = i32(ceil(params.axis_sigma.z * 3.0));
    var sum = vec4<f32>(0.0);
    for (var i = -radius; i <= radius; i++) {
        let q = p + axis * i;
        if all(q >= vec2<i32>(0)) && all(q < vec2<i32>(size)) {
            sum += textureLoad(input, q, 0) * params.weights[u32(abs(i))].x;
        }
    }
    textureStore(output, p, sum);
}
