'use strict';
'require view';
'require request';

function el(tag, attrs, children) {
  const n = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(k => n.setAttribute(k, attrs[k]));
  (children || []).forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return n;
}

function isIntLike(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return true;
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+$/.test(v.trim())) return true;
  return false;
}

function toInt(v) {
  if (typeof v === 'number') return v | 0;
  return parseInt(String(v).trim(), 10);
}

/** Robust LuCI URL builder */
function luciUrl(path) {
  let base = (typeof L !== 'undefined' && L.env && (L.env.dispatcher_base || L.env.cgi_base)) || '';
  if (!base) base = '/cgi-bin/luci';
  if (base === '/cgi-bin') base = '/cgi-bin/luci';
  if (!path.startsWith('/')) path = '/' + path;
  return base + path;
}

function parseCopsResponse(text) {
  if (!text || typeof text !== 'string') return [];
  const groups = text.match(/\([^\)]*\)/g);
  if (!groups) return [];

  return groups
    .map(g => g.slice(1, -1))
    .map(inner => {
      const tokens = inner.match(/"[^"]*"|[^,]+/g) || [];
      return tokens.map(t => t.trim()).map(t => {
        if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
        if (/^-?\d+$/.test(t)) return parseInt(t, 10);
        return t;
      });
    })
    .filter(arr => arr.length >= 4 && typeof arr[3] === 'string' && /^\d+$/.test(arr[3]));
}

/** signal -> 0..4 bars clamp */
function signalToBars(sig) {
  if (!isIntLike(sig)) return 0;
  const v = toInt(sig);
  if (v <= 0) return 0;
  if (v >= 4) return 4;
  return v;
}

function makeSignalIcon(sig) {
  const bars = signalToBars(sig);
  const wrap = el('span', { 'class': 'ms-signal' }, []);
  for (let i = 1; i <= 4; i++) {
    wrap.appendChild(el('span', {
      'class': 'ms-bar' + (i <= bars ? ' on' : ''),
      'data-b': String(i)
    }, []));
  }
  wrap.title = isIntLike(sig) ? `Signal: ${sig}` : 'Signal: n/a';
  return wrap;
}

function extractModemResponse(json) {
  return json?.data?.result?.response ?? '';
}

function responseHasOK(resp) {
  if (!resp || typeof resp !== 'string') return false;
  return /\r?\nOK\r?\n/i.test(resp) || /(^|\s)OK(\s|$)/i.test(resp);
}

/** Fix “weird ?” / object errors */
function prettyError(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;

  // LuCI request errors sometimes include status fields
  if (e.status) return `HTTP ${e.status} ${e.statusText || ''}`.trim();
  if (e.responseText) return String(e.responseText).slice(0, 200);

  try { return JSON.stringify(e); } catch (_) {}
  return String(e);
}

/* -------------------- Toasts (sticky until updated) -------------------- */

function createToastHost() {
  return el('div', { id: 'ms-toast-host' }, []);
}

function toastCreate(host, msg, type) {
  const t = el('div', { class: `ms-toast ms-${type || 'info'}` }, [
    el('div', { class: 'ms-toast-msg' }, [String(msg)])
  ]);
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  return t;
}

function toastSet(t, msg, type) {
  if (!t) return;
  t.className = `ms-toast ms-${type || 'info'} show`;
  const msgEl = t.querySelector('.ms-toast-msg');
  if (msgEl) msgEl.textContent = String(msg);
}

function toastClose(t) {
  if (!t) return;
  t.classList.remove('show');
  setTimeout(() => {
    if (t.parentNode) t.parentNode.removeChild(t);
  }, 250);
}

function toastUpdateAndClose(t, msg, type, delayMs) {
  toastSet(t, msg, type);
  setTimeout(() => toastClose(t), typeof delayMs === 'number' ? delayMs : 2500);
}

/* Operator name helper */
function operatorNameFromTuple(t) {
  if (!t) return 'Unknown operator';
  const opLong = (t[1] ?? '').toString().trim();
  const opShort = (t[2] ?? '').toString().trim();
  const plmn = (t[3] ?? '').toString().trim();
  return opLong || opShort || plmn || 'Unknown operator';
}

return view.extend({
  load: function () { return Promise.resolve(); },

  render: function () {
    const root = el('div', { id: 'mobilescan-app' }, []);
    const toastHost = createToastHost();

    const style = el('style', {}, [`
      /* Hide Save/Apply/Reset bars */
      .cbi-page-actions, .cbi-section-actions, .cbi-map > .cbi-page-actions { display:none !important; }

      /* Toast host */
      #ms-toast-host{
        position:fixed; right:18px; top:18px; z-index:9999;
        display:flex; flex-direction:column; gap:10px; max-width:420px;
        pointer-events:none;
      }
      .ms-toast{
        pointer-events:none;
        border-radius:10px; padding:10px 12px;
        box-shadow:0 10px 24px rgba(0,0,0,0.18);
        transform:translateY(-6px); opacity:0;
        transition:opacity 200ms ease, transform 200ms ease;
        font-size:13px; line-height:1.35;
        background:#fff; color:#222;
        border-left:4px solid rgba(0,0,0,0.25);
      }
      .ms-toast.show{ opacity:1; transform:translateY(0); }
      .ms-toast.ms-info{ border-left-color:#3b82f6; }
      .ms-toast.ms-success{ border-left-color:#16a34a; }
      .ms-toast.ms-error{ border-left-color:#dc2626; }
      .ms-toast-msg{ white-space:pre-wrap; }

      /* Table */
      #mobilescan-app table.ms-table{ width:100%; table-layout:fixed; border-collapse:collapse; }
      #mobilescan-app table.ms-table th, #mobilescan-app table.ms-table td{
        vertical-align:middle; padding:8px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      #mobilescan-app .col-select{ width:110px; text-align:center; }
      #mobilescan-app .col-operator{ text-align:left; }
      #mobilescan-app .col-plmn{ width:120px; text-align:left; }
      #mobilescan-app .col-signal{ width:110px; text-align:center; }

      #mobilescan-app tr.ms-selected td{ background:rgba(0,0,0,0.06); }
      #mobilescan-app input[type="radio"]{ transform:translateY(1px); }

      /* Signal icon */
      #mobilescan-app .ms-signal{ display:inline-flex; align-items:flex-end; justify-content:center; gap:2px; height:14px; }
      #mobilescan-app .ms-bar{ width:3px; background:rgba(0,0,0,0.18); border-radius:1px; display:inline-block; }
      #mobilescan-app .ms-bar[data-b="1"]{ height:4px; }
      #mobilescan-app .ms-bar[data-b="2"]{ height:7px; }
      #mobilescan-app .ms-bar[data-b="3"]{ height:10px; }
      #mobilescan-app .ms-bar[data-b="4"]{ height:13px; }
      #mobilescan-app .ms-bar.on{ background:rgba(0,0,0,0.65); }

      #mobilescan-app .ms-empty{ color:rgba(0,0,0,0.55); font-style:italic; }
    `]);

    const scanBtn = el('button', { class: 'cbi-button cbi-button-action' }, ['Scan Network']);
    const connectBtn = el('button', { class: 'cbi-button cbi-button-positive', disabled: 'disabled', style: 'margin-left:10px;' }, ['Connect']);
    const revertBtn = el('button', { class: 'cbi-button cbi-button-neutral', style: 'margin-left:10px;' }, ['Auto Select Network']);
    const spinner = el('span', { style: 'margin-left:10px; display:none;' }, ['?']);

    const tableWrap = el('div', { style: 'margin-top:15px;' }, []);
    const table = el('table', { class: 'table ms-table' }, []);
    tableWrap.appendChild(table);

    let tuples = [];
    let selectedIndex = -1;
    let selectedFirst = null;
    let selectedFourth = null; // PLMN
    let rowEls = [];
    let isScanning = false;
    let isBusyAction = false;

    function setBusyScan(state) {
      scanBtn.disabled = state;
      spinner.style.display = state ? 'inline' : 'none';
      isScanning = state;
    }

    function setBusyActionState(state) {
      isBusyAction = state;
      revertBtn.disabled = state;
      scanBtn.disabled = state || isScanning;
      if (state) connectBtn.disabled = true;
      else setConnectEnabledByRule();
    }

    function setConnectEnabledByRule() {
      if (isIntLike(selectedFirst)) {
        const v = toInt(selectedFirst);
        if (v >= 0 && v <= 2 && !isBusyAction && !isScanning)
          connectBtn.removeAttribute('disabled');
        else
          connectBtn.setAttribute('disabled', 'disabled');
      } else {
        connectBtn.setAttribute('disabled', 'disabled');
      }
    }

    function highlightRow(idx) {
      rowEls.forEach((tr, i) => tr && tr.classList.toggle('ms-selected', i === idx));
    }

    function updateSelection(idx) {
      const t = tuples[idx];
      if (!t) return;
      selectedIndex = idx;
      selectedFirst = t[0];
      selectedFourth = t[3];
      highlightRow(idx);
      setConnectEnabledByRule();
    }

    function renderTable() {
      table.innerHTML = '';
      rowEls = [];

      const thead = el('thead', {}, [
        el('tr', {}, [
          el('th', { class: 'col-select' }, ['Select']),
          el('th', { class: 'col-operator' }, ['Operator']),
          el('th', { class: 'col-plmn' }, ['PLMN']),
          el('th', { class: 'col-signal' }, ['Signal'])
        ])
      ]);

      const tbody = el('tbody');

      if (!tuples.length) {
        tbody.appendChild(el('tr', {}, [
          el('td', { colspan: '4', class: 'ms-empty' }, ['No scan results yet. Click "Scan Network".'])
        ]));
      } else {
        tuples.forEach((t, i) => {
          const plmn = t[3] ?? '';
          const signal = t[4];
          const name = operatorNameFromTuple(t);

          const radio = el('input', { type: 'radio', name: 'mobnet_choice', value: String(i) });
          if (i === selectedIndex) radio.checked = true;

          const tr = el('tr', { style: 'cursor:pointer;' }, [
            el('td', { class: 'col-select' }, [radio]),
            el('td', { class: 'col-operator' }, [String(name)]),
            el('td', { class: 'col-plmn' }, [String(plmn)]),
            el('td', { class: 'col-signal' }, [makeSignalIcon(signal)])
          ]);

          rowEls[i] = tr;
          if (i === selectedIndex) tr.classList.add('ms-selected');

          tr.addEventListener('click', function () { radio.checked = true; updateSelection(i); });
          radio.addEventListener('change', function () { if (radio.checked) updateSelection(i); });

          tbody.appendChild(tr);
        });
      }

      table.appendChild(thead);
      table.appendChild(tbody);
    }

    renderTable();

    async function doScan() {
      if (isScanning || isBusyAction) {
        const t = toastCreate(toastHost, 'Please wait... operation in progress.', 'info');
        toastUpdateAndClose(t, 'Please wait... operation in progress.', 'info', 2200);
        return;
      }

      const t = toastCreate(toastHost, 'Scanning mobile networks... waiting for modem response', 'info');

      try {
        setBusyScan(true);

        tuples = [];
        selectedIndex = -1;
        selectedFirst = null;
        selectedFourth = null;
        highlightRow(-1);
        setConnectEnabledByRule();
        renderTable();

        const res = await request.get(luciUrl('admin/network/mobilescan/scan'), { cache: false });
        const json = res.json();

        if (!json || json.ok !== true) {
          toastUpdateAndClose(t, `Scan failed: ${json?.error || 'unknown error'}`, 'error', 4500);
          return;
        }

        const responseText = extractModemResponse(json);
        tuples = parseCopsResponse(responseText);

        renderTable();

        if (!tuples.length) {
          toastUpdateAndClose(t, 'Scan finished but no networks were found (or parse failed).', 'error', 4500);
          return;
        }

        toastUpdateAndClose(t, `Scan complete: found ${tuples.length} network(s).`, 'success', 2800);
      } catch (e) {
        toastUpdateAndClose(t, `Scan error: ${prettyError(e)}`, 'error', 4500);
      } finally {
        setBusyScan(false);
        setConnectEnabledByRule();
      }
    }

    async function doConnect() {
      if (isBusyAction || isScanning) {
        const t = toastCreate(toastHost, 'Please wait... another operation is running.', 'info');
        toastUpdateAndClose(t, 'Please wait... another operation is running.', 'info', 2200);
        return;
      }

      if (connectBtn.hasAttribute('disabled')) {
        const t = toastCreate(toastHost, 'Connect is disabled (selection rule).', 'info');
        toastUpdateAndClose(t, 'Connect is disabled (selection rule).', 'info', 2500);
        return;
      }

      const plmn = String(selectedFourth ?? '').trim();
      if (!plmn) {
        const t = toastCreate(toastHost, 'No operator selected.', 'error');
        toastUpdateAndClose(t, 'No operator selected.', 'error', 3200);
        return;
      }

      const selectedTuple = tuples[selectedIndex];
      const opName = operatorNameFromTuple(selectedTuple);

      const t = toastCreate(toastHost, `Connecting to ${opName}... waiting for OK`, 'info');

      try {
        setBusyActionState(true);

        // 1) Connect
        const url = luciUrl('admin/network/mobilescan/connect') + '?plmn=' + encodeURIComponent(plmn);
        const res = await request.get(url, { cache: false });
        const json = res.json();

        if (!json || json.ok !== true) {
          toastUpdateAndClose(t, `Connect failed (${opName}): ${json?.error || 'unknown error'}`, 'error', 5200);
          return;
        }

        const resp1 = extractModemResponse(json);
        if (!responseHasOK(resp1)) {
          toastUpdateAndClose(t, `Connect did not return OK (${opName}). Auto-connect NOT enabled.`, 'error', 5200);
          return;
        }

        // 2) Auto-connect (only after OK)
        toastSet(t, `Connected to ${opName}. Enabling auto-connect... waiting for reply`, 'info');

        const res2 = await request.get(luciUrl('admin/network/mobilescan/set_auto_connect'), { cache: false });
        const json2 = res2.json();

        if (!json2 || json2.ok !== true) {
          toastUpdateAndClose(t, `Auto-connect failed (${opName}): ${json2?.error || 'unknown error'}`, 'error', 5200);
          return;
        }

        const resp2 = extractModemResponse(json2);
        if (resp2 && !responseHasOK(resp2)) {
          toastUpdateAndClose(t, `Auto-connect reply not OK (${opName}).`, 'error', 5200);
          return;
        }

        toastUpdateAndClose(t, `Connected to ${opName} and auto-connect enabled.`, 'success', 3200);
      } catch (e) {
        toastUpdateAndClose(t, `Connect error (${opName}): ${prettyError(e)}`, 'error', 5200);
      } finally {
        setBusyActionState(false);
        setConnectEnabledByRule();
      }
    }

    async function doAutoSelectNetwork() {
      if (isBusyAction || isScanning) {
        const t = toastCreate(toastHost, 'Please wait... another operation is running.', 'info');
        toastUpdateAndClose(t, 'Please wait... another operation is running.', 'info', 2200);
        return;
      }

      const t = toastCreate(toastHost, 'Auto select network: starting…', 'info');

      try {
        setBusyActionState(true);

        const cmds = ['AT+COPS=0', 'AT+CFUN=0', 'AT+CFUN=1'];

        for (let i = 0; i < cmds.length; i++) {
          const cmd = cmds[i];
          toastSet(t, `Auto select network:\nSending ${cmd}\nWaiting for OK…`, 'info');

          const url = luciUrl('admin/network/mobilescan/at') + '?cmd=' + encodeURIComponent(cmd);
          const res = await request.get(url, { cache: false });
          const json = res.json();

          if (!json || json.ok !== true) {
            toastUpdateAndClose(t, `Failed: ${cmd}\n${json?.error || 'unknown error'}`, 'error', 6000);
            return;
          }

          const resp = extractModemResponse(json);
          if (!responseHasOK(resp)) {
            toastUpdateAndClose(t, `No OK reply for: ${cmd}\nStopping to avoid errors.`, 'error', 6500);
            return;
          }
        }

        toastUpdateAndClose(t, 'Auto select network complete (all commands returned OK).', 'success', 3400);
      } catch (e) {
        toastUpdateAndClose(t, `Auto select error: ${prettyError(e)}`, 'error', 5200);
      } finally {
        setBusyActionState(false);
        setConnectEnabledByRule();
      }
    }

    scanBtn.addEventListener('click', doScan);
    connectBtn.addEventListener('click', doConnect);
    revertBtn.addEventListener('click', doAutoSelectNetwork);

    root.appendChild(style);
    root.appendChild(toastHost);
    root.appendChild(el('div', { style: 'margin-top:10px;' }, [scanBtn, connectBtn, revertBtn, spinner]));
    root.appendChild(tableWrap);

    return root;
  }
});
