(() => {
  'use strict';
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbzWMpCtYx-ZQpu1duylWq5BBXT9UmXsie4hF3Vjcuj80q3GpVNHTEekLvInemris23S/exec';
  const result = document.getElementById('result');
  const button = document.getElementById('probe');
  const PROBE = 'codex-fixed-probe-v1';

  button.addEventListener('click', async () => {
    if (!window.confirm('固定文字列だけを隔離GASへ送信します。LINE ID tokenや個人情報は扱いません。続行しますか？')) return;
    button.disabled = true;
    result.textContent = '固定文字列を送信し、リダイレクト後の応答を確認しています。';
    try {
      const response = await fetch(GAS_URL, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ probe: PROBE }).toString(),
        redirect: 'follow',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store'
      });
      const raw = await response.text();
      let payload;
      try {
        payload = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
      } catch (_) {
        result.textContent = '応答本文は届きましたが、JSONではありませんでした。HTTP状態は ' + response.status + ' です。';
        return;
      }
      if (response.ok && payload && payload.probe === PROBE && payload.received === true) {
        result.textContent = '成功：固定文字列のPOSTとJSON応答読取を確認しました。本人認証の成功を意味しません。';
      } else {
        result.textContent = 'JSON応答を読み取りましたが、固定文字列の確認形式と一致しません。HTTP状態は ' + response.status + ' です。';
      }
    } catch (_) {
      result.textContent = '通信または応答読取に失敗しました。CSP、CORS、ネットワーク、リダイレクト後の接続先を確認してください。トークンや内部エラーは表示していません。';
    } finally {
      button.disabled = false;
    }
  });
})();
