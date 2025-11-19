// =====================
//  状態管理
// =====================
const state = {
  entries: [],       // { seq:number, word, japanese, pos }
  filtered: [],
  current: null,
  sessionSize: 5,
  progressCount: 0,
  lastSeenIds: [],
  tts: { lang: 'en-US', rate: 0.95, pitch: 1.05, volume: 0.7, voice: null },
  missCountForCurrent: 0,
  dataset: { minSeq: null, maxSeq: null, posSet: new Set() },
  filters: { start: null, end: null, posSelected: new Set() },
};

// =====================
//  CSV読み込み・検証
// =====================
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map(h => h.trim());

  const idxSeq = findHeader(header, ['通番','seq','番号','id']);
  const idxWord = findHeader(header, ['英単語','word']);
  const idxJa = findHeader(header, ['日本語訳','japanese']);
  const idxPos = findHeader(header, ['品詞','pos']);

  if (idxSeq < 0 || idxWord < 0 || idxJa < 0 || idxPos < 0) {
    logDev('ヘッダーが不正です');
    return [];
  }

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const seq = Number((cols[idxSeq] || '').trim());
    const word = (cols[idxWord] || '').trim();
    const jap = (cols[idxJa] || '').trim();
    const pos = (cols[idxPos] || '').trim();
    if (!Number.isFinite(seq) || !word || !jap || !pos) continue;
    out.push({ seq, word, japanese: jap, pos });
  }

  if (out.length) {
    const seqs = out.map(e => e.seq);
    state.dataset.minSeq = Math.min(...seqs);
    state.dataset.maxSeq = Math.max(...seqs);
    state.dataset.posSet = new Set(out.map(e => e.pos));
  }
  return out;
}

function findHeader(arr, candidates) {
  const lower = arr.map(s => s.toLowerCase());
  for (const cand of candidates) {
    const i = lower.indexOf(cand.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function splitCsvLine(line) {
  const result = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// =====================
//  音声選択（TOP UI）
// =====================
const VOICE_STORAGE_KEY = 'tts.en.voiceName';

function initVoiceSelect() {
  const sel = document.getElementById('voiceSelect');
  const testBtn = document.getElementById('voiceTestBtn');
  if (!sel || !testBtn) return;

  const savedName = localStorage.getItem(VOICE_STORAGE_KEY);

  const buildOptions = () => {
    const voices = speechSynthesis.getVoices() || [];
    const enVoices = voices.filter(v => /^en(-|_)/i.test(v.lang))
      .sort((a,b) => scoreVoice(b) - scoreVoice(a));

    sel.innerHTML = '';
    if (!enVoices.length) {
      sel.innerHTML = '<option>（英語音声なし）</option>';
      sel.disabled = true; testBtn.disabled = true;
      return;
    }

    sel.disabled = false; testBtn.disabled = false;
    enVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(opt);
    });

    const idx = enVoices.findIndex(v => v.name === savedName);
    sel.selectedIndex = (idx >= 0) ? idx : 0;
    state.tts.voice = enVoices[sel.selectedIndex];
    localStorage.setItem(VOICE_STORAGE_KEY, state.tts.voice.name);
  };

  function scoreVoice(v) {
    const name = (v.name||'').toLowerCase();
    let s = 0;
    if (/siri/.test(name)) s+=5;
    if (/enhanced|premium|natural/.test(name)) s+=3;
    if (/en-us/.test((v.lang||'').toLowerCase())) s+=2;
    return s;
  }

  sel.addEventListener('change', () => {
    const voices = speechSynthesis.getVoices() || [];
    const picked = voices.find(v => v.name === sel.value);
    state.tts.voice = picked || null;
    localStorage.setItem(VOICE_STORAGE_KEY, picked?.name || '');
  });

  testBtn.addEventListener('click', () => {
    speakWithSelectedVoice('Hello! Nice to meet you!');
  });

  let retries = 0;
  const tryBuild = () => {
    buildOptions();
    if ((speechSynthesis.getVoices()||[]).length===0 && retries<10) {
      retries++; setTimeout(tryBuild,500);
    }
  };
  window.speechSynthesis.onvoiceschanged = buildOptions;
  tryBuild();
}

function speakWithSelectedVoice(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = state.tts.lang;
  u.rate = state.tts.rate;
  u.pitch = state.tts.pitch;
  u.volume = state.tts.volume;
  if (state.tts.voice) u.voice = state.tts.voice;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
// =====================
//  英→日シーケンス（選択音声適用）
// =====================
function speakSequenceEnJa(word, japanese) {
  return new Promise(resolve => {
    const u1 = new SpeechSynthesisUtterance(word);
    u1.lang = state.tts.lang;
    u1.rate = state.tts.rate;
    u1.pitch = state.tts.pitch;
    u1.volume = state.tts.volume;
    if (state.tts.voice) u1.voice = state.tts.voice;

    const u2 = new SpeechSynthesisUtterance(japanese);
    u2.lang = 'ja-JP'; u2.rate=0.95; u2.pitch=1.05; u2.volume=0.8;

    u1.onend = ()=>speechSynthesis.speak(u2);
    u2.onend = resolve;
    speechSynthesis.cancel();
    speechSynthesis.speak(u1);
  });
}

// =====================
//  フィルタ適用
// =====================
function applyFilters() {
  const { start,end,posSelected } = state.filters;
  const s = Number.isFinite(start)?start:state.dataset.minSeq;
  const e = Number.isFinite(end)?end:state.dataset.maxSeq;
  const posSet = posSelected.size?posSelected:state.dataset.posSet;
  state.filtered = state.entries.filter(e2=>e2.seq>=s && e2.seq<=e && posSet.has(e2.pos));
}

// =====================
//  出題ロジック
// =====================
function pickNext() {
  if (!state.filtered.length) return null;
  const pool = state.filtered.filter(e=>!state.lastSeenIds.includes(e.seq));
  const base = pool.length?pool:state.filtered;
  const choice = base[Math.floor(Math.random()*base.length)];
  state.lastSeenIds.unshift(choice.seq);
  state.lastSeenIds = [...new Set(state.lastSeenIds)].slice(0,10);
  return choice;
}

function buildQuizOptions(target) {
  const entries = state.filtered;
  const samePOS = entries.filter(e=>e.pos===target.pos && e.seq!==target.seq);
  const others = entries.filter(e=>e.pos!==target.pos && e.seq!==target.seq);
  const distractors=[];
  while(distractors.length<3 && samePOS.length)distractors.push(pickAndRemoveRandom(samePOS));
  while(distractors.length<3 && others.length)distractors.push(pickAndRemoveRandom(others));
  if(distractors.length<3){
    const rest=entries.filter(e=>e.seq!==target.seq && !distractors.includes(e));
    while(distractors.length<3 && rest.length)distractors.push(pickAndRemoveRandom(rest));
  }
  return shuffle([{...target,isCorrect:true},...distractors.map(d=>({...d,isCorrect:false}))])
    .map(e=>({id:e.seq,label:e.japanese,isCorrect:e.isCorrect}));
}

function pickAndRemoveRandom(arr){const i=Math.floor(Math.random()*arr.length);return arr.splice(i,1)[0];}
function shuffle(arr){for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}

// =====================
//  UIレンダリング
// =====================
function renderQuiz(options){
  document.getElementById('quizWord').textContent=state.current.word;
  const c=document.getElementById('choices');c.innerHTML='';
  options.forEach(opt=>{
    const btn=document.createElement('button');
    btn.className='choice';btn.textContent=opt.label;
    btn.onclick=()=>onChoice(opt,btn);
    c.appendChild(btn);
  });
  document.getElementById('progress').textContent=`${state.progressCount} / ${state.sessionSize}`;
}

// =====================
//  正誤処理
// =====================
function onChoice(opt,el){
  if(opt.isCorrect){
    showMark('ok');
    Promise.all([speakSequenceEnJa(state.current.word,state.current.japanese),confettiFountain()])
    .then(()=>{
      hideMark();
      state.progressCount++;
      saveSticker(state.current.seq);
      if(state.progressCount>=state.sessionSize){
        const icon=showRewardIcon();addRewardHistory(icon);
        show('reward');
      }else nextRound();
    });
  }else{
    showMark('ng');setTimeout(hideMark,600);
    el.classList.add('shake');
    state.missCountForCurrent++;
    if(state.missCountForCurrent>=2){
      [...document.querySelectorAll('#choices .choice')].forEach(b=>{
        if(b.textContent===state.current.japanese)b.classList.add('glow');
      });
    }
    setTimeout(()=>el.classList.remove('shake'),320);
  }
}

// =====================
//  マーク表示
// =====================
function showMark(kind){
  const el=document.getElementById('markOverlay');
  el.className=`mark-overlay show ${kind==='ok'?'mark--ok':'mark--ng'}`;
  el.textContent=(kind==='ok')?'〇':'×';
}
function hideMark(){
  const el=document.getElementById('markOverlay');
  el.classList.remove('show','mark--ok','mark--ng');el.textContent='';
}

// =====================
//  紙吹雪
// =====================
function confettiFountain({duration=1500,count=300}={}){
  const canvas=document.getElementById('confetti');if(!canvas)return Promise.resolve();
  const dpr=window.devicePixelRatio||1;const rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const W=rect.width,H=rect.height;const originX=W/2,originY=H-4;
  const colors=['#ff6f61','#6ec6ff','#ffd54f','#81c784','#b39ddb','#ff8a65','#4dd0e1','#f06292','#a5d6a7','#fff176'];
  const particles=[];
  for(let i=0;i<count;i++){
    const angle=(Math.PI/2)+(Math.random()*Math.PI/4-Math.PI/8);
    const speed=6+Math.random()*7;const size=3+Math.random()*5;
    particles.push({x:originX+(Math.random()*40-20),y:originY,vx:Math.cos(angle)*speed,vy:-Math.sin(angle)*speed,g:0.18+Math.random()*0.14,w:size,h:size*(0.8+Math.random()*0.6),rot:Math.random()*Math.PI,spin:(Math.random()-0.5)*0.25,color:colors[i%colors.length],alpha:1,life:900+Math.random()*800});
  }
  const start=performance.now();
  return new Promise(resolve=>{
    function tick(now){
      const elapsed=now-start;ctx.clearRect(0,0,W,H);
      for(const p of particles){
        p.vy+=p.g*0.06;p.x+=p.vx;p.y+=p.vy;p.rot+=p.spin;p.alpha=Math.max(0,1-elapsed/p.life);
        ctx.globalAlpha=p.alpha;ctx.fillStyle=p.color;
        ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot);ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h);ctx.restore();
        ctx.globalAlpha=1;
      }
      if(elapsed<duration)requestAnimationFrame(tick);else{ctx.clearRect(0,0,W,H);resolve();}
    }
    requestAnimationFrame(tick);
  });
}

// =====================
//  ごほうび履歴
// =====================
const REWARD_ICONS=['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🦄','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑','🥭','🍍','🥝','🍈'];
function showRewardIcon(){const spot=document.getElementById('stickerSpot');const icon=REWARD_ICONS[Math.floor(Math.random()*REWARD_ICONS.length)];spot.textContent=icon;return icon;}
function addRewardHistory(icon){const key='rewards.history';const data=JSON.parse(localStorage.getItem(key)||'{}');const today=dateKey(new Date());data[today]=data[today]||[];data[today].push(icon);localStorage.setItem(key,JSON.stringify(data));}
function renderRewardsList(){const wrap=document.getElementById('rewardsList');wrap.innerHTML='';const data=JSON.parse(localStorage.getItem('rewards.history')||'{}');const keys=Object.keys(data).sort((a,b)=>a<b?1:-1).slice(0,30);if(!keys.length){wrap.innerHTML='<p class=\"hint\">まだ ごほうび は ありません</p>';return;}keys.forEach(k=>{const row=document.createElement('div');row.className='reward-day';const dateEl=document.createElement('div');dateEl.className='reward-date';dateEl.textContent=formatJaMd(k);const iconsEl=document.createElement('div');iconsEl.className='reward-icons';data[k].forEach(ic=>{const span=document.createElement('span');span.textContent=ic;iconsEl.appendChild(span);});row.appendChild(dateEl);row.appendChild(iconsEl);wrap.appendChild(row);});}
function dateKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function formatJaMd(key){const [y,m,d]=key.split('-').map(Number);return `${m}月${d}日`;}

// =====================
//  ホームUI
// =====================
function populateHomeFilters(){const minMaxEl=document.getElementById('rangeMinMax');const startEl=document.getElementById('rangeStart');const endEl=document.getElementById('rangeEnd');const posWrap=document.getElementById('posFilter');const {minSeq,maxSeq,posSet}=state.dataset;if(minSeq==null)return;minMaxEl.textContent=`${minSeq}〜${maxSeq}`;startEl.value=minSeq;endEl.value=maxSeq;posWrap.innerHTML='';[...posSet].sort().forEach(p=>{const chip=document.createElement('button');chip.type='button';chip.className='chip active';chip.textContent=p;chip.dataset.pos=p;chip.onclick=()=>chip.classList.toggle('active');posWrap.appendChild(chip);});}
function readFilterInputs(){const s=Number(document.getElementById('rangeStart').value);const e=Number(document.getElementById('rangeEnd').value);let start=Number.isFinite(s)?s:state.dataset.minSeq;let end=Number.isFinite(e)?e:state.dataset.maxSeq;if(start>end)[start,end]=[end,start];const actives=[...document.querySelectorAll('#posFilter .chip.active')].map(el=>el.dataset.pos);const posSelected=new Set(actives.length?actives:[...state.dataset.posSet]);state.filters={start,end,posSelected};}
function showStartError(msg,show){const el=document.getElementById('startError');if(!show){el.hidden=true;el.textContent='';return;}el.hidden=false;el.textContent=msg;}

// =====================
//  セッション制御
// =====================
// =====================
//  セッション制御（続き）
// =====================
function startSession() {
  if (!state.entries.length) {
    logDev('単語データがありません。CSVを読み込んでください。');
    show('parent');
    return;
  }
  readFilterInputs();
  applyFilters();

  if (state.filtered.length < 4) {
    showStartError(`出題範囲に ${state.filtered.length} 件しかありません（4件以上必要です）。通番や品詞を見直してください。`, true);
    return;
  }
  showStartError('', false);

  state.progressCount = 0;
  state.lastSeenIds = [];
  nextRound();     // 最初の問題
  show('quiz');

  // 開始時に英単語を読み上げ（ヘッダの🔊でも再生可能）
  if (state.current) {
    speakWithSelectedVoice(state.current.word);
  }
}

function nextRound() {
  state.current = pickNext();
  if (!state.current) {
    logDev('出題データが空です');
    show('home');
    return;
  }
  const opts = buildQuizOptions(state.current);
  renderQuiz(opts);
}

// =====================
//  保存・設定
// =====================
function saveSticker(seq) {
  const key = 'stickers.earned';
  const cur = JSON.parse(localStorage.getItem(key) || '[]');
  if (!cur.includes(seq)) cur.push(seq);
  localStorage.setItem(key, JSON.stringify(cur));
}

function loadSettings() {
  const s = JSON.parse(localStorage.getItem('settings') || '{}');
  if (s.sessionSize) state.sessionSize = s.sessionSize;
  // 既定の英語音声（名前）は VOICE_STORAGE_KEY に保存済みなので、initVoiceSelect() 側で復元します
}

function saveSettings() {
  localStorage.setItem('settings', JSON.stringify({
    sessionSize: state.sessionSize
  }));
}

function logDev(msg) {
  const el = document.getElementById('devLog');
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  if (el) el.textContent += line;
  // consoleにも出力
  // eslint-disable-next-line no-console
  console.log(msg);
}

// =====================
//  画面切替
// =====================
const screens = ['home', 'quiz', 'reward', 'rewards', 'parent'];
function show(id) {
  screens.forEach(s => document.getElementById(s).classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// =====================
//  初期化・イベント
// =====================
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  initVoiceSelect(); // TOPの英語音声選択UI

  // 紙吹雪キャンバスをリサイズ（描画は正答時のみ）
  const resizeCanvas = () => {
    const canvas = document.getElementById('confetti');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  };
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // サンプルCSV自動ロード（日本語ヘッダー）
  fetch('./sample.csv')
    .then(r => r.ok ? r.text() : Promise.reject('HTTP error'))
    .then(text => {
      state.entries = parseCsv(text);
      logDev(`サンプルCSV読込: ${state.entries.length} 件`);
      if (state.entries.length) {
        populateHomeFilters(); // 範囲と品詞をUIに反映
      }
    })
    .catch(() => {
      logDev('sample.csv を読み込めませんでした（保護者メニューからCSVを読み込んでください）');
    });

  // --- ホーム
  document.getElementById('startBtn').onclick = () => startSession();
  document.getElementById('rewardsBtn').onclick = () => { renderRewardsList(); show('rewards'); };
  document.getElementById('parentBtn').onclick = () => show('parent');

  // --- クイズ
  document.getElementById('quizReplayBtn').onclick = () => {
    if (state.current) speakWithSelectedVoice(state.current.word);
  };

  // --- ごほうび（セッション終了画面）
  document.getElementById('nextRoundBtn').onclick = () => {
    state.progressCount = 0;
    // フィルタは維持（同条件で続ける）
    applyFilters();
    if (state.filtered.length < 4) {
      show('home');
      showStartError('続けるための出題数が不足しています。通番や品詞を見直してください。', true);
      return;
    }
    nextRound();
    show('quiz');
    if (state.current) speakWithSelectedVoice(state.current.word);
  };
  document.getElementById('toHomeBtn').onclick = () => show('home');

  // --- ごほうび一覧
  document.getElementById('rewardsBackBtn').onclick = () => show('home');

  // --- 保護者ゲート
  let holdTimer = null, held = false;
  const holdBtn = document.getElementById('holdButton');
  const clearHold = () => { clearTimeout(holdTimer); };
  holdBtn.addEventListener('pointerdown', () => {
    held = false;
    holdTimer = setTimeout(() => { held = true; }, 3000);
  });
  holdBtn.addEventListener('pointerup', clearHold);
  holdBtn.addEventListener('pointerleave', clearHold);

  document.getElementById('enterParent').onclick = () => {
    const ok = held && Number(document.getElementById('gateAnswer').value) === 3;
    if (ok) {
      document.getElementById('parentGate').hidden = true;
      document.getElementById('parentPanel').hidden = false;
    }
  };

  document.getElementById('backHome').onclick = () => {
    document.getElementById('parentGate').hidden = false;
    document.getElementById('parentPanel').hidden = true;
    show('home');
  };

  // --- CSV入力（再読込でUI再構築）
  document.getElementById('csvInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    state.entries = parseCsv(text);
    logDev(`CSV読み込み: ${state.entries.length} 件`);
    if (state.entries.length) populateHomeFilters();
  });

  // --- 設定（出題数のみ保持）
  document.getElementById('sessionSize').addEventListener('change', (e) => {
    state.sessionSize = Number(e.target.value);
    saveSettings();
  });

  // --- 通番入力の軽微なバリデーション（エラーは開始時に集約表示）
  const rs = document.getElementById('rangeStart');
  const re = document.getElementById('rangeEnd');
  [rs, re].forEach(el => el.addEventListener('change', () => {
    const s = Number(rs.value), e = Number(re.value);
    if (Number.isFinite(s) && Number.isFinite(e) && s > e) {
      showStartError('通番の開始/終了が逆転しています（開始の方が小さくなるようにしてください）', true);
    } else {
      showStartError('', false);
    }
  }));
});
