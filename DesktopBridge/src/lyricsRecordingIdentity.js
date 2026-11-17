"use strict";

// Recording identity for provider candidates. Equal authoritative catalog IDs
// decide first. Text and duration are only a fallback for sources without an
// ISRC or Spotify track ID.

// General Traditional to Simplified folds for common catalog glyphs. Pair
// string keeps the table compact while covering titles and artist names that
// these providers transliterate or convert independently.
const SIMPLIFIED_PAIRS = [
  "來来財财攬揽與与為为這这說说話话時时間间會会對对於于國国學学愛爱見见聽听覺觉讓让從从東东馬马鳥鸟魚鱼龍龙龜龟門门問问開开關关聞闻個个們们後后裡里裏里麼么樣样種种點点電电車车輪轮轉转過过還还進进遠远邊边連连運运達达選选錯错錢钱銀银鐵铁鋼钢長长張张廣广廠厂場场陽阳陰阴陸陆隊队階阶際际隨随險险難难雙双雲云靈灵靜静響响頁页頂顶順顺須须頭头題题顏颜願愿類类風风飛飞飯饭飲饮飽饱館馆驗验體体髮发鬥斗鬧闹麗丽黃黄齊齐齒齿亞亚產产親亲億亿僅仅倉仓儀仪價价眾众優优夥伙傘伞偉伟傳传傷伤倫伦偽伪佈布佔占併并俠侠侶侣偵侦側侧僑侨僕仆兒儿兌兑黨党蘭兰興兴養养獸兽內内岡冈冊册寫写軍军農农馮冯衝冲決决況况凍冻淨净涼凉減减湊凑準准劉刘則则剛刚創创刪删別别劍剑劇剧勸劝辦办務务動动勵励勁劲勞劳勢势勳勋勻匀匯汇區区醫医華华協协單单賣卖盧卢衛卫卻却廳厅曆历歷历厲厉壓压厭厌廁厕廚厨廂厢縣县參参叢丛發发變变敘叙葉叶號号嘆叹嗎吗噸吨啟启吳吴員员嗚呜嘗尝喚唤喪丧喬乔喲哟噴喷嚇吓啞哑嘩哗嗆呛團团園园圍围圖图圓圆聖圣",
  "壞坏塊块堅坚壇坛墳坟墜坠壘垒墾垦堯尧報报塢坞塵尘墊垫牆墙壯壮聲声殼壳壺壶處处備备復复夠够誇夸夾夹奪夺奮奋獎奖奧奥妝妆婦妇媽妈嬰婴嬌娇孫孙寧宁實实寵宠審审憲宪宮宫寬宽賓宾寢寝尋寻導导壽寿將将爾尔層层屆届屬属屢屡島岛嶺岭嶼屿峽峡巒峦幣币帥帅師师帳帐帶带幫帮並并莊庄慶庆廬庐庫库應应廟庙廢废異异棄弃彌弥彎弯彈弹強强歸归當当錄录彙汇徹彻徑径徵征憶忆憂忧懷怀態态憐怜總总戀恋懇恳惡恶惱恼慣惯慮虑憑凭憊惫懶懒懸悬懼惧戲戏戰战戶户撲扑執执擴扩掃扫揚扬擾扰撫抚拋抛搶抢摻掺撈捞撐撑撥拨撓挠擋挡撣掸擁拥擇择掛挂摯挚攏拢揀拣換换據据擄掳擰拧擊击擔担擠挤擬拟擯摈擱搁擲掷擺摆攆撵攔拦攙搀攜携攝摄攢攒攣挛攤摊攪搅敗败敵敌數数斂敛斃毙斕斓斬斩斷断無无舊旧曠旷曇昙晝昼顯显晉晋曬晒曉晓暈晕暉晖暫暂曖暧術术機机殺杀雜杂權权條条楊杨極极構构樞枢標标棧栈樓楼欒栾櫥橱櫓橹櫚榈櫛栉櫝椟櫞橼櫟栎欄栏樹树樺桦橋桥橫横檢检檸柠檳槟檯台檻槛櫃柜櫻樱欽钦歡欢歐欧殲歼殘残殞殒殤殇殮殓殯殡毆殴毀毁氣气氫氢氬氩氳氲沒没沖冲洶汹浹浃淚泪潔洁灑洒淺浅漿浆澆浇濁浊測测濟济瀏浏渾浑濃浓濤涛澀涩澗涧潰溃漲涨澱淀淵渊渦涡渙涣湯汤溝沟滅灭滌涤潤润濕湿濘泞濛蒙濫滥濰潍濱滨濺溅濾滤瀅滢瀆渎瀉泻瀋沈瀕濒瀘泸瀝沥瀟潇瀠潆瀦潴瀧泷瀨濑瀰弥瀲潋灃沣灄滠灕漓灘滩灝灏灣湾灤滦灩滟災灾烏乌煉炼煙烟煩烦熱热煥焕燈灯燒烧燁烨營营燦灿燉炖燙烫燜焖燭烛燴烩燼烬燾焘爐炉爛烂爭争爺爷牘牍牽牵犧牺犢犊狀状狹狭狽狈猙狰猶犹猻狲獄狱獅狮獨独獲获獵猎獻献獼猕現现瑪玛瑋玮環环璽玺瓏珑瓔璎瓚瓒甌瓯畢毕畫画疇畴疊叠",
].join("");
const SIMPLIFIED_VARIANTS = Object.create(null);
for (let index = 0; index < SIMPLIFIED_PAIRS.length; index += 2) {
  SIMPLIFIED_VARIANTS[SIMPLIFIED_PAIRS[index]] = SIMPLIFIED_PAIRS[index + 1];
}

const VERSION_HINT_PATTERN = /\b(?:live|concert|remix|mix|acoustic|instrumental|karaoke|inst|demo|mono|extended|long version|sped up|slowed|remaster(?:ed)?|version|ver|edit|radio edit|cover|tv size|short ver)\b/i;
const FEATURING_PATTERN = /(?:^|[\s([{,/-])(?:feat\.?|ft\.?|featuring)\s+.+$/i;

function foldCatalogText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\p{Script=Han}/gu, char => SIMPLIFIED_VARIANTS[char] || char)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function bracketInner(segment) {
  return String(segment || "").replace(/^[([{]+|[)\]}]+$/g, "").trim();
}

function removeNoiseBrackets(value) {
  return String(value || "").replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, segment => {
    const inner = bracketInner(segment);
    if (!inner) return " ";
    if (VERSION_HINT_PATTERN.test(inner) && !FEATURING_PATTERN.test(inner)) {
      return ` ${inner} `;
    }
    return " ";
  });
}

/** Drop a trailing feat./ft. clause. Featured artists are not part of the work title. */
function stripFeaturing(value) {
  return String(value || "")
    .replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring)\b[^)\]]*[)\]]/gi, " ")
    .replace(/\s*[-–—]\s*(?:feat\.?|ft\.?|featuring)\b.*$/i, " ")
    .replace(FEATURING_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function translatedTitleBase(value) {
  const title = String(value || "").normalize("NFKC").trim();
  const match = title.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (!match || !/\p{Script=Han}/u.test(match[1])) return title;
  const inner = match[2].trim();
  if (VERSION_HINT_PATTERN.test(inner) || FEATURING_PATTERN.test(inner)) return title;
  // A bare artist name in brackets remains significant. Translation-style
  // Latin suffixes are the common cross-catalog alias.
  const latin = /^[a-z][a-z\s'’.,!?-]+$/i.test(inner);
  const words = inner.split(/\s+/).filter(Boolean);
  return latin && (words.length >= 2 || /\b(?:from|of|the|to|in|on|and|pinyin|romanized|romaji|translation|english)\b/i.test(inner))
    ? match[1].trim()
    : title;
}

function titleKey(value) {
  const base = stripFeaturing(removeNoiseBrackets(translatedTitleBase(value)));
  return foldCatalogText(base).replace(/[\s\p{P}]/gu, "");
}

function versionKey(value) {
  const folded = foldCatalogText(value);
  const hints = new Set();
  for (const match of folded.matchAll(/\b(?:19|20)\d{2}\b|\b(?:live|concert|remix|mix|acoustic|instrumental|karaoke|inst|demo|mono|extended|long version|sped up|slowed|remaster(?:ed)?|version|ver|edit|radio edit|cover|tv size|short ver)\b/gi)) {
    hints.add(match[0].replace(/remastered/i, "remaster"));
  }
  return [...hints].sort().join("|");
}

function normalizeIsrc(value) {
  const isrc = String(value || "").replace(/[-\s]/g, "").toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : "";
}

function normalizeSpotifyTrackId(value) {
  const id = String(value || "").trim().replace(/^spotify:track:/i, "");
  return /^[A-Za-z0-9]{22}$/.test(id) ? id : "";
}

function candidateIdentity(candidate) {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
  const origin = metadata.fetchOrigin && typeof metadata.fetchOrigin === "object" ? metadata.fetchOrigin : {};
  const external = source.external_ids && typeof source.external_ids === "object" ? source.external_ids : {};
  return {
    isrc: normalizeIsrc(
      source.isrc || source.trackIsrc || source.track_isrc || external.isrc ||
      origin.isrc || metadata.isrc ||
      (Array.isArray(source.track_isrcs) ? source.track_isrcs[0] : ""),
    ),
    spotifyTrackId: normalizeSpotifyTrackId(
      source.spotifyTrackId || source.spotify_track_id || source.spotifyId ||
      origin.spotifyTrackId || metadata.spotifyTrackId,
    ),
  };
}

/** true for equal authoritative IDs, false for a conflict, null for text fallback. */
function compareAuthoritativeIdentity(track, candidate) {
  const wanted = candidateIdentity(track);
  const actual = candidateIdentity(candidate);
  let matched = false;
  let compared = false;
  if (wanted.isrc && actual.isrc) {
    compared = true;
    if (wanted.isrc !== actual.isrc) return false;
    matched = true;
  }
  if (wanted.spotifyTrackId && actual.spotifyTrackId) {
    compared = true;
    if (wanted.spotifyTrackId !== actual.spotifyTrackId) return false;
    matched = true;
  }
  if (matched) return true;
  return compared ? false : null;
}

function authoritativeIdentityMatch(track, candidate) {
  return compareAuthoritativeIdentity(track, candidate) === true;
}

function artistAliases(value) {
  const folded = foldCatalogText(value)
    .replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring)\b[^)\]]*[)\]]/gi, " ")
    .replace(FEATURING_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  const aliases = new Set([folded]);
  // Catalogs often join a CJK stage prefix to a Latin alias without a space:
  // "攬佬SKAI ISYOURGOD" versus "SKAI ISYOURGOD".
  const bilingual = folded.match(/^([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)\s*(.+)$/u);
  if (bilingual && /[a-z]/i.test(bilingual[2])) {
    aliases.add(bilingual[1]);
    aliases.add(bilingual[2].trim());
  }
  return aliases;
}

function artistTokens(value) {
  return foldCatalogText(value)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(token => token.length >= 2);
}

function artistIdentityMatches(trackArtist, candidateArtist) {
  const wanted = artistAliases(trackArtist);
  const actual = artistAliases(candidateArtist);
  for (const left of wanted) {
    for (const right of actual) {
      if (!left || !right) continue;
      if (left === right) return true;
      const leftTokens = artistTokens(left);
      const rightTokens = artistTokens(right);
      if (!leftTokens.length || !rightTokens.length) continue;
      const shared = leftTokens.filter(token => rightTokens.includes(token));
      if (!shared.length) continue;
      const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
      const subset = shared.length === shorter.length;
      const sharedIsDistinctive = shared.some(token => token.length >= 3 || /\p{Script=Han}/u.test(token));
      if (subset && sharedIsDistinctive) return true;
      if (shared.length >= 2 && shared.length / Math.max(leftTokens.length, rightTokens.length) >= 0.6) return true;
    }
  }
  return false;
}

function durationIdentityMatches(trackDurationMs, candidateDurationMs, toleranceMs = 3000) {
  const wanted = Number(trackDurationMs);
  const actual = Number(candidateDurationMs);
  return wanted > 0 && Number.isFinite(wanted) && actual > 0 && Number.isFinite(actual) &&
    Math.abs(wanted - actual) <= toleranceMs;
}

function recordingIdentityMatches(track, titleOrCandidate, artist, durationMs, identity = {}) {
  const candidate = titleOrCandidate && typeof titleOrCandidate === "object"
    ? titleOrCandidate
    : { ...identity, title: titleOrCandidate, artist, durationMs };
  const authoritative = compareAuthoritativeIdentity(track, candidate);
  if (authoritative !== null) return authoritative;
  if (!titleKey(track?.title) || titleKey(track.title) !== titleKey(candidate.title)) return false;
  if (versionKey(track?.title) !== versionKey(candidate.title)) return false;
  if (!artistIdentityMatches(track?.artist, candidate.artist)) return false;
  return durationIdentityMatches(track?.durationMs, candidate.durationMs);
}

module.exports = {
  SIMPLIFIED_VARIANTS,
  foldCatalogText,
  translatedTitleBase,
  stripFeaturing,
  titleKey,
  versionKey,
  normalizeIsrc,
  normalizeSpotifyTrackId,
  artistAliases,
  artistIdentityMatches,
  compareAuthoritativeIdentity,
  authoritativeIdentityMatch,
  recordingIdentityMatches,
};
