/* global __dirname */
'use strict';
// Audited native-only chain: actual NativeLyricsView hooks/model/layout/cues;
// all native host, clock, packet and ready-signal boundaries mocked explicitly.
const assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm');
const {buildSync}=require('esbuild');
const native=path.resolve(__dirname,'../components/lyrics/native');
function bundle(file,external=[]){return buildSync({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false,external}).outputFiles[0].text;}
function evaluate(code,requireImpl=require){const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,require:requireImpl,console,process});return module.exports;}
const model=evaluate(bundle(path.join(native,'native-lyrics-model.ts')));
const layout=evaluate(bundle(path.resolve(__dirname,'../lib/lyrics-layout.ts')));
const cues=evaluate(bundle(path.join(native,'native-cue-timeline.ts')));
const code=bundle(path.join(native,'native-lyrics-view.tsx'),['*']);
const clone=value=>JSON.parse(JSON.stringify(value));
function harness(style,list){
 let cursor=0,tree,props={style,list,reveal:'canvas',tapToSeekEnabled:false};const slots=[],effects=[],commands=[];
 const slot=make=>{const i=cursor++;return slots[i]??=(make());};
 const same=(a,b)=>a&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
 const react={memo:fn=>fn,
  useRef:value=>slot(()=>({current:value})),
  useState:initial=>{const item=slot(()=>({value:typeof initial==='function'?initial():initial}));return [item.value,next=>{item.value=typeof next==='function'?next(item.value):next;}];},
  useMemo(fn,deps){const item=slot(()=>({}));if(!same(item.deps,deps)){item.deps=deps;item.value=fn();}return item.value;},
  useCallback(fn,deps){return react.useMemo(()=>fn,deps);},
  useEffect(fn,deps){const item=slot(()=>({}));if(!same(item.deps,deps)){item.deps=deps;effects.push(()=>{item.cleanup?.();item.cleanup=fn();});}},
 };
 const state={currentTrack:{id:'track',durationMs:10000},isPlaying:false,lyricsSource:'fixture',lyricsStatusMessage:'',lyricsMetadata:{},
  lyrics:[{lineStartTime:0,lineEndTime:1500,syllables:[{text:'fixture',startTime:0,endTime:1200}]}]};
 const position={value:500},running={value:false},seekVersion={value:0};let measuredY=500;
 const host={getLayout:()=>({y:measuredY}),getFirstItemOffset:()=>150,getAbsoluteLastScrollOffset:()=>0,getFirstVisibleIndex:()=>0,
  scrollToIndex:command=>commands.push(command),scrollToOffset(){}};
 const jsx=(type,props)=>({type,props:props??{}});
 const modules={react,
  'react-native':{AppState:{currentState:'active',addEventListener:()=>({remove(){}})},FlatList:'FlatList',Linking:{openURL(){}},Pressable:'Pressable',StyleSheet:{create:x=>x},Text:'Text',View:'View'},
  'expo-image':{Image:'Image'},'@shopify/flash-list':{FlashList:'FlashList'},
  'react-native-reanimated':{
   useAnimatedReaction(){},
   useDerivedValue:fn=>{const value=react.useMemo(()=>({value:null}),[]);value.value=fn();return value;},
   useSharedValue:initial=>react.useMemo(()=>{let value=initial;return {get value(){return value;},set value(next){value=next;if(next&&typeof next==='object'&&'serial'in next)commands.push(next);}};},[]),
  },
  'react-native-worklets':{scheduleOnRN(){}},
  '../lyrics-packet-transition':{useLyricsPacketTransition:()=>null,withLyricsPacketTransition:component=>component},
  '@/store/playback-store':{usePlaybackStore:Object.assign(selector=>selector(state),{getState:()=>state})},
  '@/lib/lyrics-timing':{detectLyricsTimingMode:()=> 'synced'},'@/lib/lyrics-layout':layout,
  './native-lyrics-model':model,'./native-lyric-row':{NativeLyricRowView:'Row'},
  './use-native-lyrics-clock':{useNativeLyricsClock:()=>({position,running,seekVersion})},
  './native-lyrics-fonts':{NativeLyricsFontContext:{Provider:'FontProvider'},useNativeLyricsFonts:()=>null},
  './reference-scroll':{initialScrollCommand:{serial:0,offset:0,delta:0,index:0,firstVisible:0,interval:800,instant:true,interlude:false,snap:false},ReferenceScrollContext:{Provider:'ScrollProvider'},ReferenceScrollView:'Scroll'},
  './amll-layout-cell':{AmllLayoutCell:'Cell'},'./native-cue-timeline':cues,
  './native-renderer-ready-refresh':{NativeRendererReadyRefreshGate:class{begin(){return 0;}setMounted(){}foreground(){return 0;}onReady(){}},requestNativeRendererReadyResync(){throw Error('unexpected request');}},
  'react/jsx-runtime':{jsx,jsxs:jsx},
 };
 const {NativeLyricsView}=evaluate(code,name=>{assert(Object.hasOwn(modules,name),`Unexpected native dependency ${name}`);return modules[name];});
 function find(node,type){if(!node||typeof node!=='object')return null;if(node.type===type)return node;const children=node.props?.children;for(const child of Array.isArray(children)?children:[children]){const result=find(child,type);if(result)return result;}return null;}
 function render(next={}){props={...props,...next};cursor=0;tree=NativeLyricsView(props);find(tree,list==='flash'?'FlashList':'FlatList').props.ref.current=host;while(effects.length)effects.shift()();return tree;}
 function content(){find(tree,list==='flash'?'FlashList':'FlatList').props.onContentSizeChange();}
 function viewport(width=400){tree.props.onLayout({nativeEvent:{layout:{width,height:800}}});render();}
 render();viewport();content();
 return {state,commands,render,content,viewport,setY:value=>{measuredY=value;},row:()=>find(tree,list==='flash'?'FlashList':'FlatList').props.data[0],drag:()=>find(tree,list==='flash'?'FlashList':'FlatList').props.onScrollBeginDrag()};
}
for(const style of ['amll','spicy'])for(const list of ['flash','flat']){
 const h=harness(style,list),before=h.commands.length,row=h.row();
 h.state.lyrics=clone(h.state.lyrics);h.state.lyrics[0].translatedText='late translation';h.render();h.content();
 assert.equal(h.commands.length,before,`${style}/${list}: late translation must not clear scroll target/reissue follow command`);
 assert.equal(h.row().key,row.key,'translation keeps native list key');assert.equal(h.row().lead.paintWords,row.lead.paintWords);
 if(list==='flash'){
  h.setY(560);h.viewport(460);h.content();
  assert.equal(h.commands.length,before+1,'a later viewport relayout must not remain suppressed by translation-only guard');
 }
 const beforeSource=h.commands.length;
 h.state.lyrics=clone(h.state.lyrics);h.state.lyrics[0].syllables[0].endTime-=27;h.render();h.content();
 assert.equal(h.commands.length,beforeSource+1,'real timing input change retains ordinary source auto-follow reset');
 h.drag();const manual=h.commands.length;
 h.state.lyrics=clone(h.state.lyrics);h.state.lyrics[0].translatedText='updated translation';h.render();h.content();
 assert.equal(h.commands.length,manual,'translation cannot resume manual-disabled auto-follow');
 console.log(`${style}/${list}: real native host hooks preserve translation scroll state, timing changes, geometry retries and manual follow.`);
}
console.log('Native translation scroll checks PASS; mocked list/clock/ready hosts, not measured device layout or animation.');
