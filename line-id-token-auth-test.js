(() => {
  'use strict';
  const LIFF_ID = '2012227652-CgVMkyBb';
  const INIT_TIMEOUT_MS = 30000;
  const result = document.getElementById('result');
  const button = document.getElementById('verify');
  let initialized = false;
  let busy = false;

  function show(message) { result.textContent = message; }
  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('timeout')), ms); })
    ]).finally(() => window.clearTimeout(timer));
  }

  async function start() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    show('ボタン操作を受け付けました。LIFF初期化を開始します。');
    try {
      if (!window.liff) {
        show('LINE SDKを読み込んでいます。');
        const deadline = Date.now() + 10000;
        while (!window.liff && Date.now() < deadline) {
          await new Promise(resolve => window.setTimeout(resolve, 100));
        }
      }
      if (!window.liff) throw new Error('sdk-unavailable');
      if (!initialized) {
        show('LIFFを初期化しています。ID tokenは取得・送信しません。');
        await withTimeout(window.liff.init({ liffId: LIFF_ID }), INIT_TIMEOUT_MS);
        initialized = true;
      }
      if (!window.liff.isLoggedIn()) {
        show('LIFFを初期化しました。LINEログインへ移動します。');
        window.liff.login();
        return;
      }
      show('LIFF初期化成功。LINEログイン済みです。ID tokenの取得・送信は行っていません。');
      button.textContent = '初期化状態を再確認';
    } catch (_) {
      show('LIFF初期化に失敗、または時間切れになりました。LIFF ID、LINE SDK通信、LIFF Endpoint URLとこの公開ページのURLを確認してください。認証情報は表示していません。');
    } finally {
      busy = false;
      button.disabled = false;
    }
  }
  button.addEventListener('click', start);
})();
