// ====== 状態 ======
const state = {
  entries: [],       // { id, word, japanese, pos }
  current: null,
  sessionSize: 5,
  progressCount: 0,
  lastSeenIds: [],
  tts: { lang: 'en-US', rate: 0.95, pitch: 1.05, volume: 0.7 },
  missCountForCurrent: 0,
};

// ====== 画面切替 ======
const screens = ['home', 'learn', 'quiz', 'reward', 'parent'];
function show(id) {
  screens.forEach(s => document.getElementById(s).classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ====== CSV 読み込み（最小・堅牢化） ======
function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',').map(h => h.trim());
  const idxWord = header.indexOf('word');
  const idxJa   = header.indexOf('japanese');
  const idxPos  = header.indexOf('pos');
  const out = [];
  const invalids = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
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
// 簡易CSV行分割（カンマ＋引用符対応のライト版）
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
function normalizeId(word) { return word.toLowerCase().replace(/\s+/g, '-'); }
function dedupeById(arr) {
  const map = new Map();
  for (const e of arr) map.set(e.id, e); // 後勝ち
  if (arr.length !== map.size) logDev(`重複IDをマージ（後勝ち）: ${arr.length - map.size} 件`);
  return [...map.values()];
}

// ====== TTS ======
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

// ====== 出題選定・4択構築 ======
function pickNext(entries) {
  const pool = entries.filter(e => !state.lastSeenIds.includes(e.id));
  const choice = (pool.length ? pool : entries)[Math.floor(Math.random() * (pool.length ? pool.length : entries.length))];
  // 履歴更新（直近10件）
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

// ====== レンダリング ======
function renderLearn() {
  document.getElementById('learnWord').textContent = state.current.word;
}
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

// ====== 正誤処理 ======
function onChoice(opt, el) {
  if (opt.isCorrect) {
    el.classList.add('correct-burst');
    state.progressCount++;
    saveProgress(state.current.id);
    setTimeout(() => {
      if (state.progressCount >= state.sessionSize) {
        show('reward');
      } else {
        nextRound();
      }
    }, 700);
  } else {
    el.classList.add('shake');
    speakFriendlyRetry();
    state.missCountForCurrent++;
    if (state.missCountForCurrent >= 2) {
      // さりげなく正解ボタンにグロー付与
      [...document.querySelectorAll('#choices .choice')].forEach(btn => {
        if (btn.textContent === state.current.japanese) btn.classList.add('glow');
      });
    }
    setTimeout(() => el.classList.remove('shake'), 320);
  }
}
function speakFriendlyRetry() {
  // テキストでのフィードバック（音声は学習単語に限定）
  // ここでは画面表示に留める or 無音。必要なら日本語TTS（ja-JP）で促すが今回は英単語TTSに限定。
}

// ====== ライフサイクル ======
function startSession() {
  state.progressCount = 0;
  state.current = pickNext(state.entries);
  state.missCountForCurrent = 0;
  renderLearn();
  show('learn');
  // モバイルの自動再生対策：ユーザー操作後の呼び出し
  speakWord(state.current.word);
}
function toQuiz() {
  const opts = buildQuizOptions(state.entries, state.current);
  renderQuiz(opts);
  show('quiz');
}
function nextRound() {
  state.current = pickNext(state.entries);
  state.missCountForCurrent = 0;
  renderLearn();
  show('learn');
  speakWord(state.current.word);
}

// ====== 保護者・設定・保存 ======
function saveProgress(id) {
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
  if (!el) return;
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
}

// ====== イベント紐付け ======
window.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  // 体験用に sample.csv を自動ロード（本番では外すか、保護者で明示ロード）
  fetch('./sample.csv').then(r => r.text()).then(t => {
    state.entries = parseCsv(t);
  }).catch(()=> logDev('sample.csv を読み込めませんでした'));

  // 主要ボタン
  document.getElementById('startBtn').onclick = () => {
    // 初回タップでオーディオコンテキスト・TTSを解禁
    startSession();
  };
  document.getElementById('toQuizBtn').onclick = toQuiz;
  document.getElementById('replayBtn').onclick = () => speakWord(state.current.word);
  document.getElementById('quizReplayBtn').onclick = () => speakWord(state.current.word);
  document.getElementById('nextRoundBtn').onclick = () => { state.progressCount = 0; nextRound(); };
  document.getElementById('toHomeBtn').onclick = () => show('home');

  // 保護者メニュー
  document.getElementById('parentBtn').onclick = () => show('parent');

  // 長押しゲート
  let holdTimer = null, held = false;
  const holdBtn = document.getElementById('holdButton');
  holdBtn.addEventListener('pointerdown', () => {
    held = false;
    holdTimer = setTimeout(() => { held = true; }, 3000);
  });
  holdBtn.addEventListener('pointerup', () => clearTimeout(holdTimer));
  document.getElementById('enterParent').onclick = () => {
    const ok = held && Number(document.getElementById('gateAnswer').value) === 3;
    if (ok) {
      document.getElementById('parentGate').hidden = true;
      document.getElementById('parentPanel').hidden = false;
    }
  };

  // CSV入力
  document.getElementById('csvInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    state.entries = parseCsv(text);
    logDev(`CSV読み込み: ${state.entries.length} 件`);
  });

  // 設定
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
  document.getElementById('backHome').onclick = () => {
    document.getElementById('parentGate').hidden = false;
    document.getElementById('parentPanel').hidden = true;
    show('home');
  };
});
