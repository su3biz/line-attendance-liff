(() => {
  'use strict';
  const LIFF_ID = '2012227652-CgVMkyBb';
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbzWMpCtYx-ZQpu1duylWq5BBXT9UmXsie4hF3Vjcuj80q3GpVNHTEekLvInemris23S/exec';
  const INIT_TIMEOUT_MS = 30000;
  const REQUEST_TIMEOUT_MS = 30000;
  const result = document.getElementById('result');
  const initButton = document.getElementById('initialize');
  const verifyButton = document.getElementById('verify');
  let initialized = false;
  let busy = false;
  let authenticated = false;

  function show(message) { result.textContent = message; }
  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('timeout')), ms); })
    ]).finally(() => window.clearTimeout(timer));
  }

  async function ensureSdk() {
    if (!window.liff) {
      show('LINE SDKを読み込んでいます。');
      const deadline = Date.now() + 10000;
      while (!window.liff && Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 100));
      }
    }
    if (!window.liff) throw new Error('sdk-unavailable');
  }

  async function initialize() {
    if (busy) return;
    busy = true;
    initButton.disabled = true;
    verifyButton.disabled = true;
    show('操作を受け付けました。LIFF初期化を開始します。');
    try {
      await ensureSdk();
      if (!initialized) {
        show('LIFFを初期化しています。');
        await withTimeout(window.liff.init({ liffId: LIFF_ID }), INIT_TIMEOUT_MS);
        initialized = true;
      }
      if (!window.liff.isLoggedIn()) {
        show('LIFF初期化成功。LINEログインへ移動します。');
        window.liff.login();
        return;
      }
      show('LIFF初期化成功。LINEログイン済みです。本人認証テストはまだ実行していません。');
      verifyButton.disabled = false;
    } catch (_) {
      show('LIFF SDKまたは初期化に失敗、あるいは時間切れになりました。LIFF ID、SDK通信、Endpoint URLを確認してください。認証情報は表示していません。');
    } finally {
      busy = false;
      initButton.disabled = false;
    }
  }

  async function verifyIdentity() {
    if (busy || !initialized || authenticated) return;
    if (!window.liff.isInClient()) {
      show('安全のため、このテストはLINEアプリ内ブラウザからのみ実行できます。ID tokenは取得していません。');
      return;
    }
    if (!window.liff.isLoggedIn()) {
      show('LINEにログインしていません。先にLIFF初期化・ログイン状態を確認してください。');
      return;
    }
    if (typeof window.liff.getIDToken !== 'function') {
      show('ID token取得機能を利用できません。LIFFのopenid scope設定を確認してください。tokenは取得していません。');
      return;
    }
    const accepted = window.confirm('LINE ID tokenを確認済みの隔離GASへ送信し、LINE公式Verify APIで検証します。Google Apps Scriptの実行履歴や自動エラー記録に送信本文が残るかは未確認です。続行しますか？');
    if (!accepted) {
      show('キャンセルしました。ID tokenは取得・送信していません。');
      return;
    }

    busy = true;
    verifyButton.disabled = true;
    initButton.disabled = true;
    let idToken = null;
    show('ID tokenを取得し、隔離GASへ1回だけ送信しています。');
    try {
      idToken = window.liff.getIDToken();
      if (!idToken) {
        show('ID tokenを取得できませんでした。LIFFのopenid scope設定を確認してください。送信は行っていません。');
        return;
      }
      const body = new URLSearchParams({ id_token: idToken });
      const response = await withTimeout(fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
        redirect: 'follow',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store'
      }), REQUEST_TIMEOUT_MS);
      idToken = null;
      const payload = await response.json();
      if (!payload || typeof payload.verified !== 'boolean' && payload.verified !== null) {
        show('GASから想定外の応答を受け取りました。本人認証の成否は判定できません。');
      } else if (payload.verified === true) {
        authenticated = true;
        show('本人認証成功。LINE公式Verify APIがID tokenを有効と判定しました。');
      } else if (payload.verified === false) {
        show('本人認証失敗。LINE公式Verify APIがID tokenを無効と判定しました。');
      } else {
        show('本人認証の判定保留。GASはverified:nullを返しました。');
      }
      if (!response.ok) show('隔離GASへの通信でHTTPエラーが発生しました。本人認証の成否は判定できません。');
    } catch (_) {
      idToken = null;
      show('通信または応答の確認に失敗しました。GASの実行状況を確認してから再試行してください。tokenや内部エラーの詳細は表示していません。');
    } finally {
      idToken = null;
      busy = false;
      initButton.disabled = false;
      verifyButton.disabled = authenticated;
    }
  }

  initButton.addEventListener('click', initialize);
  verifyButton.addEventListener('click', verifyIdentity);
})();
