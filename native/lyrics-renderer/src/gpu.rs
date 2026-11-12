//! Vello rasterization, shared GPU blur/composition, optional timestamp brackets.
use serde::Serialize;
use std::{fs::File, io::BufWriter, sync::mpsc, time::Instant};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene, peniko::Color};
use wgpu::{util::DeviceExt, *};
type Error = Box<dyn std::error::Error>;

#[derive(Serialize)]
pub struct FrameStats {
    pub cpu_encode_ms: f64,
    pub wait_readback_ms: f64,
    pub gpu_interval_ms: Option<f64>,
}
struct Timestamps {
    queries: QuerySet,
    resolve: Buffer,
    readback: Buffer,
}
struct Filter {
    pipeline: ComputePipeline,
    groups: Vec<BindGroup>,
    composite: ComputePipeline,
    composite_group: BindGroup,
    band: Buffer,
    // Textures retained for the lifetime of the bind groups, avoiding per-frame allocation.
    _textures: Vec<Texture>,
}

pub struct Gpu {
    device: Device,
    queue: Queue,
    renderer: Renderer,
    sharp: Texture,
    target: Texture,
    filter: Filter,
    timestamps: Option<Timestamps>,
    width: u32,
    height: u32,
    pub adapter: String,
}

fn texture(device: &Device, width: u32, height: u32, label: &str) -> Texture {
    device.create_texture(&TextureDescriptor {
        label: Some(label),
        size: Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: TextureDimension::D2,
        format: TextureFormat::Rgba8Unorm,
        usage: TextureUsages::STORAGE_BINDING
            | TextureUsages::TEXTURE_BINDING
            | TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}
fn uniform(device: &Device, label: &str, values: [f32; 4]) -> Buffer {
    let bytes: Vec<u8> = values.into_iter().flat_map(f32::to_le_bytes).collect();
    device.create_buffer_init(&util::BufferInitDescriptor {
        label: Some(label),
        contents: &bytes,
        usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
    })
}
fn pipeline(device: &Device, label: &str, source: &str, entry: &str) -> ComputePipeline {
    let module = device.create_shader_module(ShaderModuleDescriptor {
        label: Some(label),
        source: ShaderSource::Wgsl(source.into()),
    });
    device.create_compute_pipeline(&ComputePipelineDescriptor {
        label: Some(label),
        layout: None,
        module: &module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    })
}
fn view_entry(binding: u32, view: &TextureView) -> BindGroupEntry<'_> {
    BindGroupEntry {
        binding,
        resource: BindingResource::TextureView(view),
    }
}
fn read_buffer(device: &Device, buffer: &Buffer) -> Result<Vec<u8>, Error> {
    let (tx, rx) = mpsc::channel();
    buffer.slice(..).map_async(MapMode::Read, move |result| {
        let _ = tx.send(result);
    });
    device.poll(PollType::wait_indefinitely())?;
    rx.recv()??;
    let data = buffer.slice(..).get_mapped_range()?;
    let bytes = data.to_vec();
    drop(data);
    buffer.unmap();
    Ok(bytes)
}
impl Filter {
    fn new(device: &Device, sharp: &Texture, target: &Texture, width: u32, height: u32) -> Self {
        let pipeline = pipeline(
            device,
            "shared separable blur",
            include_str!("blur.wgsl"),
            "blur",
        );
        let composite = crate::gpu::pipeline(
            device,
            "protected composite",
            include_str!("composite.wgsl"),
            "composite",
        );
        let textures: Vec<_> = [
            "near-horizontal",
            "near-vertical",
            "far-horizontal",
            "far-vertical",
        ]
        .iter()
        .map(|label| texture(device, width, height, label))
        .collect();
        let views: Vec<_> = textures
            .iter()
            .map(|t| t.create_view(&Default::default()))
            .collect();
        let sharp_view = sharp.create_view(&Default::default());
        let target_view = target.create_view(&Default::default());
        let specs = [
            (&sharp_view, &views[0], [1.0, 0.0, 2.5, 0.0]),
            (&views[0], &views[1], [0.0, 1.0, 2.5, 0.0]),
            (&sharp_view, &views[2], [1.0, 0.0, 6.0, 0.0]),
            (&views[2], &views[3], [0.0, 1.0, 6.0, 0.0]),
        ];
        let groups = specs
            .into_iter()
            .map(|(input, output, values)| {
                let params = uniform(device, "blur parameters", values);
                device.create_bind_group(&BindGroupDescriptor {
                    label: Some("shared blur"),
                    layout: &pipeline.get_bind_group_layout(0),
                    entries: &[
                        view_entry(0, input),
                        view_entry(1, output),
                        BindGroupEntry {
                            binding: 2,
                            resource: params.as_entire_binding(),
                        },
                    ],
                })
            })
            .collect();
        let band = uniform(device, "protected active and next band", [0.0; 4]);
        let composite_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("composite inputs"),
            layout: &composite.get_bind_group_layout(0),
            entries: &[
                view_entry(0, &sharp_view),
                view_entry(1, &views[1]),
                view_entry(2, &views[3]),
                view_entry(3, &target_view),
                BindGroupEntry {
                    binding: 4,
                    resource: band.as_entire_binding(),
                },
            ],
        });
        Self {
            pipeline,
            groups,
            composite,
            composite_group,
            band,
            _textures: textures,
        }
    }
    fn encode(&self, encoder: &mut CommandEncoder, width: u32, height: u32) {
        for group in &self.groups {
            let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor {
                label: Some("shared blur tier/axis"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
        }
        let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor {
            label: Some("protected composite"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&self.composite);
        pass.set_bind_group(0, &self.composite_group, &[]);
        pass.dispatch_workgroups(width.div_ceil(8), height.div_ceil(8), 1);
    }
}
impl Gpu {
    pub async fn new(width: u32, height: u32) -> Result<Self, Error> {
        let instance = Instance::new(InstanceDescriptor {
            backends: Backends::VULKAN,
            ..InstanceDescriptor::new_without_display_handle()
        });
        let adapter = instance
            .request_adapter(&RequestAdapterOptions {
                power_preference: PowerPreference::LowPower,
                force_fallback_adapter: false,
                compatible_surface: None,
                ..Default::default()
            })
            .await?;
        let adapter_name = format!("{:?}", adapter.get_info());
        println!("Adapter: {adapter_name} (Linux host proxy only)");
        let wanted = Features::TIMESTAMP_QUERY | Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
        let timestamp_supported = adapter.features().contains(wanted);
        let (device, queue) = adapter
            .request_device(&DeviceDescriptor {
                label: Some("lyrics-renderer"),
                required_features: if timestamp_supported {
                    wanted
                } else {
                    Features::empty()
                },
                ..Default::default()
            })
            .await?;
        let renderer = Renderer::new(
            &device,
            RendererOptions {
                antialiasing_support: AaSupport::area_only(),
                ..Default::default()
            },
        )?;
        let sharp = texture(&device, width, height, "vello-sharp");
        let target = texture(&device, width, height, "final-composite");
        let filter = Filter::new(&device, &sharp, &target, width, height);
        let timestamps = timestamp_supported.then(|| Timestamps {
            queries: device.create_query_set(&QuerySetDescriptor {
                label: Some("whole frame GPU interval"),
                ty: QueryType::Timestamp,
                count: 2,
            }),
            resolve: device.create_buffer(&BufferDescriptor {
                label: Some("timestamp resolve"),
                size: 16,
                usage: BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            readback: device.create_buffer(&BufferDescriptor {
                label: Some("timestamp readback"),
                size: 16,
                usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
                mapped_at_creation: false,
            }),
        });
        println!(
            "GPU timestamp brackets: {}",
            if timestamp_supported {
                "supported (includes queue gaps across Vello submission)"
            } else {
                "unsupported; CPU/wall only"
            }
        );
        Ok(Self {
            device,
            queue,
            renderer,
            sharp,
            target,
            filter,
            timestamps,
            width,
            height,
            adapter: adapter_name,
        })
    }
    pub fn render(
        &mut self,
        scene: &Scene,
        protection: (f32, f32),
        blur: bool,
    ) -> Result<FrameStats, Error> {
        let start = Instant::now();
        if let Some(ts) = &self.timestamps {
            let mut encoder = self.device.create_command_encoder(&Default::default());
            encoder.write_timestamp(&ts.queries, 0);
            self.queue.submit([encoder.finish()]);
        }
        self.renderer.render_to_texture(
            &self.device,
            &self.queue,
            scene,
            &self.sharp.create_view(&Default::default()),
            &RenderParams {
                base_color: Color::from_rgb8(14, 12, 18),
                width: self.width,
                height: self.height,
                antialiasing_method: AaConfig::Area,
            },
        )?;
        let band: Vec<u8> = [
            protection.0,
            protection.1,
            if blur { 1.0 } else { 0.0 },
            0.0,
        ]
        .into_iter()
        .flat_map(f32::to_le_bytes)
        .collect();
        self.queue.write_buffer(&self.filter.band, 0, &band);
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.filter.encode(&mut encoder, self.width, self.height);
        if let Some(ts) = &self.timestamps {
            encoder.write_timestamp(&ts.queries, 1);
            encoder.resolve_query_set(&ts.queries, 0..2, &ts.resolve, 0);
            encoder.copy_buffer_to_buffer(&ts.resolve, 0, &ts.readback, 0, 16);
        }
        self.queue.submit([encoder.finish()]);
        let cpu_encode_ms = start.elapsed().as_secs_f64() * 1000.0;
        let wait = Instant::now();
        self.device.poll(PollType::wait_indefinitely())?;
        let gpu_interval_ms = if let Some(ts) = &self.timestamps {
            let data = read_buffer(&self.device, &ts.readback)?;
            let a = u64::from_le_bytes(data[..8].try_into()?);
            let b = u64::from_le_bytes(data[8..16].try_into()?);
            b.checked_sub(a)
                .map(|ticks| ticks as f64 * self.queue.get_timestamp_period() as f64 / 1_000_000.0)
        } else {
            None
        };
        Ok(FrameStats {
            cpu_encode_ms,
            wait_readback_ms: wait.elapsed().as_secs_f64() * 1000.0,
            gpu_interval_ms,
        })
    }
    pub fn save(&self, path: &str) -> Result<(), Error> {
        let stride = (self.width * 4).div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&BufferDescriptor {
            label: Some("PNG-readback"),
            size: stride as u64 * self.height as u64,
            usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            TexelCopyTextureInfo {
                texture: &self.target,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            TexelCopyBufferInfo {
                buffer: &buffer,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: None,
                },
            },
            Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);
        let data = read_buffer(&self.device, &buffer)?;
        let pixels: Vec<u8> = data
            .chunks(stride as usize)
            .flat_map(|row| row[..self.width as usize * 4].iter().copied())
            .collect();
        let mut encoder =
            png::Encoder::new(BufWriter::new(File::create(path)?), self.width, self.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header()?.write_image_data(&pixels)?;
        Ok(())
    }
}
