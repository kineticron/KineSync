/* Narrow no-dependency host check for machines without the crate toolchain.
 * Compiles production motion, mapping, replacement and frame-preparation code
 * against synthetic scene/font/GPU stand-ins. Does not test shaped pixels or
 * profile hit rectangles. The full crate regression covers those CPU scenes. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'src', name), 'utf8').replaceAll('\r\n', '\n');
function section(source, start, end) {
  const at = source.indexOf(start);
  if (at < 0 || source.indexOf(end, at) < 0) throw new Error('Missing source boundary ' + start);
  return source.slice(at, source.indexOf(end, at));
}
const scene = read('scene.rs'), ffi = read('ffi.rs');
const before = process.argv.includes('--before');
const replacement = before ? `pub(crate) fn replace_track_scroll(scroll:&mut FollowScroll,_:Option<&TrackScene>,next:&mut TrackScene,_:bool,_:bool,_:f64)->Result<(),String> {
  // a02c9f8 kr_set_track configured and reset unconditionally.
  scroll.configure(next.style().unwrap(),f64::from(next.scale),next.lines.len());scroll.reset();Ok(())
}` : section(ffi, 'pub(crate) fn replace_track_scroll(', 'pub(crate) fn resize_track_scroll(');
const source = `#![allow(dead_code)]
use std::time::Instant;
const ACTIVE_RANGE_BOTTOM_PADDING: f64 = 24.0;
mod typography {
  #[derive(Clone, Copy, Debug, PartialEq)] pub enum Style { Spicy, Amll }
  pub struct Settings { pub style: Style, pub landscape: bool }
}
mod style_timing { ${section(read('style_timing.rs'), 'pub fn bezier(', 'pub fn amll_float(')} }
#[path = ${JSON.stringify(path.join(root, 'src/motion.rs').replaceAll('\\', '/'))}] mod motion;
use motion::FollowScroll;
use typography::{Settings,Style};
#[derive(Clone)] struct Line { text: String, start: f64, end: f64, background_end: f64 }
struct CachedLine { height: f64 }
struct Footer { tail: f64, inset: f64 }
${section(scene, '#[derive(Clone, Copy)]\nstruct ManualAnchor', '#[allow(')}
type Error = Box<dyn std::error::Error>;
struct TrackScene { lines: Vec<Line>, prefix: Vec<f64>, cached: Vec<CachedLine>, footer: Option<Footer>,
  height: u32, width: u32, scale: f32, settings: Option<Settings>, manual_anchor: Option<ManualAnchor>,
  measurement: Option<(usize,f64)> }
impl TrackScene {
  fn prepare(&mut self, _:f64)->Result<(),Error> { Ok(()) }
  fn preparation_key(&self,_:f64)->(usize,usize,usize,usize) { (0,0,0,0) }
  fn prepare_viewport(&mut self,_:f64)->Result<(),Error> {
    if let Some((row,height))=self.measurement.take() {
      self.cached[row].height=height;
      let mut top=0.0; for (i,row) in self.cached.iter().enumerate() { self.prefix[i]=top; top+=row.height; }
    } Ok(())
  }
  fn style(&self)->Option<Style> { self.settings.as_ref().map(|s|s.style) }
  fn scroll_target(&self,_:f64)->f64 { self.max_scroll() }
  fn scroll_command(&self,time:f64,_:f64)->motion::Command { motion::Command { offset:self.scroll_target(time),
    style:self.style().unwrap(), interval:5000.0, interlude:true, first_visible:0,index:9,visible:0..10,scale:1.0 } }
  ${section(scene, 'pub(crate) fn scroll_anchor(', '    fn fit_scroll(')}
  ${section(scene, 'pub(crate) fn content_bottom(', '    /// Skia footer target:')}
  ${section(scene, 'fn first_visible(', '    /// Rows that can be drawn near')}
}
struct Timeline { position:f64 }
impl Default for Timeline { fn default()->Self { Self {position:0.0} } }
impl Timeline {
  fn replace(&mut self,_:u64) {}
  fn anchor(&mut self,_:u64,_:u64,p:f64,_:f64,_:f64,_:bool,_:f64)->Result<(),String> {self.position=p;Ok(())}
  fn position(&self,_:f64)->f64 { self.position }
}
${replacement}
${section(ffi, 'pub(crate) fn resize_track_scroll(', '#[unsafe(no_mangle)]')}
${section(ffi, 'struct PreparedDrawable<T>', '/// Returns 0 after present call').replace('#[cfg(test)]', '')}
fn scene(style:Style,height:f64)->TrackScene {
  TrackScene { lines:(0..10).map(|i|Line{text:format!("row {i}"),start:i as f64*5000.0,end:i as f64*5000.0+4600.0,background_end:i as f64*5000.0+4600.0}).collect(),
    prefix:(0..10).map(|i|i as f64*height).collect(),cached:(0..10).map(|_|CachedLine{height}).collect(),
    footer:Some(Footer{tail:180.0,inset:36.0}),height:640,width:390,scale:1.0,
    settings:Some(Settings{style,landscape:false}),manual_anchor:None,measurement:None }
}
fn main() {
  let time=51600.0;
  for following in [true,false] {
    let old=scene(Style::Spicy,140.0); let mut next=scene(Style::Amll,230.0);
    let mut scroll=FollowScroll::default(); scroll.configure(Style::Spicy,1.0,10);
    scroll.sample(&old.scroll_command(time,0.0),1000.0,true);
    scroll.sample(&old.scroll_command(time,0.0),1100.0,following);
    scroll.snap_next();
    replace_track_scroll(&mut scroll,Some(&old),&mut next,true,following,time).unwrap();
    ${before ? '' : 'assert!(scroll.explicit_snap_pending());'}
    scroll.snap_next(); // New-generation JS anchor also carries snap=true.
    for frame in 0..2100 {
      let now=1200.0+frame as f64*1000.0/60.0;
      if following { scroll.sample(&next.scroll_command(time,0.0),now,true); }
      else { manual_frame_for_test(&mut next,&mut scroll,time,now); }
    }
    println!("after35s following={following} offset={} target={}",scroll.position(),next.max_scroll());
    assert_eq!(scroll.position(),next.max_scroll());
    if !following {
      next.measurement=Some((0,900.0));
      manual_frame_for_test(&mut next,&mut scroll,time,37000.0);
      assert_eq!(scroll.position(),next.max_scroll()); assert!(scroll.explicit_snap_pending());
    }
    let footer_y=next.scroll_anchor()+next.content_bottom()+36.0-scroll.position();
    assert!(footer_y>=0.0 && footer_y+112.0<=640.0);
    println!("mapped footer following={following} offset={} footer_y={footer_y}",scroll.position());
  }
  let mut old=scene(Style::Spicy,140.0); let mut next=scene(Style::Amll,230.0);
  let mut scroll=FollowScroll::default(); scroll.configure(Style::Spicy,1.0,10);
  scroll.sample(&old.scroll_command(time,0.0),0.0,true); scroll.drag(315.0-scroll.position(),old.max_scroll(),640.0);
  scroll.snap_next(); replace_track_scroll(&mut scroll,Some(&old),&mut next,true,false,time).unwrap();
  for pass in 0..4 { next.measurement=Some((0,300.0+pass as f64*100.0)); manual_frame_for_test(&mut next,&mut scroll,time,1000.0+pass as f64*16.0); assert_eq!(scroll.position(),next.prefix[2]+0.25*230.0); }
  next.clear_manual_anchor(); assert_eq!(scroll.sample(&next.scroll_command(time,0.0),2000.0,true),next.max_scroll());
  assert!(!scroll.explicit_snap_pending());
  resize_track_scroll(&mut scroll,&next,&mut old,false,time,1.0).unwrap(); old.clear_manual_anchor();
  scroll.drag(315.0-scroll.position(),old.max_scroll(),640.0);
  resize_track_scroll(&mut scroll,&old,&mut next,false,time,1.0).unwrap();
  assert_eq!(manual_frame_for_test(&mut next,&mut scroll,time,3000.0),next.prefix[2]+0.25*230.0);
  next.clear_manual_anchor();
  scroll.drag(-10000.0,next.max_scroll(),640.0);
  let negative=scroll.position(); assert!(negative<0.0);
  assert_eq!(manual_frame_for_test(&mut next,&mut scroll,time,3016.0),negative);
  scroll.fling(-0.5,next.max_scroll(),640.0);
  manual_frame_for_test(&mut next,&mut scroll,time,3032.0); assert!(scroll.position()<0.0);
  replace_track_scroll(&mut scroll,Some(&next),&mut old,false,false,time).unwrap(); assert_eq!(scroll.position(),0.0);
  for changed in [0,1,2] {
    let mut changed_scene=scene(Style::Amll,230.0);
    if changed==0 {changed_scene.lines.pop();} else if changed==1 {changed_scene.lines.swap(0,1);} else {changed_scene.lines[0].text="unrelated".into();}
    replace_track_scroll(&mut scroll,Some(&old),&mut changed_scene,true,false,time).unwrap();assert!(!changed_scene.has_manual_anchor());
  }
  println!("Credits switch narrow host PASS: 35s, geometry correction, pending seek/resume, manual row, rubber band, fling, cached resize and unrelated/new track.");
}
`;
const out = path.join(root, 'target/credits-footer-switch');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'host.rs'), source);
const exe = path.join(out, process.platform === 'win32' ? 'host.exe' : 'host');
execFileSync('rustc', ['--edition', '2021', path.join(out, 'host.rs'), '-o', exe], { stdio: 'inherit' });
execFileSync(exe, [], { stdio: 'inherit' });
