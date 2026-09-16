import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { LyricsView } from '@/components/lyrics/lyrics-view';
import { usePlaybackStore } from '@/store/playback-store';
const samples = [
  {lineStartTime: 1000, lineEndTime: 5600, syllables: [{text:'Shining ',startTime:1000,endTime:3000},{text:'bright',startTime:3000,endTime:5600}], translatedText:'A translated line',backgroundSyllables:[{text:'Echo ',startTime:1800,endTime:3300},{text:'tonight',startTime:3300,endTime:5700}]},
  {lineStartTime: 5900, lineEndTime: 9400, oppositeAligned:true, syllables:[{text:'An ',startTime:5900,endTime:6400},{text:'answering ',startTime:6400,endTime:7200},{text:'voice',startTime:7200,endTime:9400}]},
  {lineStartTime: 9500, lineEndTime: 13000, syllables:[{text:'Together ',startTime:9500,endTime:10500},{text:'in ',startTime:10500,endTime:11000},{text:'the ',startTime:11000,endTime:11500},{text:'light',startTime:11500,endTime:13000}]},
  {lineStartTime: 18000, lineEndTime: 21000, syllables:[{text:'光の中で ',startTime:18000,endTime:19000},{text:'歌う',startTime:19000,endTime:21000}]},
  {lineStartTime: 22000, lineEndTime: 25000, syllables:[{text:'A final ',startTime:22000,endTime:23000},{text:'glow',startTime:23000,endTime:25000}]},
];
export default function NativePreview(){
  const [time,setTime]=useState(4100);const [playing,setPlaying]=useState(false);
  useEffect(()=>{usePlaybackStore.setState({lyrics:samples,lyricsSource:'amll-fixture',lyricsMetadata:{},currentTrack:{id:'amll-preview',title:'Native AMLL',artist:'Fixture',durationMs:30000}})},[]);
  useEffect(()=>{usePlaybackStore.setState({playbackPosition:time,anchorPositionMs:time,anchorMonotonicMs:performance.now(),isPlaying:playing});},[time,playing]);
  useEffect(()=>{if(!playing)return;const anchor=performance.now();const timer=setInterval(()=>usePlaybackStore.setState({playbackPosition:time+performance.now()-anchor}),50);return()=>clearInterval(timer);},[playing,time]);
  return <LinearGradient colors={['#334967','#192333']} style={{flex:1,paddingTop:40}}><Stack.Screen options={{headerShown:false}}/>
    <View style={{flexDirection:'row',padding:12,gap:20}}>{[['Back',()=>setTime(1100)],['Step',()=>setTime(t=>t+700)],['Play',()=>setPlaying(p=>!p)],['Gap',()=>setTime(15500)]].map(([label,action])=><Pressable key={String(label)} onPress={action as ()=>void}><Text style={{color:'white',fontSize:18}}>{String(label)}</Text></Pressable>)}</View>
    <Text style={{color:'white',paddingLeft:12}}>Native AMLL fixture · {time}ms · {playing?'playing':'paused'}</Text>
    <LyricsView active tapToSeekEnabled={false} showTranslatedText onLinePress={line=>setTime(line.lineStartTime)} suppressInitialAutoScrollAnimation />
  </LinearGradient>;
}
