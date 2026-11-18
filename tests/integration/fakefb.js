// 테스트용 가짜 Firebase Realtime DB (compat API 일부)
// 실제 RTDB처럼: 읽을 때 키 정렬, null·빈 객체·빈 배열 저장 안 함, 정수 키 객체는 배열로 돌려줌, 금지 문자 키/undefined 거부
function makeFakeFirebase(opts) {
  opts = opts || {};
  const BAD = /[.#$\[\]\/]/;
  const state = { tree: {}, listeners: [], hangTransactions: false, log: [] };

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function validate(v, where) {
    if (v === undefined) throw new Error('undefined value at ' + where);
    if (v && typeof v === 'object') {
      Object.keys(v).forEach(k => {
        if (!k || BAD.test(k)) throw new Error('invalid key "' + k + '" at ' + where);
        validate(v[k], where + '/' + k);
      });
    }
  }
  // 저장 형태: 배열 → 인덱스 키 객체, null/빈 값 제거
  function store(v) {
    if (v === null || v === undefined) return undefined;
    if (typeof v !== 'object') return v;
    const out = {}; let n = 0;
    Object.keys(v).forEach(k => { const c = store(v[k]); if (c !== undefined) { out[k] = c; n++; } });
    return n ? out : undefined;
  }
  // 읽기 형태: 키 정렬, 정수 키가 충분하면 배열
  function read(v) {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'object') return v;
    const keys = Object.keys(v).sort((a, b) => {
      const ia = /^\d+$/.test(a), ib = /^\d+$/.test(b);
      if (ia && ib) return Number(a) - Number(b);
      if (ia) return -1; if (ib) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const allInt = keys.length && keys.every(k => /^(0|[1-9]\d*)$/.test(k));
    if (allInt) {
      const max = Math.max(...keys.map(Number));
      if (keys.length * 2 > max) {
        const arr = []; for (let i = 0; i <= max; i++) arr.push(v[String(i)] === undefined ? null : read(v[String(i)]));
        return arr;
      }
    }
    const out = {}; keys.forEach(k => { out[k] = read(v[k]); }); return out;
  }
  function parts(p) { return String(p || '').split('/').filter(Boolean); }
  function getAt(p) { let cur = state.tree; for (const k of parts(p)) { if (!cur || typeof cur !== 'object') return undefined; cur = cur[k]; } return cur; }
  function setAt(p, v) {
    const ps = parts(p);
    if (!ps.length) { state.tree = store(v) || {}; return; }
    let cur = state.tree;
    for (let i = 0; i < ps.length - 1; i++) { if (!cur[ps[i]] || typeof cur[ps[i]] !== 'object') cur[ps[i]] = {}; cur = cur[ps[i]]; }
    const sv = store(v);
    if (sv === undefined) delete cur[ps[ps.length - 1]]; else cur[ps[ps.length - 1]] = sv;
  }
  function snap(p, v) { const val = read(v); return { key: parts(p).pop() || null, val: () => clone(val), exists: () => val !== null }; }
  function related(a, b) { const A = parts(a).join('/'), B = parts(b).join('/'); return A === B || A.startsWith(B + '/') || B.startsWith(A + '/') || !A || !B; }
  function notify(changed) {
    state.listeners.slice().forEach(l => { if (related(l.path, changed)) setTimeout(() => l.cb(snap(l.path, getAt(l.path))), 0); });
  }
  function ref(path) {
    const p = parts(path).join('/');
    return {
      on(ev, cb) {
        if (p === '.info/connected') { setTimeout(() => cb({ val: () => true }), 0); return cb; }
        if (p === '.info/serverTimeOffset') { setTimeout(() => cb({ val: () => 0 }), 0); return cb; }
        if (ev === 'value') { state.listeners.push({ path: p, cb }); setTimeout(() => cb(snap(p, getAt(p))), 0); }
        return cb;
      },
      off() {},
      once() { return new Promise(r => setTimeout(() => r(snap(p, getAt(p))), 0)); },
      set(v) { validate(v, p); state.log.push({ op: 'set', path: p }); setAt(p, clone(v)); notify(p); return Promise.resolve(); },
      update(obj) {
        Object.keys(obj).forEach(k => { parts(k).forEach(seg => { if (BAD.test(seg)) throw new Error('invalid path ' + k); }); validate(obj[k], p + '/' + k); });
        state.log.push({ op: 'update', path: p, keys: Object.keys(obj) });
        Object.keys(obj).forEach(k => setAt((p ? p + '/' : '') + k, clone(obj[k])));
        notify(p);
        return Promise.resolve();
      },
      transaction(fn, done) {
        if (state.hangTransactions) { state.log.push({ op: 'tx-hang', path: p }); return; }
        setTimeout(() => {
          const cur = read(getAt(p));
          const res = fn(clone(cur));
          if (res === undefined) { done && done(null, false, snap(p, getAt(p))); return; }
          validate(res, p); setAt(p, clone(res)); state.log.push({ op: 'tx', path: p });
          done && done(null, true, snap(p, getAt(p)));
          notify(p);
        }, 0);
      }
    };
  }
  const db = { ref };
  const firebase = { apps: [], initializeApp(cfg) { this.apps.push(cfg); return {}; }, database() { return db; } };
  // 기기마다 따로 쓰는 firebase 객체 (같은 DB 공유, 로그인 정보는 기기별)
  function forDevice(claims) {
    const user = claims ? { email: 'u@jisu.local', getIdToken: () => Promise.resolve('tok'), getIdTokenResult: () => Promise.resolve({ claims, token: 'tok-' + (claims.zone || claims.role || 'x') }) } : null;
    const auth = { currentUser: user, onAuthStateChanged(cb) { setTimeout(() => cb(user), 0); return () => {}; }, signOut() { return Promise.resolve(); } };
    return { apps: [], initializeApp(cfg) { this.apps.push(cfg); return {}; }, database() { return db; }, auth: () => auth };
  }
  return { firebase, forDevice, state, setServer: (p, v) => setAt(p, v), getServer: p => read(getAt(p)) };
}
module.exports = { makeFakeFirebase };
