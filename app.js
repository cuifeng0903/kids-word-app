// =====================
//  状態
// =====================
const state = {
  entries: [],       // { seq:number, word, japanese, pos }
  filtered: [],
  current: null,
  sessionSize: 5,
  progressCount: 0,
  lastSeenIds: [],
  tts: { lang: 'en-US', rate: 0.95, pitch: 1.05, volume: 0.7 },
  missCountForCurrent: 0,
  dataset: { minSeq: null, maxSeq: null, posSet: new Set() },
  filters: { start: null, end: null, posSelected: new Set() },
};

// 画面切替
const screens = ['home', 'quiz', 'reward', 'parent'];
function show(id) {
  screens.forEach(s => document.getElementById(s).classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// =====================
//  CSV 読み込み・検証（日本語ヘッダー）
//  ヘッダー互換：通番/英単語/日本語訳/品詞 か、旧: word/japanese/pos/番号 も許容
// =====================
function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return [];

  // 先頭の空行はスキップ
  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return [];

  const header = splitCsvLine(lines[0]).map(h => h.trim());

  const idxSeq = findHeader(header, ['通番','seq','番号','id','index']);
  const idxWord = findHeader(header, ['英単語','word','単語']);
  const idxJa   = findHeader(header, ['日本語訳','japanese','訳','和訳']);
  const idxPos  = findHeader(header, ['品詞','pos']);

  if (idxSeq < 0 || idxWord < 0 || idxJa < 0 || idxPos < 0) {
    logDev('ヘッダーが不正です。必要: 通番,英単語,日本語訳,品詞（旧: word,japanese,pos も可）');
    return [];
  }

  const out = [];
  const invalids = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cols = splitCsvLine(raw);
    const seq  = Number((cols[idxSeq] || '').trim());
    const word = (cols[idxWord] || '').trim();
    const jap  = (cols[idxJa] || '').trim();
    const pos  = (cols[idxPos] || '').trim();

    if (!Number.isFinite(seq) || !word || !jap || !pos) {
      invalids.push(i+1); continue;
    }
    out.push({ seq, word, japanese: jap, pos });
  }
  if (invalids.length) logDev(`${invalids.length} 行スキップ: 行 ${invalids.join(', ')}`);

  // データセット情報
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
    const i = lower.indexOf(String(cand).toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

// カンマ・引用符対応の軽量CSV分割
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
//  TTS（英→日 連続 / Promise を返す）
// =====================
function speakWord(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = state.tts.lang;
    u.rate = state.tts.rate;
    u.pitch = state.tts.pitch;
    u.volume = state.tts.volume;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) { logDev(`TTSエラー: ${e?.message || e}`); }
}

function speakSequenceEnJa(word, japanese) {
  return new Promise(resolve => {
    try {
      const u1 = new SpeechSynthesisUtterance(word);
      u1.lang = state.tts.lang || 'en-US';
      u1.rate = state.tts.rate;
      u1.pitch = state.tts.pitch;
      u1.volume = state.tts.volume;

      const u2 = new SpeechSynthesisUtterance(japanese);
      u2.lang = 'ja-JP';
      u2.rate = 0.95;
      u2.pitch = 1.05;
      u2.volume = 0.8;

      u1.onend = () => speechSynthesis.speak(u2);
      u2.onend = resolve;
      u1.onerror = (e)=>{ logDev('TTS英語エラー'); resolve(); };
      u2.onerror = (e)=>{ logDev('TTS日本語エラー'); resolve(); };

      speechSynthesis.cancel();
      speechSynthesis.speak(u1);
    } catch (e) {
      logDev(`TTSシーケンス例外: ${e?.message || e}`);
      resolve();
    }
  });
}

// =====================
//  フィルタ適用（通番・品詞）
// =====================
function applyFilters() {
  const { start, end, posSelected } = state.filters;
  const startNum = Number.isFinite(start) ? start : state.dataset.minSeq;
  const endNum   = Number.isFinite(end)   ? end   : state.dataset.maxSeq;
  const posSet   = (posSelected && posSelected.size) ? posSelected : state.dataset.posSet;

  state.filtered = state.entries.filter(e =>
    e.seq >= startNum && e.seq <= endNum && posSet.has(e.pos)
  );
}

// =====================
//  出題選定・4択構築（フィルタ後の集合から）
// =====================
function pickNext() {
  if (!state.filtered.length) return null;

  // 最近の重複回避
  const recentIds = new Set(state.lastSeenIds);
  const pool = state.filtered.filter(e => !recentIds.has(e.seq));
  const base = pool.length ? pool : state.filtered;

  const choice = base[Math.floor(Math.random() * base.length)];
  state.lastSeenIds.unshift(choice.seq);
  state.lastSeenIds = [...new Set(state.lastSeenIds)].slice(0, 10);
  return choice;
}

function buildQuizOptions(target) {
  const entries = state.filtered;
  const samePOS = entries.filter(e => e.pos === target.pos && e.seq !== target.seq);
  const others  = entries.filter(e => e.pos !== target.pos && e.seq !== target.seq);

  const distractors = [];
  while (distractors.length < 3 && samePOS.length) distractors.push(pickAndRemoveRandom(samePOS));
  while (distractors.length < 3 && others.length)  distractors.push(pickAndRemoveRandom(others));

  // 4択不足のときはやさしく不足分をランダム補完（安全策）
  if (distractors.length < 3) {
    const rest = entries.filter(e => e.seq !== target.seq && !distractors.includes(e));
    while (distractors.length < 3 && rest.length) distractors.push(pickAndRemoveRandom(rest));
  }

  const options = shuffle([{ ...target, isCorrect:true }, ...distractors.map(d => ({...d, isCorrect:false}))])
    .map(e => ({ id:e.seq, label:e.japanese, isCorrect:!!e.isCorrect }));
  return options;
}

function pickAndRemoveRandom(arr){ const i = Math.floor(Math.random()*arr.length); return arr.splice(i,1)[0]; }
function shuffle(arr){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]];} return arr; }

// =====================
//  レンダリング（クイズのみ）
// =====================
function renderQuiz(options) {
  document.getElementById('quizWord').textContent = state.current.word;
  const container = document.getElementById('choices');
  container.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'choice';
    btn.textContent = opt.label;
    btn.onclick = () => onChoice(opt, btn);
    container.appendChild(btn);
  });
  document.getElementById('progress').textContent = `${state.progressCount} / ${state.sessionSize}`;
}

// =====================
//  正誤処理
//  - 正答：〇（赤）＋豪華紙吹雪、英→日のTTS完了を待ってから次へ
//  - 誤答：×（青）、リトライ可（2回目ミスで淡いヒント）
// =====================
function onChoice(opt, el) {
  if (opt.isCorrect) {
    showMark('ok'); // 〇

    // 英→日読み上げ と 豪華紙吹雪 を同時開始し、両方の完了を待つ
    Promise.all([
      speakSequenceEnJa(state.current.word, state.current.japanese),
      confettiFountain({ duration: 1600, count: 320, emitters: 3, sparkles: true })
    ]).then(() => {
      hideMark();
      state.progressCount++;
      saveSticker(state.current.seq);
      state.missCountForCurrent = 0;

      if (state.progressCount >= state.sessionSize) {
        showRewardIcon();
        show('reward');
      } else {
        nextRound(); // TTS日本語完了＆紙吹雪完了のあとで遷移
      }
    });
  } else {
    showMark('ng'); // ×
    setTimeout(hideMark, 600);

    el.classList.add('shake');
    state.missCountForCurrent++;
    if (state.missCountForCurrent >= 2) {
      // さりげなく正解ボタンにグロー（日本語ラベル一致）
      [...document.querySelectorAll('#choices .choice')].forEach(btn => {
        if (btn.textContent === state.current.japanese) btn.classList.add('glow');
      });
    }
    setTimeout(() => el.classList.remove('shake'), 320);
  }
}

// =====================
//  〇/× 表示
// =====================
function showMark(kind /* 'ok' | 'ng' */) {
  const el = document.getElementById('markOverlay');
  el.className = `mark-overlay show ${kind === 'ok' ? 'mark--ok' : 'mark--ng'}`;
  el.textContent = (kind === 'ok') ? '〇' : '×';
}
function hideMark() {
  const el = document.getElementById('markOverlay');
  el.classList.remove('show','mark--ok','mark--ng');
  el.textContent = '';
}

// =====================
//  紙吹雪（下部噴水・豪華版）
//  - 複数エミッタ（中央・左右）
//  - 星形スパークルを混ぜる
// =====================
function confettiFountain({ duration = 1600, count = 320, emitters = 3, sparkles = true } = {}) {
  const canvas = document.getElementById('confetti');
  if (!canvas) return Promise.resolve();

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;

  const emitOrigins = [];
  if (emitters === 1) {
    emitOrigins.push({ x: W/2, y: H-6 });
  } else if (emitters === 2) {
    emitOrigins.push({ x: W*0.35, y: H-6 }, { x: W*0.65, y: H-6 });
  } else {
    emitOrigins.push({ x: W*0.25, y: H-6 }, { x: W*0.5, y: H-6 }, { x: W*0.75, y: H-6 });
  }

  const colors = ['#ff6f61','#6ec6ff','#ffd54f','#81c784','#b39ddb','#ff8a65','#4dd0e1','#f06292','#a5d6a7','#fff176'];
  const shapes = ['rect','circle','rect','rect','circle', (sparkles ? 'star' : 'rect')];

  const particles = [];
  for (let i = 0; i < count; i++) {
    const org = emitOrigins[i % emitOrigins.length];
    const angle = (Math.PI / 2) + (Math.random() * Math.PI / 4 - Math.PI / 8); // 67.5°〜112.5°
    const speed = 6 + Math.random() * 7;
    const size = 3 + Math.random() * 5;
    particles.push({
      x: org.x + (Math.random() * 40 - 20),
      y: org.y,
      vx: Math.cos(angle) * speed,
      vy: -Math.sin(angle) * speed,
      g: 0.18 + Math.random() * 0.14,
      w: size, h: size * (0.8 + Math.random()*0.6),
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.25,
      color: colors[i % colors.length],
      shape: shapes[i % shapes.length],
      alpha: 1,
      life: 900 + Math.random() * 800
    });
  }

  const start = performance.now();
  return new Promise(resolve => {
    function tick(now) {
      const elapsed = now - start;
      ctx.clearRect(0, 0, W, H);

      for (const p of particles) {
        p.vy += p.g * 0.06;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.spin;
        p.alpha = Math.max(0, 1 - elapsed / p.life);

        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;

        if (p.shape === 'rect') {
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h); ctx.restore();
        } else if (p.shape === 'circle') {
          ctx.beginPath(); ctx.arc(p.x, p.y, p.w/2, 0, Math.PI*2); ctx.fill();
        } else if (p.shape === 'star') {
          drawStar(ctx, p.x, p.y, 5, p.w, p.w/2, p.rot, p.color);
        }

        ctx.globalAlpha = 1;
      }

      if (elapsed < duration) {
        requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0, 0, W, H);
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });
}

function drawStar(ctx, x, y, spikes, outerR, innerR, rot, color) {
  let rotA = Math.PI / 2 * 3;
  let cx = x, cy = y;
  let step = Math.PI / spikes;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(0, -outerR);
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(Math.cos(rotA) * outerR, Math.sin(rotA) * outerR);
    rotA += step;
    ctx.lineTo(Math.cos(rotA) * innerR, Math.sin(rotA) * innerR);
    rotA += step;
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

// =====================
//  ごほうび（30種アイコン）
// =====================
const REWARD_ICONS = [
  // 動物
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯',
  '🦁','🐮','🐷','🐸','🐵','🦄',
  // 果物
  '🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🍒','🍑',
  '🥭','🍍','🥝','🍈'
]; // 合計30

function showRewardIcon() {
  const spot = document.getElementById('stickerSpot');
  if (!spot) return;
  const icon = REWARD_ICONS[Math.floor(Math.random() * REWARD_ICONS.length)];
  spot.textContent = icon;
}

// =====================
//  ライフサイクル（クイズ開始前にフィルタを確定）
// =====================
function startSession() {
  if (!state.entries.length) {
    logDev('単語データがありません。CSVを読み込んでください。');
    show('parent');
    return;
  }

  // 入力値からフィルタ確定
  readFilterInputs();
  applyFilters();

  // 最低4件ないと4択が成立しない
  if (state.filtered.length < 4) {
    const msg = `出題範囲に ${state.filtered.length} 件しかありません（4件以上必要です）。通番や品詞を見直してください。`;
    showStartError(msg, true);
    return;
  }
  showStartError('', false);

  state.progressCount = 0;
  state.lastSeenIds = [];
  nextRound();     // 最初の問題
  show('quiz');
  // 開始時に英単語を読み上げ（ヘッダの🔊でも再生可能）
  state.current && speakWord(state.current.word);
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
//  入力UI（ホームの範囲・品詞）
// =====================
function populateHomeFilters() {
  const minMaxEl = document.getElementById('rangeMinMax');
  const startEl = document.getElementById('rangeStart');
  const endEl = document.getElementById('rangeEnd');
  const posWrap = document.getElementById('posFilter');

  // 通番の初期表示
  const { minSeq, maxSeq, posSet } = state.dataset;
  minMaxEl.textContent = `${minSeq} 〜 ${maxSeq}`;
  startEl.value = minSeq;
  endEl.value = maxSeq;

  // 品詞チップを生成（既定で全選択）
  posWrap.innerHTML = '';
  [...posSet].sort().forEach(p => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip active';
    chip.textContent = p;
    chip.dataset.pos = p;
    chip.onclick = () => {
      chip.classList.toggle('active');
    };
    posWrap.appendChild(chip);
  });
}

function readFilterInputs() {
  const startEl = document.getElementById('rangeStart');
  const endEl = document.getElementById('rangeEnd');
  const posWrap = document.getElementById('posFilter');

  const start = Number(startEl.value);
  const end   = Number(endEl.value);

  // 値の正規化
  let s = Number.isFinite(start) ? start : state.dataset.minSeq;
  let e = Number.isFinite(end)   ? end   : state.dataset.maxSeq;
  if (s > e) [s, e] = [e, s]; // 逆転時スワップ

  // 品詞選択（未選択なら全品詞扱い）
  const actives = [...posWrap.querySelectorAll('.chip.active')].map(el => el.dataset.pos);
  const posSelected = new Set(actives.length ? actives : [...state.dataset.posSet]);

  state.filters = { start: s, end: e, posSelected };
}

function showStartError(msg, show) {
  const el = document.getElementById('startError');
  if (!show) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false; el.textContent = msg;
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
  if (s.tts) state.tts = { ...state.tts, ...s.tts };
}
function saveSettings() {
  localStorage.setItem('settings', JSON.stringify({ sessionSize: state.sessionSize, tts: state.tts }));
}
function logDev(msg) {
  const el = document.getElementById('devLog');
  if (el) el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  console.log(msg);
}

// =====================
//  イベント
// =====================
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  // キャンバス解像度更新
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

  // ホーム
  document.getElementById('startBtn').onclick = () => startSession();
  document.getElementById('parentBtn').onclick = () => show('parent');

  // クイズ
  document.getElementById('quizReplayBtn').onclick = () => state.current && speakWord(state.current.word);

  // ごほうび
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
    state.current && speakWord(state.current.word);
  };
  document.getElementById('toHomeBtn').onclick = () => show('home');

  // 保護者ゲート
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

  // CSV入力（再読込でUI再構築）
  document.getElementById('csvInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    state.entries = parseCsv(text);
    logDev(`CSV読み込み: ${state.entries.length} 件`);
    if (state.entries.length) populateHomeFilters();
  });

  // 設定反映
  document.getElementById('sessionSize').addEventListener('change', (e) => {
    state.sessionSize = Number(e.target.value);
    saveSettings();
  });
  document.getElementById('ttsLang').addEventListener('change', (e) => {
    state.tts.lang = e.target.value; saveSettings();
  });
  document.getElementById('ttsRate').addEventListener('input', (e) => {
    state.tts.rate = Number(e.target.value); saveSettings();
  });
  document.getElementById('ttsPitch').addEventListener('input', (e) => {
    state.tts.pitch = Number(e.target.value); saveSettings();
  });

  // 通番入力の軽微なバリデーション（エラーは開始時に集約表示）
  const rs = document.getElementById('rangeStart');
  const re = document.getElementById('rangeEnd');
  [rs, re].forEach(el => el.addEventListener('change', () => {
    const s = Number(rs.value), e = Number(re.value);
    if (Number.isFinite(s) && Number.isFinite(e) && s > e) {
      // 視覚的な注意（入替は開始時に自動で行う）
      showStartError('通番の開始/終了が逆転しています（開始の方が小さくなるようにしてください）', true);
    } else {
      showStartError('', false);
    }
  }));

  // 進捗リセット
  document.getElementById('resetProgress').onclick = () => {
    localStorage.removeItem('stickers.earned');
    localStorage.removeItem('settings');
    logDev('進捗と設定をリセットしました');
  };
});
