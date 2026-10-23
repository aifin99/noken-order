(function () {
  'use strict';

  var MAX_ITEMS = 5;
  var MAX_QTY = 999;
  var QTY_CHOICES = [1, 2, 3, 5, 10, 15, 20, 30];
  var master = null;
  var seq = 0;
  var sending = false;

  var $ = function (id) { return document.getElementById(id); };
  var yen = function (n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円'; };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // ---------- API（URL は config.js の window.NOKEN_CONFIG.apiUrl） ----------
  // GET ?api=master で商品などの情報、POST（本文は JSON 文字列）で注文。
  // Content-Type を text/plain にするのは、application/json だとブラウザが事前確認（preflight）を送り、API が応えられないため。
  // API は応答を 302 で別の URL に転送するので redirect: 'follow' で追う。
  var API_URL = (window.NOKEN_CONFIG && window.NOKEN_CONFIG.apiUrl) || '';

  function readJson(res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  function apiGet(api) {
    return fetch(API_URL + '?api=' + encodeURIComponent(api), { method: 'GET', redirect: 'follow', cache: 'no-store' })
      .then(readJson);
  }
  function apiPost(body) {
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).then(readJson);
  }

  // ---------- 起動 ----------
  function loadFailed() {
    $('loading').textContent = '読み込みに失敗しました。時間をおいて開き直してください。';
    $('loading').classList.add('is-error');
  }
  if (!API_URL) {
    loadFailed();
  } else {
    apiGet('master').then(function (m) {
      if (m && m.ok) start(m); else loadFailed();
    }).catch(loadFailed);
  }

  function start(m) {
    master = m;
    $('loading').hidden = true;
    if (!m.accepting) {
      $('stopMessage').textContent = m.stopMessage;
      $('stopped').hidden = false;
      return;
    }
    $('shippingNote').textContent = m.shippingNote;
    updateShippingNote();
    $('holidayNote').textContent = m.holidayNote || '';
    $('holidayNote').hidden = !m.holidayNote;
    $('rangeNote').hidden = true;
    setupConsentPanel(m);
    addItem();
    showPage('input');

    $('addItem').addEventListener('click', addItem);
    $('orderForm').addEventListener('submit', onConfirm);
    Array.prototype.forEach.call(document.querySelectorAll('input[name=receiveMethod]'), function (r) {
      r.addEventListener('change', function () { onReceiveChange(); clearErr('receiveMethod'); });
    });
    // 日付：選んだ時点で条件（最短日・定休日など）を確かめ、だめなら赤字で示す
    $('wishDate').addEventListener('change', function () { checkWishDate(true); });
    $('wishDate').addEventListener('input', function () { clearErr('wishDate'); });
    // 時間帯・支払方法のボタンは受取方法ごとに作り直すので、まとめて受ける
    $('wishTimeBox').addEventListener('change', function () { clearErr('wishTime'); });
    $('payMethodBox').addEventListener('change', function () { clearErr('payMethod'); });
    ['name', 'tel', 'address', 'note'].forEach(function (id) {
      $(id).addEventListener('input', function () { clearErr(id); });
    });
    $('note').addEventListener('input', function () { $('noteCount').textContent = $('note').value.length; });
    // 選択中の強調（:has() が使えない古いブラウザ向けに class でも付ける）
    $('orderForm').addEventListener('change', function (ev) {
      if (ev.target && ev.target.type === 'radio') syncChoice(ev.target.name);
    });

    // 入力ページ：同意のチェックが入るまで［入力内容を確認する］は押せない
    $('consent').addEventListener('change', function () {
      $('consent').parentNode.classList.toggle('on', $('consent').checked);
      if ($('consent').checked) clearErr('consent');
      updateInputBtn();
    });
    updateInputBtn();
    updateConfirmBtns();
    $('backBtn').addEventListener('click', backToInput);
    $('sendBtn').addEventListener('click', onSend);
    // 「内容を見る」は ① の同意欄と ② の「同意済み」の行の2か所。同じパネルを開く
    $('consentOpen').addEventListener('click', function () { openConsent(this); });
    $('consentOpen2').addEventListener('click', function () { openConsent(this); });
    $('consentClose').addEventListener('click', function () { closeConsent(true); });
    document.addEventListener('keydown', function (ev) {
      if ((ev.key === 'Escape' || ev.key === 'Esc') && !$('consentPanel').hidden) closeConsent(true);
    });
    window.addEventListener('popstate', onPopState);
  }

  // ---------- ページの切り替え（① 入力 → ② 確認 → ③ 完了） ----------
  // URL は変えずに表示を切り替える。② に入るときに履歴を1段積み、ブラウザの「戻る」で ① に戻れるようにする
  var page = '';
  var pushed = false;        // ② の履歴を積んでいるか
  var inputScrollY = 0;      // ① のスクロール位置（戻ったときに元の場所へ）

  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) { /* 使えなくてもよい */ }

  function showPage(p) {
    page = p;
    $('orderForm').hidden = p !== 'input';
    $('confirm').hidden = p !== 'confirm';
    $('done').hidden = p !== 'done';
    $('steps').hidden = false;
    Array.prototype.forEach.call($('steps').querySelectorAll('[data-step]'), function (s) {
      var cur = s.getAttribute('data-step') === p;
      s.classList.toggle('cur', cur);
      if (cur) s.setAttribute('aria-current', 'step'); else s.removeAttribute('aria-current');
    });
  }

  /** ① の［入力内容を確認する］：必須のチェックが通れば ② へ */
  function onConfirm(ev) {
    ev.preventDefault();
    if (page !== 'input') return;
    if (!validate()) return;
    inputScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    renderConfirm();
    clearErr('send');
    showPage('confirm');
    window.scrollTo(0, 0);
    try { history.pushState({ noken: 'confirm' }, ''); pushed = true; } catch (e) { pushed = false; }
  }

  /** ② の［戻る］：履歴を積んでいればブラウザの「戻る」と同じ動きにする（popstate で ① を出す） */
  function backToInput() {
    if (sending || page !== 'confirm') return;
    if (pushed) { history.back(); return; }
    showInput();
  }

  function showInput() {
    pushed = false;
    closeConsent(false);
    showPage('input');   // 入力内容も同意のチェックもそのまま
    window.scrollTo(0, inputScrollY);
  }

  function onPopState() {
    if (page !== 'confirm') return;            // ① ではそのままページを離れる。③ は表示を変えない
    if (sending) {                             // 送信中は ② に留まる（積み直す）
      try { history.pushState({ noken: 'confirm' }, ''); } catch (e) { /* 積めなくても ② のまま */ }
      return;
    }
    showInput();
  }

  /** ① の［入力内容を確認する］は同意のチェックが入るまで押せない。未チェックのあいだはバーに案内を出す */
  function updateInputBtn() {
    var ok = $('consent').checked;
    $('confirmBtn').disabled = !ok;
    $('consentHint').hidden = ok;
  }

  /** ② の［申し込む］はいつでも押せる（同意は ① で済んでいる）。送信中は［戻る］［申し込む］とも押せない */
  function updateConfirmBtns() {
    $('sendBtn').disabled = sending;
    $('backBtn').disabled = sending;
  }

  // ---------- 確認ページの一覧 ----------
  function receiveLabel(rv) { return (master.receive && master.receive[rv] && master.receive[rv].label) || '希望日時'; }
  function payLabel(rv, value) {
    var list = master.payMethods || [];
    for (var i = 0; i < list.length; i++) if (list[i].receive === rv && list[i].value === value) return list[i].label;
    return value;
  }

  function renderConfirm() {
    var total = 0;
    var rows = Array.prototype.map.call($('items').children, function (div, i) {
      var it = readItem(div);
      var p = findProduct(it.productId);
      var a = priceOf(it);
      if (a != null) total += a;
      return '<tr><td>' + (i + 1) + '. ' + esc(p ? p.name : '') + '<br>' + esc(it.finish) + '／' + esc(it.qty) + 'kg</td>' +
        '<td class="num">' + (a == null ? '―' : yen(a)) + '</td></tr>';
    }).join('');

    var rv = receiveMethod();
    var info = [
      ['合計金額', yen(total), 'strong'],
      ['お受け取り方法', rv],
      [receiveLabel(rv), dateDisp($('wishDate').value) + ' ' + wishTime()],
      ['お支払い方法', payLabel(rv, payMethod())],
      ['お名前', $('name').value.trim()],
      ['お電話番号', $('tel').value.trim()],
      ['メールアドレス', $('email').value.trim() || '（なし）']
    ];
    if (rv === SHIP) info.push(['ご住所', $('address').value.trim(), 'pre']);   // 住所は発送のときだけ
    info.push(['備考', $('note').value.trim() || '（なし）', 'pre']);

    var infoHtml = info.map(function (r) {
      var v = r[2] === 'strong' ? '<strong>' + esc(r[1]) + '</strong>' : esc(r[1]);
      return '<tr><th>' + esc(r[0]) + '</th><td' + (r[2] === 'pre' ? ' class="pre"' : '') + '>' + v + '</td></tr>';
    }).join('');
    // 送料の案内文は発送のときだけ
    var note = rv === SHIP && master.shippingNote ? '<p class="hint">' + esc(master.shippingNote) + '</p>' : '';

    $('confirmSummary').innerHTML =
      '<table class="sum-table">' + rows + '</table>' +
      note +
      '<table class="sum-table">' + infoHtml + '</table>';
  }

  // ---------- 個人情報の取り扱いのパネル（画面内に開く） ----------
  // PDF の URL があれば埋め込み（ドライブの共有リンクは API 側で埋め込み用に変換済み）、無ければ文章
  var consentPdf = '';
  var consentOpener = null;   // パネルを閉じたらフォーカスを戻すボタン

  function setupConsentPanel(m) {
    consentPdf = m.consentEmbedUrl || '';
    var pdf = !!consentPdf;
    $('consentPanel').classList.toggle('is-pdf', pdf);
    $('consentText').hidden = pdf;
    $('consentPdf').hidden = !pdf;
    $('consentNewWin').hidden = !pdf;
    if (pdf) {
      $('consentNewWin').href = m.consentOpenUrl || consentPdf;   // 埋め込めない環境の逃げ道（新しいタブ）
    } else {
      $('consentText').textContent = m.consentText || '';         // 改行はそのまま（CSS の pre-wrap）
    }
  }

  function openConsent(opener) {
    consentOpener = opener || $('consentOpen');
    $('consentPanel').hidden = false;
    document.documentElement.classList.add('panel-open');
    $('consentText').scrollTop = 0;
    // PDF は初めて開いたときに読み込む（開かない人には読み込ませない）
    if (consentPdf && $('consentFrame').getAttribute('src') !== consentPdf) $('consentFrame').setAttribute('src', consentPdf);
    try { $('consentTitle').setAttribute('tabindex', '-1'); $('consentTitle').focus(); } catch (e) { /* フォーカスできなくてもよい */ }
  }
  function closeConsent(focusBack) {
    $('consentPanel').hidden = true;
    document.documentElement.classList.remove('panel-open');
    if (focusBack && consentOpener) { try { consentOpener.focus(); } catch (e) { /* 同上 */ } }
  }

  /** 送料の案内文：ご来店のときは出さない。受取方法が未選択・発送なら出す */
  function updateShippingNote() {
    $('shippingNote').hidden = !master.shippingNote || receiveMethod() === VISIT;
  }

  /** 同じ name のラジオについて、選ばれている選択肢の枠に .on を付ける */
  function syncChoice(name) {
    Array.prototype.forEach.call(document.getElementsByName(name), function (r) {
      if (r.parentNode && r.parentNode.classList) r.parentNode.classList.toggle('on', r.checked);
    });
  }

  function findProduct(id) {
    for (var i = 0; i < master.products.length; i++) if (master.products[i].id === id) return master.products[i];
    return null;
  }

  // ---------- 明細 ----------
  function addItem() {
    var box = $('items');
    if (box.children.length >= MAX_ITEMS) return;
    var id = 'it' + (++seq);
    var div = document.createElement('div');
    div.className = 'item';
    div.id = id;

    var opts = '<option value="">選択してください</option>' + master.products.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
    }).join('');
    var qtyOpts = '<option value="">選択</option>' + QTY_CHOICES.map(function (q) {
      return '<option value="' + q + '">' + q + 'kg</option>';
    }).join('') + '<option value="other">その他</option>';

    div.innerHTML =
      '<div class="item-hd"><span class="no"></span><button type="button" class="btn-del">削除</button></div>' +
      '<label class="row"><span class="row-lbl">商品</span><select class="sel-product">' + opts + '</select></label>' +
      '<div class="row"><span class="row-lbl">仕上</span><div class="finish-box choices"><span class="hint">商品を選ぶと表示されます</span></div></div>' +
      '<div class="row qty-amt">' +
        '<div class="qty-col"><span class="row-lbl">数量</span>' +
          '<select class="sel-qty">' + qtyOpts + '</select>' +
          '<span class="qty-other" hidden><input type="number" class="in-qty" min="1" max="' + MAX_QTY + '" step="1" inputmode="numeric" placeholder="数量"><span>kg</span></span>' +
        '</div>' +
        '<div class="amt-col"><span class="row-lbl">小計</span><strong class="amt">―</strong></div>' +
      '</div>' +
      '<p class="err item-err" hidden></p>';
    box.appendChild(div);

    div.querySelector('.sel-product').addEventListener('change', function () { renderFinish(div); recalc(); });
    div.querySelector('.sel-qty').addEventListener('change', function () {
      var other = this.value === 'other';
      div.querySelector('.qty-other').hidden = !other;
      if (other) div.querySelector('.in-qty').focus();
      recalc();
    });
    div.querySelector('.in-qty').addEventListener('input', recalc);
    div.querySelector('.btn-del').addEventListener('click', function () {
      div.parentNode.removeChild(div);
      renumber();
      recalc();
    });
    renumber();
    recalc();
  }

  function renderFinish(div) {
    var p = findProduct(div.querySelector('.sel-product').value);
    var box = div.querySelector('.finish-box');
    if (!p) { box.innerHTML = '<span class="hint">商品を選ぶと表示されます</span>'; return; }
    var name = 'fin_' + div.id;
    box.innerHTML = p.finishes.map(function (f) {
      return '<label class="choice"><input type="radio" name="' + name + '" value="' + esc(f.finish) + '"' +
        (p.finishes.length === 1 ? ' checked' : '') + '><span>' + esc(f.finish) + '</span></label>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('input'), function (r) { r.addEventListener('change', recalc); });
    syncChoice(name);
  }

  function renumber() {
    var items = $('items').children;
    for (var i = 0; i < items.length; i++) items[i].querySelector('.no').textContent = '商品 ' + (i + 1);
    $('addItem').disabled = items.length >= MAX_ITEMS;
    if (items.length) clearErr('items');
  }

  /** 1明細の入力を読む。数量・仕上が決まっていなければ null を入れる */
  function readItem(div) {
    var productId = div.querySelector('.sel-product').value;
    var fin = div.querySelector('.finish-box input:checked');
    var qsel = div.querySelector('.sel-qty').value;
    var qty = null;
    if (qsel === 'other') {
      var raw = div.querySelector('.in-qty').value.trim();
      qty = /^\d+$/.test(raw) ? Number(raw) : NaN;
    } else if (qsel) {
      qty = Number(qsel);
    }
    return { productId: productId, finish: fin ? fin.value : '', qty: qty, qtyOther: qsel === 'other' };
  }

  function priceOf(it) {
    var p = findProduct(it.productId);
    if (!p || !it.finish || !(it.qty >= 1 && it.qty <= MAX_QTY)) return null;
    var f = null;
    p.finishes.forEach(function (x) { if (x.finish === it.finish) f = x; });
    if (!f) return null;
    return f.unitPrice * it.qty + (it.qty === 1 ? f.oneKgAdd : 0);
  }

  function recalc() {
    var total = 0;
    Array.prototype.forEach.call($('items').children, function (div) {
      var a = priceOf(readItem(div));
      div.querySelector('.amt').textContent = a == null ? '―' : yen(a);
      if (a != null) total += a;
    });
    $('total').textContent = yen(total);
  }

  // ---------- 受取方法・ご希望日時・支払方法 ----------
  var SHIP = '発送';
  var VISIT = 'ご来店';
  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  function receiveMethod() { var r = document.querySelector('input[name=receiveMethod]:checked'); return r ? r.value : ''; }
  function wishTime() { var r = document.querySelector('input[name=wishTime]:checked'); return r ? r.value : ''; }
  function payMethod() { var r = document.querySelector('input[name=payMethod]:checked'); return r ? r.value : ''; }

  /** ボタン型の選択肢（仕上と同じ .choice）を作る。items = [{ value, label }] */
  function choicesHtml(name, items) {
    return items.map(function (x) {
      return '<label class="choice"><input type="radio" name="' + name + '" value="' + esc(x.value) + '"><span>' + esc(x.label) + '</span></label>';
    }).join('');
  }

  /** 受取方法を切り替えたとき：見出し・日付の範囲・時間帯・支払方法・住所欄を入れ替える。時間帯と支払方法はクリア */
  function onReceiveChange() {
    var rv = receiveMethod();
    var opt = master.receive && master.receive[rv];
    if (!opt) return;
    var ship = rv === SHIP;

    $('wishSec').hidden = false;
    $('wishTitle').textContent = opt.label;
    $('wishDate').min = minDate(rv);
    $('wishDate').max = maxDate();
    $('rangeNote').textContent = rangeNote(rv);
    $('rangeNote').hidden = false;
    updateShippingNote();

    $('wishTimeBox').innerHTML = choicesHtml('wishTime', opt.times.map(function (t) { return { value: t, label: t }; }));
    // 来店の時間帯だけ1列（全幅）。発送は2列
    $('wishTimeBox').classList.toggle('one-col', rv === VISIT);
    clearErr('wishTime');

    var pays = (master.payMethods || []).filter(function (p) { return p.receive === rv; });
    $('payMethodBox').innerHTML = pays.length
      ? choicesHtml('payMethod', pays)
      : '<span class="hint">現在お選びいただけるお支払い方法がありません。</span>';
    clearErr('payMethod');

    $('addrField').hidden = !ship;
    if (!ship) clearErr('address');

    // 日付は残す。入っていれば新しい受取方法の条件で確かめ直す
    if ($('wishDate').value) checkWishDate(true); else clearErr('wishDate');
  }

  function todayStr() {
    if (master.today) return master.today;   // API が返す今日（日本時間）
    var d = new Date(), z = function (v) { return ('0' + v).slice(-2); };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    var t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (t.getUTCMonth() !== +m[2] - 1 || t.getUTCDate() !== +m[3]) return null;
    return { t: t, w: t.getUTCDay() };
  }
  function addDays(s, n) {
    var p = parseYmd(s), t = new Date(p.t.getTime() + n * 864e5), z = function (v) { return ('0' + v).slice(-2); };
    return t.getUTCFullYear() + '-' + z(t.getUTCMonth() + 1) + '-' + z(t.getUTCDate());
  }
  function dateDisp(s) { var p = parseYmd(s); return p ? s.replace(/-/g, '/') + '（' + WEEKDAYS[p.w] + '）' : ''; }
  /** 選べる最初の日：来店＝今日、発送＝今日＋発送の最短日数 */
  function minDate(rv) { return addDays(todayStr(), (master.receive[rv] && master.receive[rv].minDays) || 0); }
  /** 選べる最後の日：今日＋60日 */
  function maxDate() { return master.maxDate || addDays(todayStr(), 60); }
  function isClosedDay(s) { var p = parseYmd(s); return !!p && (master.closedDays || []).indexOf(p.w) >= 0; }
  /** 'yyyy-MM-dd' → '10月26日（月）' */
  function mdDisp(s) { var p = parseYmd(s); return p ? (p.t.getUTCMonth() + 1) + '月' + p.t.getUTCDate() + '日（' + WEEKDAYS[p.w] + '）' : ''; }
  /** 日付欄の下の案内：「○月○日（曜）から選べます（定休日：日曜）」 */
  function rangeNote(rv) {
    var s = minDate(rv), max = maxDate();
    while (s <= max && isClosedDay(s)) s = addDays(s, 1);     // 定休日なら次の日へ
    var closed = (master.closedDays || []).map(function (w) { return WEEKDAYS[w] + '曜'; }).join('・');
    var head = s <= max ? mdDisp(s) + 'から選べます' : '現在お選びいただける日がありません';
    return head + (closed ? '（定休日：' + closed + '）' : '');
  }

  /** 希望日のエラー文（問題なければ ''）。API 側でも同じ条件で確かめる */
  function wishDateError(rv, s) {
    var what = rv === SHIP ? '到着日' : '受取日';
    if (!s) return what + 'を選んでください。';
    var p = parseYmd(s);
    if (!p) return what + 'を正しく選んでください。';
    var min = minDate(rv);
    if (s < min) return rv === SHIP ? what + 'は' + dateDisp(min) + '以降の日付をお選びください。' : what + 'は今日以降の日付をお選びください。';
    var max = maxDate();
    if (s > max) return what + 'は' + dateDisp(max) + 'までの日付をお選びください。';
    if ((master.closedDays || []).indexOf(p.w) >= 0) return WEEKDAYS[p.w] + '曜日は定休日のためお選びいただけません。';
    return '';
  }
  /** 日付欄を確かめる。show=true ならエラーを出す。OK なら true */
  function checkWishDate(show) {
    var rv = receiveMethod();
    if (!rv) return false;
    var msg = wishDateError(rv, $('wishDate').value);
    if (msg && show) showErr('wishDate', msg); else if (!msg) clearErr('wishDate');
    return !msg;
  }

  // ---------- エラー表示 ----------
  var FIELD_BOX = { receiveMethod: 'receiveBox', wishDate: 'wishDate', wishTime: 'wishTimeBox', payMethod: 'payMethodBox', name: 'name', tel: 'tel', address: 'address', note: 'note', consent: 'consentBox' };

  function showErr(key, msg) {
    var p = $('err-' + key);
    if (p) { p.textContent = msg; p.hidden = false; }
    var el = FIELD_BOX[key] && $(FIELD_BOX[key]);
    if (el) el.classList.add('invalid');
  }
  function clearErr(key) {
    var p = $('err-' + key);
    if (p) { p.textContent = ''; p.hidden = true; }
    var el = FIELD_BOX[key] && $(FIELD_BOX[key]);
    if (el) el.classList.remove('invalid');
  }
  function clearAllErr() {
    ['items', 'receiveMethod', 'wishDate', 'wishTime', 'payMethod', 'name', 'tel', 'address', 'note', 'consent', 'submit'].forEach(clearErr);
    Array.prototype.forEach.call(document.querySelectorAll('.item .invalid'), function (el) { el.classList.remove('invalid'); });
    Array.prototype.forEach.call(document.querySelectorAll('.item-err'), function (el) { el.hidden = true; el.textContent = ''; });
  }

  function itemErr(div, el, msg) {
    if (el) el.classList.add('invalid');
    var p = div.querySelector('.item-err');
    p.textContent = (p.textContent ? p.textContent + '\n' : '') + msg;
    p.hidden = false;
  }

  /** ① の必須チェック。NG の項目を赤く示して false を返す */
  function validate() {
    clearAllErr();
    var ok = true;
    var divs = $('items').children;
    if (!divs.length) { showErr('items', '商品を1つ以上追加してください。'); ok = false; }
    Array.prototype.forEach.call(divs, function (div) {
      var it = readItem(div);
      if (!it.productId) { itemErr(div, div.querySelector('.sel-product'), '商品を選んでください。'); ok = false; }
      else if (!it.finish) { itemErr(div, div.querySelector('.finish-box'), '仕上を選んでください。'); ok = false; }
      if (it.qty === null) { itemErr(div, div.querySelector('.sel-qty'), '数量を選んでください。'); ok = false; }
      else if (!(it.qty >= 1 && it.qty <= MAX_QTY)) {
        itemErr(div, it.qtyOther ? div.querySelector('.in-qty') : div.querySelector('.sel-qty'), '数量は1〜' + MAX_QTY + 'kgの整数で入力してください。');
        ok = false;
      }
    });
    var rv = receiveMethod();
    if (!rv) { showErr('receiveMethod', 'お受け取り方法を選んでください。'); ok = false; }
    else {
      if (!checkWishDate(true)) ok = false;
      if (!wishTime()) { showErr('wishTime', '時間帯を選んでください。'); ok = false; }
    }
    if (!payMethod()) { showErr('payMethod', 'お支払い方法を選んでください。'); ok = false; }
    if (!$('name').value.trim()) { showErr('name', 'お名前を入力してください。'); ok = false; }
    if (!$('tel').value.trim()) { showErr('tel', '電話番号を入力してください。'); ok = false; }
    if (rv === SHIP && !$('address').value.trim()) { showErr('address', '発送の場合はご住所を入力してください。'); ok = false; }
    if ($('note').value.length > 200) { showErr('note', '備考は200字までです。'); ok = false; }
    // 同意前はボタンが押せないので通常は出ない（念のため）
    if (!$('consent').checked) { showErr('consent', '同意が必要です。'); ok = false; }
    if (!ok) {
      showErr('submit', '入力内容をご確認ください（赤字の箇所）。');
      var first = document.querySelector('#orderForm .invalid, #orderForm .err:not([hidden])');
      if (first && first.scrollIntoView) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return ok;
  }

  // ---------- 送信（② の［申し込む］） ----------
  function onSend() {
    if (sending || page !== 'confirm') return;
    // 同意は ① で済んでいる（同意しないと ② に進めない）。念のため確かめる
    if (!$('consent').checked) { showErr('send', '入力ページで個人情報の取り扱いに同意してください。'); return; }
    clearErr('send');

    var payload = {
      api: 'order',
      items: Array.prototype.map.call($('items').children, function (div) {
        var it = readItem(div);
        return { productId: it.productId, finish: it.finish, qty: it.qty };   // 金額は送らない
      }),
      receiveMethod: receiveMethod(),
      wishDate: $('wishDate').value,
      wishTime: wishTime(),
      payMethod: payMethod(),
      name: $('name').value,
      tel: $('tel').value,
      email: $('email').value,
      address: receiveMethod() === SHIP ? $('address').value : '',   // ご来店では住所を送らない
      note: $('note').value,
      consent: $('consent').checked === true   // 個人情報の取り扱いへの同意（API でも確かめる）
    };

    setSending(true);
    apiPost(payload).then(function (res) {
      if (res && res.ok) { showDone(res); return; }
      setSending(false);
      showErr('send', (res && res.message) || '送信できませんでした。');
    }).catch(function () {
      setSending(false);
      showErr('send', '送信できませんでした。通信状況をご確認のうえ、もう一度お試しください。');
    });
  }

  function setSending(on) {
    sending = on;
    var b = $('sendBtn');
    b.classList.toggle('is-sending', on);
    b.textContent = on ? '送信中…' : '申し込む';
    updateConfirmBtns();
  }

  /** ③ 完了：受付番号だけを出す */
  function showDone(res) {
    closeConsent(false);
    $('doneNo').textContent = res.receiptNo;
    showPage('done');
    window.scrollTo(0, 0);
  }

  // ---------- 完了ページの「閉じる」 ----------
  // window.close() を試し、閉じられなければ案内文を出す。
  // LINE 内ブラウザや、URL を直接開いたタブはスクリプトから閉じられないので、多くの環境で案内文が出る。
  var CLOSE_CHECK_MS = 400;

  function isClosed() {
    try { if (window.closed) return true; } catch (e) { /* 判定できなければ閉じていない扱い */ }
    try { if (window.top && window.top.closed) return true; } catch (e) { /* 同上 */ }
    return false;
  }

  $('closeBtn').addEventListener('click', function () {
    $('closeHint').hidden = true;
    try { window.close(); } catch (e) { /* 閉じられない環境 */ }
    try { if (window.top && window.top !== window) window.top.close(); } catch (e) { /* 同上 */ }
    setTimeout(function () {
      // ここまで画面が残っていれば閉じられなかった
      if (!isClosed()) $('closeHint').hidden = false;
    }, CLOSE_CHECK_MS);
  });
})();
