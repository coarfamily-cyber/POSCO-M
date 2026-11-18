/* 지수 대시보드 인증 게이트 (1단계)
   · window.JISU_AUTH_GATE === true 일 때만 동작합니다. 기본값은 꺼짐이라 기존 화면·동기화에 영향이 없습니다.
   · 로그인하지 않으면 전체 화면을 가리는 로그인 창을 보여 줍니다. 로그인하면 창이 사라지고 기존 기능을 그대로 씁니다.
   · 계정 이름 = 사번. 내부 주소는 사번@jisu.local 이며, 실제 메일은 사용하지 않습니다.
   · 보안 규칙은 이 단계에서 바꾸지 않습니다. 이 파일은 화면 게이트만 담당합니다.
   · 승인(custom claim approved === true) 이 없으면 "승인 대기" 를 보여 주고 기능을 가립니다. */
(function(){
  'use strict';
  if (window.JISU_AUTH_GATE !== true) return;

  var DOMAIN = 'jisu.local';
  var GATE_ID = 'jisuAuthGate';
  var MSG = {
    'auth/invalid-credential': '사번 또는 비밀번호가 맞지 않습니다.',
    'auth/wrong-password': '사번 또는 비밀번호가 맞지 않습니다.',
    'auth/user-not-found': '사번 또는 비밀번호가 맞지 않습니다.',
    'auth/invalid-email': '사번을 확인해 주세요.',
    'auth/user-disabled': '비활성화된 계정입니다. 관리자에게 문의하세요.',
    'auth/too-many-requests': '시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
    'auth/network-request-failed': '네트워크 연결을 확인해 주세요.'
  };

  function toEmail(id){ return String(id || '').trim() + '@' + DOMAIN; }
  function msgOf(err){ return (err && MSG[err.code]) || '로그인에 실패했습니다. 다시 시도하세요.'; }

  function injectStyle(){
    var st = document.createElement('style');
    st.textContent =
      '#' + GATE_ID + '{position:fixed;inset:0;z-index:2147483646;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(2,6,23,.92);color:#f8fafc;font-family:inherit;}' +
      '#' + GATE_ID + '.is-open{display:flex;}' +
      '#' + GATE_ID + ' .jag-box{width:100%;max-width:340px;box-sizing:border-box;padding:22px 18px;border-radius:18px;background:#0f172a;border:1px solid rgba(148,163,184,.3);}' +
      '#' + GATE_ID + ' h2{margin:0 0 4px;font-size:17px;font-weight:900;}' +
      '#' + GATE_ID + ' .jag-sub{margin:0 0 14px;font-size:12px;color:#94a3b8;line-height:1.5;}' +
      '#' + GATE_ID + ' label{display:block;margin:10px 0 4px;font-size:12px;font-weight:800;color:#cbd5e1;}' +
      '#' + GATE_ID + ' input{width:100%;box-sizing:border-box;height:42px;padding:0 12px;border-radius:10px;border:1px solid rgba(148,163,184,.4);background:#020617;color:#f8fafc;font-size:15px;}' +
      '#' + GATE_ID + ' .jag-btn{width:100%;height:44px;margin-top:16px;border:0;border-radius:12px;background:linear-gradient(135deg,#f3d478,#d4af37);color:#0f172a;font-size:14px;font-weight:900;cursor:pointer;}' +
      '#' + GATE_ID + ' .jag-btn:disabled{opacity:.6;cursor:default;}' +
      '#' + GATE_ID + ' .jag-err{min-height:18px;margin:10px 0 0;font-size:12px;font-weight:700;color:#fca5a5;}' +
      '#jisuAuthLogout{position:fixed;right:12px;bottom:12px;z-index:2147483000;display:none;padding:6px 10px;border-radius:9999px;border:1px solid rgba(255,255,255,.25);background:rgba(15,23,42,.85);color:#e2e8f0;font-size:11px;font-weight:800;cursor:pointer;}';
    document.head.appendChild(st);
  }

  function buildGate(){
    var g = document.createElement('div');
    g.id = GATE_ID;
    g.setAttribute('role', 'dialog');
    g.setAttribute('aria-label', '로그인');
    g.innerHTML =
      '<form class="jag-box" id="jisuAuthForm" autocomplete="on">' +
        '<h2 id="jisuAuthTitle">지수 관제 로그인</h2>' +
        '<p class="jag-sub" id="jisuAuthSub">사번과 비밀번호를 입력하세요.</p>' +
        '<label for="jisuAuthId">사번</label>' +
        '<input id="jisuAuthId" name="username" type="text" inputmode="numeric" autocomplete="username" required>' +
        '<label for="jisuAuthPw">비밀번호</label>' +
        '<input id="jisuAuthPw" name="password" type="password" autocomplete="current-password" required>' +
        '<button type="submit" class="jag-btn" id="jisuAuthOk">로그인</button>' +
        '<p class="jag-err" id="jisuAuthErr" role="alert"></p>' +
      '</form>';
    document.body.appendChild(g);
    return g;
  }

  function setGate(open, opts){
    var g = document.getElementById(GATE_ID);
    if (!g) return;
    g.classList.toggle('is-open', !!open);
    var title = document.getElementById('jisuAuthTitle');
    var sub = document.getElementById('jisuAuthSub');
    var form = document.getElementById('jisuAuthForm');
    var err = document.getElementById('jisuAuthErr');
    var btn = document.getElementById('jisuAuthOk');
    opts = opts || {};
    if (title) title.textContent = opts.title || '지수 관제 로그인';
    if (sub) sub.textContent = opts.sub || '사번과 비밀번호를 입력하세요.';
    if (form) form.style.display = opts.hideForm ? 'none' : '';
    if (err) err.textContent = opts.err || '';
    if (btn) btn.disabled = false;
  }

  function showLogout(show){
    var b = document.getElementById('jisuAuthLogout');
    if (b) b.style.display = show ? 'block' : 'none';
  }

  function start(){
    if (typeof window.firebase === 'undefined' || !window.firebase.auth) {
      console.warn('[jisu-auth] Firebase Auth SDK 가 없어 로그인 게이트를 열 수 없습니다.');
      injectStyle(); buildGate();
      setGate(true, { title: '연결 오류', sub: '인증 모듈을 불러오지 못했습니다. 새로고침 해 주세요.', hideForm: true });
      return;
    }
    try {
      if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(window.JISU_FIREBASE_CONFIG);
    } catch (e) { /* 이미 초기화된 경우 무시 */ }

    var auth = firebase.auth();
    injectStyle(); buildGate();
    // 로그인 상태를 확인하는 동안에는 앱을 가려 둔다 (앱이 잠깐 보이는 것을 막음)
    setGate(true, { title: '확인 중', sub: '잠시만 기다려 주세요.', hideForm: true });
    var resolved = false;
    setTimeout(function(){
      if (!resolved) setGate(true, { title: '연결 확인 실패', sub: '네트워크를 확인한 뒤 새로고침 해 주세요.', hideForm: true });
    }, 8000);

    var lo = document.createElement('button');
    lo.id = 'jisuAuthLogout'; lo.type = 'button'; lo.textContent = '로그아웃';
    document.body.appendChild(lo);
    lo.addEventListener('click', function(){ auth.signOut(); });

    document.getElementById('jisuAuthForm').addEventListener('submit', function(e){
      e.preventDefault();
      var id = document.getElementById('jisuAuthId').value;
      var pw = document.getElementById('jisuAuthPw').value;
      var btn = document.getElementById('jisuAuthOk');
      btn.disabled = true;
      auth.signInWithEmailAndPassword(toEmail(id), pw).catch(function(err){
        btn.disabled = false;
        setGate(true, { err: msgOf(err) });
      });
    });

    auth.onAuthStateChanged(function(user){
      resolved = true;
      if (!user) {
        showLogout(false);
        setGate(true, {});
        return;
      }
      // 승인 여부는 토큰의 custom claim(approved) 으로 확인한다 (토큰을 새로 받아서 최신 값 사용)
      user.getIdTokenResult(true).then(function(res){
        var c = (res && res.claims) || {};
        var approved = c.approved === true || c.role === 'admin';   // 관리자 계정은 승인 표시가 없어도 통과
        if (approved) {
          setGate(false, {});
          showLogout(true);
        } else {
          showLogout(true);
          setGate(true, {
            title: '승인 대기 중',
            sub: '사번 ' + (user.email || '').split('@')[0] + ' 계정은 관리자 승인 후 사용할 수 있습니다.',
            hideForm: true
          });
        }
      }).catch(function(){
        setGate(true, { err: '권한 확인에 실패했습니다. 다시 로그인하세요.' });
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
