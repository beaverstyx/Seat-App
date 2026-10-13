// SeatCheck auto-shuffle. Run by GitHub Actions (see .github/workflows/auto-shuffle.yml).
// Shuffles a class's seating shortly before it starts, unless it was already shuffled recently.
// Env: FIREBASE_SERVICE_ACCOUNT (JSON). Optional flags: --dry-run, --force, --now=<ISO time>

const CLASSES = [
  // id = Firestore document id under "classes". days: 0 = Sunday ... 6 = Saturday (Japan time).
  { id: 'oralcomm2', label: 'Oral Comm II (Business Administration)', days: [1, 4], start: '10:40' },
  { id: 'economics', label: 'Oral Comm II (Economics)',               days: [2, 5], start: '09:00' },
  { id: 'pubpol',    label: 'Oral Comm II (Public Policy)',           days: [2, 5], start: '10:40' }
];
const WINDOW_BEFORE_MIN = 75;   // start trying this long before class
const WINDOW_CLOSE_MIN  = 10;   // stop when seats open to students
const SKIP_IF_SHUFFLED_WITHIN_H = 36;
const ROOM_ROWS = 8;

const colLetter = i => String.fromCharCode(65 + i);
const seatKey = (r, c) => (r + 1) + colLetter(c);

function shuffleArray(arr, rng){
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Japan time parts for a Date (Japan has no DST: UTC+9).
function jst(date){
  const d = new Date(date.getTime() + 9 * 3600 * 1000);
  return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), ymd: d.toISOString().slice(0, 10) };
}

// Decide whether this class should be shuffled right now. Returns null (go) or a reason string (skip).
function skipReason(cls, state, now){
  const t = jst(now);
  if(!cls.days.includes(t.day)) return 'not a class day';
  const [h, m] = cls.start.split(':').map(Number);
  const start = h * 60 + m;
  if(t.minutes < start - WINDOW_BEFORE_MIN) return 'too early';
  if(t.minutes >= start - WINDOW_CLOSE_MIN) return 'seating window already open';
  if(state.shuffledAt){
    const ageH = (now.getTime() - new Date(state.shuffledAt).getTime()) / 3600000;
    if(ageH >= 0 && ageH < SKIP_IF_SHUFFLED_WITHIN_H) return 'already shuffled ' + ageH.toFixed(1) + ' h ago';
  }
  if(!state.roster || !state.roster.length) return 'empty roster';
  return null;
}

// Same rules as the teacher's Shuffle button. Returns only the fields that change.
function shuffleState(state, now, rng = Math.random){
  const s = JSON.parse(JSON.stringify(state));
  s.cols = s.cols || 9;
  s.rows = s.rows || ROOM_ROWS;
  s.seatEnabled = s.seatEnabled || {};
  const nowIso = now.toISOString();
  const out = { classDate: jst(now).ymd, updatedAt: nowIso, shuffledAt: nowIso };

  if(s.assignMode === 'groups'){
    const n = s.numGroups || 8;
    const names = shuffleArray([...s.roster], rng);
    const groups = {};
    for(let g = 1; g <= n; g++) groups[g] = [];
    names.forEach((name, i) => groups[(i % n) + 1].push(name));
    out.groupAssignments = groups;
    return out;
  }

  // Pad to the real 8-row room, as the page does.
  for(let r = s.rows; r < ROOM_ROWS; r++) for(let c = 0; c < s.cols; c++) s.seatEnabled[seatKey(r, c)] = false;
  s.rows = Math.max(s.rows, ROOM_ROWS);
  // Re-open seats the previous shuffle auto-blocked.
  (s.autoBlocked || []).forEach(k => { s.seatEnabled[k] = true; });

  const keys = [];
  for(let r = 0; r < s.rows; r++) for(let c = 0; c < s.cols; c++){
    const k = seatKey(r, c);
    if(s.seatEnabled[k] !== false) keys.push(k);
  }
  const names = shuffleArray([...s.roster], rng);
  const assignments = {};
  keys.forEach((k, i) => { if(names[i]) assignments[k] = names[i]; });
  const autoBlocked = keys.filter(k => !assignments[k]);
  autoBlocked.forEach(k => { s.seatEnabled[k] = false; });

  out.rows = s.rows;
  out.seatEnabled = s.seatEnabled;
  out.assignments = assignments;
  out.autoBlocked = autoBlocked;
  out.unseated = Math.max(0, names.length - keys.length);
  return out;
}

async function main(){
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run'), force = args.includes('--force');
  const nowArg = args.find(a => a.startsWith('--now='));
  const now = nowArg ? new Date(nowArg.slice(6)) : new Date();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw){ console.error('FIREBASE_SERVICE_ACCOUNT is not set.'); process.exit(1); }
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();

  let failed = false;
  for(const cls of CLASSES){
    try{
      const ref = db.collection('classes').doc(cls.id);
      const snap = await ref.get();
      if(!snap.exists){ console.log(cls.label + ': no data yet, skipped'); continue; }
      const state = snap.data();
      const why = force ? null : skipReason(cls, state, now);
      if(why){ console.log(cls.label + ': skipped (' + why + ')'); continue; }
      const out = shuffleState(state, now);
      const { unseated, ...toWrite } = out;
      if(dry){ console.log(cls.label + ': would shuffle ' + (toWrite.assignments ? Object.keys(toWrite.assignments).length + ' seats' : 'groups')); continue; }
      await ref.update(toWrite);
      console.log(cls.label + ': shuffled' + (unseated ? ' — WARNING ' + unseated + ' student(s) have no seat' : ''));
    }catch(e){
      failed = true;
      console.error(cls.label + ': FAILED', e && e.message ? e.message : e);
    }
  }
  if(failed) process.exit(1);
}

if(require.main === module) main();
module.exports = { shuffleState, skipReason, jst, CLASSES };
