use std::{fs::File, io::BufWriter, sync::mpsc};
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene, peniko::Color};
use wgpu::*;
type Error = Box<dyn std::error::Error>;

pub struct Gpu {
    device: Device,
    queue: Queue,
    renderer: Renderer,
    target: Texture,
    width: u32,
    height: u32,
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
        println!("Adapter: {:?} (Linux host proxy only)", adapter.get_info());
        let (device, queue) = adapter
            .request_device(&DeviceDescriptor {
                label: Some("lyrics-renderer"),
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
        let target = device.create_texture(&TextureDescriptor {
            label: Some("vello-sharp"),
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
        });
        Ok(Self {
            device,
            queue,
            renderer,
            target,
            width,
            height,
        })
    }
    pub fn render(&mut self, scene: &Scene, _protection: (f32, f32)) -> Result<(), Error> {
        self.renderer.render_to_texture(
            &self.device,
            &self.queue,
            scene,
            &self.target.create_view(&Default::default()),
            &RenderParams {
                base_color: Color::from_rgb8(14, 12, 18),
                width: self.width,
                height: self.height,
                antialiasing_method: AaConfig::Area,
            },
        )?;
        self.device.poll(PollType::wait_indefinitely())?;
        Ok(())
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
        let (tx, rx) = mpsc::channel();
        buffer.slice(..).map_async(MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        self.device.poll(PollType::wait_indefinitely())?;
        rx.recv()??;
        let data = buffer.slice(..).get_mapped_range()?;
        let pixels: Vec<u8> = data
            .chunks(stride as usize)
            .flat_map(|row| row[..self.width as usize * 4].iter().copied())
            .collect();
        let mut encoder =
            png::Encoder::new(BufWriter::new(File::create(path)?), self.width, self.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header()?.write_image_data(&pixels)?;
        drop(data);
        buffer.unmap();
        Ok(())
    }
}
