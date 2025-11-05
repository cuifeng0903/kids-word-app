// =====================
//  状態
// =====================
const state = {
  entries: [],       // { id, word, japanese, pos }
  current: null,
  sessionSize: 5,
  progressCount: 0,
  lastSeenIds: [],
  tts: { lang: 'en-US', rate: 0.95, pitch: 1.05, volume: 0.7 },
  missCountForCurrent: 0,
};

// 画面切替（学習画面は廃止）
const screens = ['home', 'quiz', 'reward', 'parent'];
function show(id) {
  screens.forEach(s => document.getElementById(s).classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// =====================
//  CSV 読み込み・検証
// =====================
function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const filtered = lines.filter((l, i) => (i === 0 ? true : l.length > 0));
  if (!filtered.length) return [];
  const header = filtered[0].split(',').map(h => h.trim());
  const idxWord = header.indexOf('word');
  const idxJa   = header.indexOf('japanese');
  const idxPos  = header.indexOf('pos');
  if (idxWord < 0 || idxJa < 0 || idxPos < 0) {
    logDev('ヘッダーが不正です。必要: word,japanese,pos');
    return [];
  }
  const out = [];
  const invalids = [];
  for (let i = 1; i < filtered.length; i++) {
    const cols = splitCsvLine(filtered[i]);
    const word = (cols[idxWord] || '').trim();
    const jap  = (cols[idxJa] || '').trim();
    const pos  = (cols[idxPos] || '').trim();
    if (!word || !jap || !pos) { invalids.push(i+1); continue; }
    const id = normalizeId(word);
    out.push({ id, word, japanese: jap, pos });
  }
  if (invalids.length) logDev(`${invalids.length} 行スキップ: 行 ${invalids.join(', ')}`);
  return dedupeById(out);
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
function normalizeId(word) { return word.toLowerCase().trim().replace(/\s+/g, '-'); }
function dedupeById(arr) {
  const map = new Map();
  for (const e of arr) map.set(e.id, e); // 後勝ち
  if (arr.length !== map.size) logDev(`重複IDをマージ（後勝ち）: ${arr.length - map.size} 件`);
  return [...map.values()];
}

// =====================
//  TTS（英→日 連続）
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
    u1.onerror = () => {};
    u2.onerror = () => {};

    speechSynthesis.cancel();
    speechSynthesis.speak(u1);

  } catch (e) {
    logDev(`TTSシーケンスエラー: ${e?.message || e}`);
  }
}

// =====================
//  出題選定・4択構築
// =====================
function pickNext(entries) {
  const pool = entries.filter(e => !state.lastSeenIds.includes(e.id));
  const base = pool.length ? pool : entries;
  const choice = base[Math.floor(Math.random() * base.length)];
  state.lastSeenIds.unshift(choice.id);
  state.lastSeenIds = [...new Set(state.lastSeenIds)].slice(0, 10);
  return choice;
}
function buildQuizOptions(entries, target) {
  const samePOS = entries.filter(e => e.pos === target.pos && e.id !== target.id);
  const others  = entries.filter(e => e.pos !== target.pos && e.id !== target.id);
  const distractors = [];
  while (distractors.length < 3 && samePOS.length) distractors.push(pickAndRemoveRandom(samePOS));
  while (distractors.length < 3 && others.length)  distractors.push(pickAndRemoveRandom(others));
  const options = shuffle([{ ...target, isCorrect:true }, ...distractors.map(d => ({...d, isCorrect:false}))])
    .map(e => ({ id:e.id, label:e.japanese, isCorrect:!!e.isCorrect }));
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
//  正誤処理（正答で紙吹雪＆英→日読み上げ→次へ）
// =====================
function onChoice(opt, el) {
  if (opt.isCorrect) {
    speakSequenceEnJa(state.current.word, state.current.japanese);
    confettiFountain({ duration: 1200, count: 180 }).then(() => {
      state.progressCount++;
      saveSticker(state.current.id);
      state.missCountForCurrent = 0;

      if (state.progressCount >= state.sessionSize) {
        showRewardIcon();
        show('reward');
      } else {
        nextRound(); // アニメ直後にすぐ次へ
      }
    });
  } else {
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
//  紙吹雪（下部噴水）
// =====================
function confettiFountain({ duration = 1200, count = 160 } = {}) {
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
  const originX = W / 2;
  const originY = H - 4;

  const colors = ['#ff6f61','#6ec6ff','#ffd54f','#81c784','#b39ddb','#ff8a65','#4dd0e1','#f06292','#a5d6a7','#fff176'];
  const shapes = ['rect','circle','rect','rect','circle'];

  const particles = [];
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI / 2) + (Math.random() * Math.PI / 5 - Math.PI / 10); // 75°〜105°
    const speed = 6 + Math.random() * 6;
    const size = 3 + Math.random() * 4;
    particles.push({
      x: originX + (Math.random() * 40 - 20),
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: -Math.sin(angle) * speed,
      g: 0.18 + Math.random() * 0.12,
      w: size, h: size * (0.8 + Math.random()*0.6),
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.2,
      color: colors[i % colors.length],
      shape: shapes[i % shapes.length],
      alpha: 1,
      life: 800 + Math.random() * 600
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
        ctx.beginPath();
        if (p.shape === 'rect') {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
          ctx.restore();
        } else {
          ctx.arc(p.x, p.y, p.w/2, 0, Math.PI * 2);
          ctx.fill();
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
//  ライフサイクル（クイズのみ）
// =====================
function startSession() {
  if (!state.entries.length) {
    logDev('単語データがありません。CSVを読み込んでください。');
    show('parent');
    return;
  }
  state.progressCount = 0;
  nextRound();     // 直ちに最初の問題へ
  show('quiz');
  // 開始時に英単語を読み上げ（クイズ画面ヘッダの🔊でも再生可能）
  state.current && speakWord(state.current.word);
}
function nextRound() {
  state.current = pickNext(state.entries);
  const opts = buildQuizOptions(state.entries, state.current);
  renderQuiz(opts);
}

// =====================
//  保存・設定
// =====================
function saveSticker(id) {
  const key = 'stickers.earned';
  const cur = JSON.parse(localStorage.getItem(key) || '[]');
  if (!cur.includes(id)) cur.push(id);
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

  // サンプルCSV自動ロード
  fetch('./sample.csv')
    .then(r => r.ok ? r.text() : Promise.reject('HTTP error'))
    .then(text => {
      state.entries = parseCsv(text);
      logDev(`サンプルCSV読込: ${state.entries.length} 件`);
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

  // CSV入力
  document.getElementById('csvInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    state.entries = parseCsv(text);
    logDev(`CSV読み込み: ${state.entries.length} 件`);
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

  // 進捗リセット
  document.getElementById('resetProgress').onclick = () => {
    localStorage.removeItem('stickers.earned');
    localStorage.removeItem('settings');
    logDev('進捗と設定をリセットしました');
  };
});
