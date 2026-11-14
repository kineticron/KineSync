//! Vello rasterization, shared GPU blur/composition, optional timestamp brackets.
use serde::Serialize;
use std::{
    fs::File,
    io::BufWriter,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Instant,
};
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
    downsample: ComputePipeline,
    downsample_group: BindGroup,
    extent: (u32, u32),
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
    adapter_handle: Adapter,
    queue: Queue,
    renderer: Renderer,
    sharp: Texture,
    target: Texture,
    filter: Filter,
    timestamps: Option<Timestamps>,
    width: u32,
    height: u32,
    scale: f32,
    error: Arc<Mutex<Option<String>>>,
    pub adapter: String,
    pub capabilities: u32,
}

fn texture(device: &Device, width: u32, height: u32, label: &str) -> Texture {
    texture_format(device, width, height, label, TextureFormat::Rgba8Unorm)
}
fn texture_format(
    device: &Device,
    width: u32,
    height: u32,
    label: &str,
    format: TextureFormat,
) -> Texture {
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
        format,
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
    fn new(
        device: &Device,
        sharp: &Texture,
        target: &Texture,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Self {
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
        let downsample = crate::gpu::pipeline(
            device,
            "linear premultiplied box downsample",
            include_str!("downsample.wgsl"),
            "downsample",
        );
        let extent = (width.div_ceil(2), height.div_ceil(2));
        let textures: Vec<_> = [
            "half-linear-premultiplied",
            "near-horizontal",
            "near-vertical",
            "far-horizontal",
            "far-vertical",
        ]
        .iter()
        .map(|label| {
            texture_format(
                device,
                extent.0,
                extent.1,
                label,
                TextureFormat::Rgba16Float,
            )
        })
        .collect();
        let views: Vec<_> = textures
            .iter()
            .map(|t| t.create_view(&Default::default()))
            .collect();
        let sharp_view = sharp.create_view(&Default::default());
        let target_view = target.create_view(&Default::default());
        let downsample_group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("downsample inputs"),
            layout: &downsample.get_bind_group_layout(0),
            entries: &[view_entry(0, &sharp_view), view_entry(1, &views[0])],
        });
        let specs = [
            (&views[0], &views[1], [1.0, 0.0, 1.25 * scale, 0.0]),
            (&views[1], &views[2], [0.0, 1.0, 1.25 * scale, 0.0]),
            (&views[0], &views[3], [1.0, 0.0, 3.0 * scale, 0.0]),
            (&views[3], &views[4], [0.0, 1.0, 3.0 * scale, 0.0]),
        ];
        let groups = specs
            .into_iter()
            .map(|(input, output, values)| {
                // Gaussian weights are invariant until resize, not exp() per GPU sample.
                let radius = (values[2] * 3.0).ceil() as usize;
                let mut weights = [0.0f32; 40];
                for (i, weight) in weights.iter_mut().enumerate().take(radius + 1) {
                    *weight = (-((i * i) as f32) / (2.0 * values[2] * values[2])).exp();
                }
                let total = weights[0] + 2.0 * weights[1..=radius].iter().sum::<f32>();
                let mut data: Vec<u8> = values.into_iter().flat_map(f32::to_le_bytes).collect();
                for weight in weights {
                    for value in [weight / total, 0.0, 0.0, 0.0] {
                        data.extend(value.to_le_bytes());
                    }
                }
                let params = device.create_buffer_init(&util::BufferInitDescriptor {
                    label: Some("cached normalized Gaussian weights"),
                    contents: &data,
                    usage: BufferUsages::UNIFORM,
                });
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
                view_entry(1, &views[2]),
                view_entry(2, &views[4]),
                view_entry(3, &target_view),
                BindGroupEntry {
                    binding: 4,
                    resource: band.as_entire_binding(),
                },
            ],
        });
        Self {
            downsample,
            downsample_group,
            extent,
            pipeline,
            groups,
            composite,
            composite_group,
            band,
            _textures: textures,
        }
    }
    fn encode(&self, encoder: &mut CommandEncoder, width: u32, height: u32) {
        {
            let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor {
                label: Some("half-resolution box"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.downsample);
            pass.set_bind_group(0, &self.downsample_group, &[]);
            pass.dispatch_workgroups(self.extent.0.div_ceil(8), self.extent.1.div_ceil(8), 1);
        }
        for group in &self.groups {
            let mut pass = encoder.begin_compute_pass(&ComputePassDescriptor {
                label: Some("shared blur tier/axis"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(self.extent.0.div_ceil(8), self.extent.1.div_ceil(8), 1);
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
        Self::new_scaled(width, height, 1.0).await
    }
    pub async fn new_scaled(width: u32, height: u32, scale: f32) -> Result<Self, Error> {
        if width == 0
            || height == 0
            || width > 8192
            || height > 8192
            || !scale.is_finite()
            || !(0.5..=4.0).contains(&scale)
        {
            return Err("Invalid offscreen extent/scale".into());
        }
        let instance = Instance::new(InstanceDescriptor {
            backends: Backends::VULKAN,
            ..InstanceDescriptor::new_without_display_handle()
        });
        Self::create(&instance, None, width, height, scale).await
    }
    async fn create(
        instance: &Instance,
        surface: Option<&Surface<'_>>,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<Self, Error> {
        let adapter = instance
            .request_adapter(&RequestAdapterOptions {
                power_preference: PowerPreference::LowPower,
                force_fallback_adapter: false,
                compatible_surface: surface,
                ..Default::default()
            })
            .await?;
        let adapter_name = format!("{:?}", adapter.get_info());
        println!("Adapter: {adapter_name}");
        let wanted = Features::TIMESTAMP_QUERY | Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
        let timestamp_supported = adapter.features().contains(wanted);
        // GPU Vello, compute blur, adapter timestamp, adapter encoder timestamp,
        // enabled bracket features. Rendering never depends on timestamp queries.
        let capabilities =
            3 | if adapter.features().contains(Features::TIMESTAMP_QUERY) {
                4
            } else {
                0
            } | if adapter
                .features()
                .contains(Features::TIMESTAMP_QUERY_INSIDE_ENCODERS)
            {
                8
            } else {
                0
            } | if timestamp_supported { 16 } else { 0 };
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
        let error = Arc::new(Mutex::new(None));
        let errors = error.clone();
        device.on_uncaptured_error(Arc::new(move |message| {
            *errors.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(format!("GPU error: {message}"));
        }));
        let errors = error.clone();
        device.set_device_lost_callback(move |reason, message| {
            *errors.lock().unwrap_or_else(|e| e.into_inner()) =
                Some(format!("GPU device lost: {reason:?}: {message}"));
        });
        let renderer = Renderer::new(
            &device,
            RendererOptions {
                antialiasing_support: AaSupport::area_only(),
                ..Default::default()
            },
        )?;
        let sharp = texture(&device, width, height, "vello-sharp");
        let target = texture(&device, width, height, "final-composite");
        let filter = Filter::new(&device, &sharp, &target, width, height, scale);
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
            adapter_handle: adapter,
            queue,
            renderer,
            sharp,
            target,
            filter,
            timestamps,
            width,
            height,
            scale,
            error,
            adapter: adapter_name,
            capabilities,
        })
    }
    pub fn render(
        &mut self,
        scene: &Scene,
        protection: (f32, f32),
        blur: bool,
    ) -> Result<FrameStats, Error> {
        self.render_frame(scene, protection, blur, true)
    }
    fn render_frame(
        &mut self,
        scene: &Scene,
        protection: (f32, f32),
        blur: bool,
        profile: bool,
    ) -> Result<FrameStats, Error> {
        self.check_error()?;
        let start = Instant::now();
        let timestamps = self.timestamps.as_ref().filter(|_| profile);
        if let Some(ts) = timestamps {
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
                base_color: Color::TRANSPARENT,
                width: self.width,
                height: self.height,
                antialiasing_method: AaConfig::Area,
            },
        )?;
        let band: Vec<u8> = [
            protection.0,
            protection.1,
            if blur { 1.0 } else { 0.0 },
            self.scale,
        ]
        .into_iter()
        .flat_map(f32::to_le_bytes)
        .collect();
        self.queue.write_buffer(&self.filter.band, 0, &band);
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.filter.encode(&mut encoder, self.width, self.height);
        if let Some(ts) = timestamps {
            encoder.write_timestamp(&ts.queries, 1);
            encoder.resolve_query_set(&ts.queries, 0..2, &ts.resolve, 0);
            encoder.copy_buffer_to_buffer(&ts.resolve, 0, &ts.readback, 0, 16);
        }
        self.queue.submit([encoder.finish()]);
        let cpu_encode_ms = start.elapsed().as_secs_f64() * 1000.0;
        let wait = Instant::now();
        if profile {
            self.device.poll(PollType::wait_indefinitely())?;
        }
        let gpu_interval_ms = if let Some(ts) = timestamps {
            let data = read_buffer(&self.device, &ts.readback)?;
            let a = u64::from_le_bytes(data[..8].try_into()?);
            let b = u64::from_le_bytes(data[8..16].try_into()?);
            b.checked_sub(a)
                .map(|ticks| ticks as f64 * self.queue.get_timestamp_period() as f64 / 1_000_000.0)
        } else {
            None
        };
        self.check_error()?;
        Ok(FrameStats {
            cpu_encode_ms,
            wait_readback_ms: wait.elapsed().as_secs_f64() * 1000.0,
            gpu_interval_ms,
        })
    }
    fn check_error(&self) -> Result<(), Error> {
        if let Some(message) = self
            .error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            return Err(message.clone().into());
        }
        Ok(())
    }
    /// Linear premultiplied RGBA8 pixels from the actual final compute texture.
    pub fn read_pixels(&self) -> Result<Vec<u8>, Error> {
        self.read_texture(&self.target)
    }
    /// Exercises the exact phone surface-copy shader into an offscreen unorm target.
    pub fn surface_pixels(&self) -> Result<Vec<u8>, Error> {
        let output = self.device.create_texture(&TextureDescriptor {
            label: Some("surface shader readback proof"),
            size: self.target.size(),
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: TextureFormat::Rgba8Unorm,
            usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let blit = SurfaceBlit::new(&self.device, TextureFormat::Rgba8Unorm);
        let mut encoder = self.device.create_command_encoder(&Default::default());
        blit.copy(
            &self.device,
            &mut encoder,
            &self.target.create_view(&Default::default()),
            &output.create_view(&Default::default()),
        );
        self.queue.submit([encoder.finish()]);
        self.read_texture(&output)
    }
    fn read_texture(&self, texture: &Texture) -> Result<Vec<u8>, Error> {
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
                texture,
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
        Ok(pixels)
    }
    pub fn save(&self, path: &str) -> Result<(), Error> {
        // PNG expects straight sRGB. Internal readback remains linear premultiplied.
        let mut pixels = self.read_pixels()?;
        for p in pixels.chunks_exact_mut(4) {
            let alpha = f32::from(p[3]) / 255.0;
            for c in &mut p[..3] {
                *c = (linear_to_srgb(if alpha > 0.0 {
                    f32::from(*c) / 255.0 / alpha
                } else {
                    0.0
                }) * 255.0)
                    .round() as u8;
            }
        }
        let mut encoder =
            png::Encoder::new(BufWriter::new(File::create(path)?), self.width, self.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header()?.write_image_data(&pixels)?;
        Ok(())
    }
}

fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// A retained platform surface. Caller keeps its platform layer alive through Drop.
pub struct SurfaceRenderer {
    surface: Surface<'static>,
    gpu: Gpu,
    config: SurfaceConfiguration,
    blitter: SurfaceBlit,
    pub timing: SurfaceTiming,
    flight: Flight,
    _instance: Instance,
}
impl SurfaceRenderer {
    pub fn capabilities(&self) -> u32 {
        self.gpu.capabilities
    }
    pub async fn new(
        instance: Instance,
        surface: Surface<'static>,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<Self, Error> {
        let gpu = Gpu::create(&instance, Some(&surface), width, height, scale).await?;
        let mut config = surface
            .get_default_config(&gpu.adapter_handle, width, height)
            .ok_or("No supported surface configuration")?;
        config.present_mode = PresentMode::Fifo;
        // Metal advertises PostMultiplied, not PreMultiplied. Match its contract
        // at the surface boundary; all filter intermediates are premultiplied.
        let caps = surface.get_capabilities(&gpu.adapter_handle);
        if !caps
            .alpha_modes
            .contains(&CompositeAlphaMode::PostMultiplied)
        {
            return Err("Surface lacks supported transparent PostMultiplied alpha".into());
        }
        config.alpha_mode = CompositeAlphaMode::PostMultiplied;
        config.format = caps
            .formats
            .iter()
            .copied()
            .find(|f| matches!(f, TextureFormat::Bgra8Unorm | TextureFormat::Rgba8Unorm))
            .ok_or("Surface lacks unorm sRGB-encoded transparent output format")?;
        // Three OS drawables, at most two submitted application frames.
        config.desired_maximum_frame_latency = 2;
        surface.configure(&gpu.device, &config);
        let blitter = SurfaceBlit::new(&gpu.device, config.format);
        Ok(Self {
            surface,
            gpu,
            config,
            blitter,
            timing: SurfaceTiming::default(),
            flight: Flight::default(),
            _instance: instance,
        })
    }
    pub fn resize(&mut self, width: u32, height: u32, scale: f32) -> Result<(), Error> {
        self.gpu.device.poll(PollType::wait_indefinitely())?;
        self.gpu.width = width;
        self.gpu.height = height;
        self.gpu.scale = scale;
        self.gpu.sharp = texture(&self.gpu.device, width, height, "resized-sharp");
        self.gpu.target = texture(&self.gpu.device, width, height, "resized-composite");
        self.gpu.filter = Filter::new(
            &self.gpu.device,
            &self.gpu.sharp,
            &self.gpu.target,
            width,
            height,
            scale,
        );
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.gpu.device, &self.config);
        Ok(())
    }
    /// Poll callbacks without waiting. A denied slot never queues a target or
    /// modifies animation state; the next display callback supplies fresh time.
    pub fn ready(&mut self) -> Result<bool, Error> {
        let start = Instant::now();
        self.gpu.device.poll(PollType::Poll)?;
        self.timing.poll_ms = start.elapsed().as_secs_f64() * 1000.0;
        self.gpu.check_error()?;
        Ok(self.flight.ready())
    }
    pub fn completed(&self) -> u64 {
        self.flight.completed()
    }
    pub fn outstanding(&self) -> u64 {
        self.flight.submitted - self.flight.completed()
    }
    /// Acquire before sampling animation. This may block in nextDrawable,
    /// but only the worker; the caller refreshes its clock after acquisition.
    pub fn acquire(&mut self) -> Result<Option<SurfaceTexture>, Error> {
        assert!(
            self.flight.ready(),
            "caller must reserve capacity before scene sampling"
        );
        let acquire_start = Instant::now();
        let acquired = self.surface.get_current_texture();
        self.timing.acquire_ms = acquire_start.elapsed().as_secs_f64() * 1000.0;
        let frame = match acquired {
            CurrentSurfaceTexture::Success(frame) | CurrentSurfaceTexture::Suboptimal(frame) => {
                frame
            }
            CurrentSurfaceTexture::Timeout | CurrentSurfaceTexture::Occluded => return Ok(None),
            CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.gpu.device, &self.config);
                return Ok(None);
            }
            other => {
                return Err(format!(
                    "Surface unavailable: {other:?}; remount renderer to recreate device/surface"
                )
                .into());
            }
        };
        Ok(Some(frame))
    }
    pub fn render(
        &mut self,
        scene: &Scene,
        band: (f32, f32),
        frame: SurfaceTexture,
    ) -> Result<(FrameStats, f64), Error> {
        // All shared texture accesses and Vello pool reuse are ordered on one
        // queue. wgpu retains submitted resources. No GPU wait in live render.
        let stats = self.gpu.render_frame(scene, band, true, false)?;
        let start = Instant::now();
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        self.blitter.copy(
            &self.gpu.device,
            &mut encoder,
            &self.gpu.target.create_view(&Default::default()),
            &frame.texture.create_view(&Default::default()),
        );
        let commands = encoder.finish();
        let submit_start = Instant::now();
        self.gpu.queue.submit([commands]);
        self.timing.submit_ms = submit_start.elapsed().as_secs_f64() * 1000.0;
        let (id, completed) = self.flight.submit();
        self.gpu.queue.on_submitted_work_done(move || {
            completed.fetch_max(id, Ordering::Release);
        });
        let present_start = Instant::now();
        self.gpu.queue.present(frame);
        self.timing.present_call_ms = present_start.elapsed().as_secs_f64() * 1000.0;
        self.gpu.check_error()?;
        Ok((stats, start.elapsed().as_secs_f64() * 1000.0))
    }
}
impl Drop for SurfaceRenderer {
    fn drop(&mut self) {
        let _ = self.gpu.device.poll(PollType::wait_indefinitely());
    }
}

/// Blit completion is GPU work completion, never drawable presentation/scanout.
#[derive(Default)]
struct Flight {
    submitted: u64,
    completed: Arc<AtomicU64>,
}
impl Flight {
    fn completed(&self) -> u64 {
        self.completed.load(Ordering::Acquire)
    }
    fn ready(&self) -> bool {
        self.submitted - self.completed() < 2
    }
    fn submit(&mut self) -> (u64, Arc<AtomicU64>) {
        assert!(self.ready());
        self.submitted += 1;
        (self.submitted, self.completed.clone())
    }
}
#[derive(Default)]
pub struct SurfaceTiming {
    pub acquire_ms: f64,
    pub submit_ms: f64,
    pub poll_ms: f64,
    pub present_call_ms: f64,
}
struct SurfaceBlit {
    pipeline: RenderPipeline,
    layout: BindGroupLayout,
}
impl SurfaceBlit {
    fn new(device: &Device, format: TextureFormat) -> Self {
        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("linear premultiplied to straight sRGB surface"),
            source: ShaderSource::Wgsl(include_str!("surface.wgsl").into()),
        });
        let pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: Some("transparent surface copy"),
            layout: None,
            vertex: VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(ColorTargetState {
                    format,
                    blend: None,
                    write_mask: ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let layout = pipeline.get_bind_group_layout(0);
        Self { pipeline, layout }
    }
    fn copy(
        &self,
        device: &Device,
        encoder: &mut CommandEncoder,
        input: &TextureView,
        output: &TextureView,
    ) {
        let group = device.create_bind_group(&BindGroupDescriptor {
            label: Some("surface copy"),
            layout: &self.layout,
            entries: &[view_entry(0, input)],
        });
        let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
            label: Some("straight sRGB copy, no blending"),
            color_attachments: &[Some(RenderPassColorAttachment {
                view: output,
                resolve_target: None,
                depth_slice: None,
                ops: Operations {
                    load: LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
}
#[cfg(test)]
mod ownership_tests {
    use super::*;
    #[test]
    #[ignore = "requires a working Vulkan adapter; run explicitly for host proxy proof"]
    fn real_gpu_two_frames_keep_texture_and_buffer_ownership_ordered() {
        use vello::{
            kurbo::{Affine, Rect},
            peniko::Fill,
        };
        let mut gpu = pollster::block_on(Gpu::new(64, 64)).unwrap();
        let mut flight = Flight::default();
        let mut outputs = Vec::new();
        for color in [
            Color::from_rgba8(255, 0, 0, 128),
            Color::from_rgba8(0, 255, 0, 192),
        ] {
            assert!(flight.ready());
            let mut scene = Scene::new();
            scene.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                color,
                None,
                &Rect::new(8.0, 8.0, 56.0, 56.0),
            );
            gpu.render_frame(&scene, (0.0, 64.0), true, false).unwrap();
            // Preserve each frame with the exact production copy shader before
            // the following Vello render reuses shared textures/buffer pools.
            let output = gpu.device.create_texture(&TextureDescriptor {
                label: Some("two frame ownership proof"),
                size: gpu.target.size(),
                mip_level_count: 1,
                sample_count: 1,
                dimension: TextureDimension::D2,
                format: TextureFormat::Rgba8Unorm,
                usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let mut encoder = gpu.device.create_command_encoder(&Default::default());
            SurfaceBlit::new(&gpu.device, TextureFormat::Rgba8Unorm).copy(
                &gpu.device,
                &mut encoder,
                &gpu.target.create_view(&Default::default()),
                &output.create_view(&Default::default()),
            );
            gpu.queue.submit([encoder.finish()]);
            let (id, done) = flight.submit();
            gpu.queue.on_submitted_work_done(move || {
                done.fetch_max(id, Ordering::Release);
            });
            assert!(flight.submitted - flight.completed() <= 2);
            outputs.push(output);
        }
        gpu.device.poll(PollType::wait_indefinitely()).unwrap();
        assert_eq!(flight.completed(), 2);
        let first = gpu.read_texture(&outputs[0]).unwrap();
        let second = gpu.read_texture(&outputs[1]).unwrap();
        let offset = (32 * 64 + 32) * 4;
        assert_eq!(&first[offset..offset + 4], &[255, 0, 0, 128]);
        assert_eq!(&second[offset..offset + 4], &[0, 255, 0, 192]);
        gpu.check_error().unwrap();
    }
    #[test]
    fn burst_capacity_drops_opportunities_without_backlog() {
        let mut flight = Flight::default();
        let mut busy = 0;
        let mut accepted = Vec::new();
        for tick in 0..10000 {
            // Deterministic artificial completion, not a GPU speed model.
            if tick % 7 == 0 {
                flight.completed.store(flight.submitted, Ordering::Release);
            }
            if flight.ready() {
                flight.submit();
                accepted.push(tick);
            } else {
                busy += 1;
            }
            assert!(flight.submitted - flight.completed() <= 2);
        }
        assert_eq!(accepted.len() as u64, flight.submitted);
        assert_eq!(accepted.len() + busy, 10000);
        assert!(accepted.windows(2).all(|t| t[1] > t[0]));
        assert!(busy > 5000);
    }
    #[test]
    fn bounded_completion_ownership_and_retirement() {
        let mut flight = Flight::default();
        let (a, done) = flight.submit();
        let (b, _) = flight.submit();
        assert!(!flight.ready());
        assert_eq!(flight.submitted - flight.completed(), 2);
        done.fetch_max(a, Ordering::Release);
        assert!(flight.ready());
        let (c, _) = flight.submit();
        assert!(!flight.ready());
        done.fetch_max(c, Ordering::Release);
        done.fetch_max(b, Ordering::Release);
        assert_eq!(flight.completed(), 3);
        assert!(flight.ready());
        // callback ownership is independent of owner/resize destruction.
        drop(flight);
        done.fetch_max(c, Ordering::Release);
    }
}
