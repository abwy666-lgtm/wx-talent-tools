// ==UserScript==
// @name         微信小店 视频号达人ID查询工具
// @namespace    http://tampermonkey.net/
// @version      8.0.0
// @description  在微信小店达人广场，通过拦截XHR/Fetch接口响应直接提取达人UID，同时保留DOM扫描兜底
// @match        https://store.weixin.qq.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      store.weixin.qq.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ─── 全局缓存 ─────────────────────────────────────────────────
  const globalCache = new Map(); // talentAppid → data
  let panelRenderFn = null;

  function onNewData(results) {
    let hasNew = false;
    results.forEach(r => {
      if (r.talentAppid && !globalCache.has(r.talentAppid)) {
        globalCache.set(r.talentAppid, r);
        hasNew = true;
      } else if (r.talentAppid && globalCache.has(r.talentAppid)) {
        // 补充缺失字段
        const old = globalCache.get(r.talentAppid);
        const merged = Object.assign({}, old);
        if (!merged.nickname   && r.nickname)   merged.nickname   = r.nickname;
        if (!merged.finderId   && r.finderId)   merged.finderId   = r.finderId;
        if (!merged.fansNumber && r.fansNumber) merged.fansNumber = r.fansNumber;
        globalCache.set(r.talentAppid, merged);
      }
    });
    if (hasNew && panelRenderFn) {
      panelRenderFn([...globalCache.values()]);
    }
  }

  // ─── 从响应 JSON 深度提取达人数据 ────────────────────────────
  function extractFromResponse(data, url) {
    const results = [];

    function deepFind(obj, depth) {
      if (!obj || typeof obj !== 'object' || depth > 10) return;

      const tid = obj.talentAppid || obj.talentAppId || obj.talent_appid;
      if (tid && /^wx[0-9a-f]{16}$/i.test(tid)) {
        const item = {
          talentAppid: tid,
          finderId:    obj.finderId    || obj.finderUsername || obj.finder_id
                    || obj.finderInfo?.finderId || obj.finderInfo?.finderUsername,
          nickname:    obj.nickname    || obj.finderNickname || obj.name
                    || obj.finderInfo?.nickname,
          fansNumber:  obj.fansNumber  || obj.fans_number
                    || obj.finderInfo?.fansNumber,
          _source: url,
        };
        results.push(item);
        return; // 找到就不再深入这个分支
      }

      if (Array.isArray(obj)) {
        obj.forEach(v => deepFind(v, depth + 1));
      } else {
        Object.values(obj).forEach(v => deepFind(v, depth + 1));
      }
    }

    deepFind(data, 0);

    if (results.length > 0) {
      console.log('[WX达人] 接口捕获', results.length, '条 ←', url, results);
      onNewData(results);
    }
  }

  function tryParseAndExtract(text, url) {
    if (!text || text[0] !== '{' && text[0] !== '[') return;
    try {
      extractFromResponse(JSON.parse(text), url);
    } catch (_) {}
  }

  // ─── Hook XHR（在 Aegis 之前，document-start 注入）────────────
  (function hookXHR() {
    const Win = unsafeWindow || window;
    const OrigXHR = Win.XMLHttpRequest;

    function PatchedXHR() {
      const xhr = new OrigXHR();
      let _url = '';

      const origOpen = xhr.open.bind(xhr);
      xhr.open = function (method, url) {
        _url = url;
        return origOpen.apply(xhr, arguments);
      };

      const origSend = xhr.send.bind(xhr);
      xhr.send = function () {
        xhr.addEventListener('load', function () {
          if (!_url) return;
          tryParseAndExtract(xhr.responseText, _url);
        });
        return origSend.apply(xhr, arguments);
      };

      return xhr;
    }

    // 让 instanceof 检测仍然通过
    PatchedXHR.prototype = OrigXHR.prototype;
    Object.defineProperty(PatchedXHR, 'prototype', { writable: false });
    Win.XMLHttpRequest = PatchedXHR;

    console.log('[WX达人] XHR Hook 注入成功');
  })();

  // ─── Hook Fetch ───────────────────────────────────────────────
  (function hookFetch() {
    const Win = unsafeWindow || window;
    const origFetch = Win.fetch;
    if (!origFetch) return;

    Win.fetch = function (input, init) {
      const url = (typeof input === 'string' ? input : input?.url) || '';
      return origFetch.call(Win, input, init).then(response => {
        // 克隆一份读取，不影响原始响应
        response.clone().text().then(text => {
          tryParseAndExtract(text, url);
        }).catch(() => {});
        return response;
      });
    };

    console.log('[WX达人] Fetch Hook 注入成功');
  })();

  // ─── DOM 扫描兜底（保留原有逻辑）────────────────────────────

  function extractFromRow(row) {
    const result = {};

    const nameEl = row.querySelector('[class*="name"], [class*="nickname"], [class*="anchor-name"], td:first-child');
    if (nameEl) result.nickname = nameEl.textContent.trim();

    row.querySelectorAll('[data-talent-appid], [data-appid], [data-id]').forEach(el => {
      const tid = el.dataset.talentAppid || el.dataset.appid || el.dataset.id;
      if (tid && tid.startsWith('wx')) result.talentAppid = tid;
    });

    row.querySelectorAll('a[href*="talentAppid"], a[href*="appid"], a[href*="finderId"]').forEach(a => {
      try {
        const url = new URL(a.href, location.href);
        const tid = url.searchParams.get('talentAppid') || url.searchParams.get('appid');
        if (tid) result.talentAppid = tid;
        const fid = url.searchParams.get('finderId');
        if (fid) result.finderId = fid;
      } catch (_) {}
    });

    for (const el of row.querySelectorAll('*')) {
      // Vue
      if (el.__vue__) {
        try {
          const d = el.__vue__.$props || el.__vue__.$data || {};
          const checkDeep = (obj, depth = 0) => {
            if (!obj || typeof obj !== 'object' || depth > 5) return;
            const tid = obj.talentAppid || obj.talentAppId;
            if (tid && tid.startsWith('wx')) result.talentAppid = tid;
            if (obj.finderInfo) {
              result.nickname   = result.nickname   || obj.finderInfo.nickname;
              result.finderId   = result.finderId   || obj.finderInfo.finderId || obj.finderInfo.finderUsername;
              result.fansNumber = result.fansNumber || obj.finderInfo.fansNumber;
            }
            if (!result.talentAppid) Object.values(obj).forEach(v => checkDeep(v, depth + 1));
          };
          checkDeep(d);
          if (result.talentAppid) break;
        } catch (_) {}
      }

      // React Fiber
      const fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (fk) {
        try {
          let fiber = el[fk]; let depth = 0;
          while (fiber && depth++ < 15) {
            const p = fiber.memoizedProps || {};
            const checkP = obj => {
              if (!obj || typeof obj !== 'object') return;
              const tid = obj.talentAppid || obj.talentAppId || obj.talent?.talentAppid;
              if (tid && tid.startsWith('wx')) {
                result.talentAppid = tid;
                if (obj.finderInfo) {
                  result.nickname   = result.nickname   || obj.finderInfo.nickname;
                  result.finderId   = result.finderId   || obj.finderInfo.finderId;
                  result.fansNumber = result.fansNumber || obj.finderInfo.fansNumber;
                }
              }
            };
            [p, p.item, p.talent, p.data, p.record].forEach(checkP);
            if (result.talentAppid) break;
            fiber = fiber.return;
          }
        } catch (_) {}
      }
      if (result.talentAppid) break;
    }

    return result.talentAppid ? result : null;
  }

  function scanAllTextNodes() {
    const results = []; const seen = new Set();
    const wxPattern = /\bwx[0-9a-f]{16}\b/g;
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length > 0) return;
      const text = el.textContent?.trim();
      if (!text) return;
      (text.match(wxPattern) || []).forEach(m => {
        if (seen.has(m)) return;
        seen.add(m);
        let parent = el.parentElement, nickname = '';
        for (let i = 0; i < 5 && parent; i++) {
          const ne = parent.querySelector('[class*="name"],[class*="nickname"]');
          if (ne) { nickname = ne.textContent.trim(); break; }
          parent = parent.parentElement;
        }
        results.push({ talentAppid: m, nickname });
      });
    });
    return results;
  }

  function scanList() {
    const results = []; const seen = new Set();
    const selectors = [
      'tr[class*="row"]','tr.ant-table-row','.ant-table-tbody tr',
      '[class*="talent-item"]','[class*="talentItem"]',
      '[class*="finder-item"]','[class*="finderItem"]',
      '[class*="creator-item"]','[class*="list-item"]',
    ];
    let rows = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length) { rows = [...found]; break; }
    }
    if (!rows.length) rows = [...document.querySelectorAll('tbody tr, .ant-table-tbody tr')];

    rows.forEach(row => {
      const data = extractFromRow(row);
      if (data?.talentAppid && !seen.has(data.talentAppid)) {
        seen.add(data.talentAppid); results.push(data);
      }
    });

    if (!results.length) results.push(...scanAllTextNodes());
    return results;
  }

  // ─── MutationObserver ─────────────────────────────────────────
  let observer = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      clearTimeout(window.__wxScanTimer);
      window.__wxScanTimer = setTimeout(() => {
        const results = scanList();
        if (results.length) onNewData(results);
      }, 800);
    });
    const target = document.querySelector('.ant-table-tbody,[class*="talent-list"],[class*="finderList"],main,#app');
    observer.observe(target || document.body, { childList: true, subtree: true });
  }

  // ─── 触发页面搜索框 ───────────────────────────────────────────
  function triggerPageSearch(nickname) {
    const sels = ['input[placeholder*="昵称"]','input[placeholder*="达人"]','input[placeholder*="搜索"]','.ant-input','input[type="text"]'];
    for (const sel of sels) {
      for (const inp of document.querySelectorAll(sel)) {
        if (!inp.offsetParent) continue;
        try { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp, nickname); }
        catch (_) { inp.value = nickname; }
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => {
          for (const btn of document.querySelectorAll('button,.ant-btn')) {
            if (/搜索|查询|筛选/.test(btn.textContent.trim())) { btn.click(); return; }
          }
          ['keydown','keypress','keyup'].forEach(t =>
            inp.dispatchEvent(new KeyboardEvent(t, { key:'Enter', keyCode:13, bubbles:true }))
          );
        }, 500);
        return true;
      }
    }
    return false;
  }

  // ─── 等待数据（接口 + DOM 双保险）────────────────────────────
  function waitForData(ms = 8000) {
    return new Promise((resolve, reject) => {
      // 先看缓存
      if (globalCache.size > 0) return resolve([...globalCache.values()]);

      // 立即 DOM 扫描
      const immediate = scanList();
      if (immediate.length) { onNewData(immediate); return resolve([...globalCache.values()]); }

      // 等网络请求或 DOM 变化触发
      const origRender = panelRenderFn;
      panelRenderFn = (results) => {
        panelRenderFn = origRender;
        if (origRender) origRender(results);
        resolve(results);
      };
      setTimeout(() => {
        panelRenderFn = origRender;
        const last = scanList();
        if (last.length) { onNewData(last); resolve([...globalCache.values()]); }
        else if (globalCache.size > 0) resolve([...globalCache.values()]);
        else reject(new Error('未能提取到达人数据\n请确认列表已显示，然后点「扫描页面」按钮'));
      }, ms);
    });
  }

  // ─── UI（等 DOM Ready 再初始化）──────────────────────────────
  function initUI() {
    const style = document.createElement('style');
    style.textContent = `
      #wx-panel{position:fixed;top:68px;right:16px;width:330px;background:#fff;border-radius:14px;
        box-shadow:0 8px 40px rgba(7,193,96,.2);z-index:999999;
        font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;font-size:13px;overflow:hidden;}
      #wx-head{background:linear-gradient(135deg,#07c160,#00a854);color:#fff;padding:11px 14px;
        display:flex;align-items:center;justify-content:space-between;user-select:none;}
      #wx-head .ht{font-weight:700;font-size:14px;}
      .wx-hbtn{background:rgba(255,255,255,.22);border:none;color:#fff;border-radius:5px;
        padding:2px 9px;cursor:pointer;font-size:12px;margin-left:5px;}
      .wx-hbtn:hover{background:rgba(255,255,255,.38);}
      #wx-body{padding:13px 13px 12px;}
      .wx-tip{font-size:11px;color:#555;background:#f0fff6;border-radius:7px;padding:8px 10px;
        margin-bottom:10px;border:1px solid #bbf7d0;line-height:1.7;}
      .wx-tip b{color:#07c160;}
      .wx-lbl{font-size:11px;color:#999;margin-bottom:4px;}
      .wx-inp{width:100%;box-sizing:border-box;border:1.5px solid #e5e5e5;border-radius:7px;
        padding:8px 10px;font-size:13px;outline:none;margin-bottom:8px;transition:border .18s;}
      .wx-inp:focus{border-color:#07c160;}
      .wx-btns{display:flex;gap:8px;margin-bottom:4px;}
      .wx-btn{flex:1;padding:9px;background:linear-gradient(135deg,#07c160,#00a854);
        color:#fff;border:none;border-radius:7px;cursor:pointer;font-size:13px;font-weight:700;
        letter-spacing:1px;transition:opacity .2s;}
      .wx-btn:hover{opacity:.88;}.wx-btn:disabled{opacity:.5;cursor:not-allowed;}
      .wx-btn2{padding:9px 10px;background:#fff;color:#07c160;border:1.5px solid #07c160;
        border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;transition:all .2s;}
      .wx-btn2:hover{background:#07c160;color:#fff;}
      .wx-btn3{padding:9px 10px;background:#fff;color:#6366f1;border:1.5px solid #6366f1;
        border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;transition:all .2s;}
      .wx-btn3:hover{background:#6366f1;color:#fff;}
      #wx-result{max-height:320px;overflow-y:auto;margin-top:8px;}
      .wx-item{background:#f0fff6;border-radius:8px;padding:9px 11px;margin-bottom:7px;border:1px solid #d1fae5;}
      .wx-iname{font-weight:600;color:#1a1a2e;margin-bottom:5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
      .wx-fans{font-size:10px;color:#07c160;background:#dcfce7;padding:1px 7px;border-radius:10px;}
      .wx-src{font-size:9px;color:#aaa;background:#f5f5f5;padding:1px 5px;border-radius:3px;max-width:120px;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .wx-irow{display:flex;align-items:center;gap:5px;margin-bottom:3px;}
      .wx-ilbl{font-size:10px;color:#aaa;flex-shrink:0;width:68px;}
      .wx-ival{font-family:'SF Mono',monospace;font-size:11px;color:#059669;word-break:break-all;flex:1;cursor:pointer;}
      .wx-ival:hover{text-decoration:underline;}
      .wx-copy{font-size:10px;padding:1px 6px;border:1px solid #07c160;color:#07c160;
        border-radius:4px;cursor:pointer;background:#fff;flex-shrink:0;transition:all .15s;}
      .wx-copy:hover{background:#07c160;color:#fff;}
      .wx-empty{text-align:center;color:#ccc;padding:18px 0;font-size:12px;}
      .wx-err{color:#ef4444;font-size:12px;padding:8px 10px;background:#fff5f5;
        border-radius:6px;border:1px solid #fecaca;margin-top:8px;line-height:1.8;white-space:pre-line;}
      .wx-load{text-align:center;padding:16px 0;color:#aaa;font-size:12px;}
      .wx-count{font-size:11px;color:#07c160;padding:4px 8px;background:#f0fff6;
        border-radius:5px;border:1px solid #bbf7d0;margin-bottom:6px;display:flex;justify-content:space-between;}
      .wx-status{display:flex;align-items:center;gap:5px;font-size:11px;color:#888;margin-bottom:8px;}
      .wx-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;transition:background .3s;}
      .wx-dot.ok{background:#22c55e;}.wx-dot.wait{background:#f59e0b;}.wx-dot.flash{background:#6366f1;}
      #wx-fab{position:fixed;top:68px;right:16px;width:46px;height:46px;border-radius:50%;
        background:linear-gradient(135deg,#07c160,#00a854);color:#fff;display:none;
        align-items:center;justify-content:center;cursor:pointer;z-index:999999;font-size:22px;
        box-shadow:0 4px 18px rgba(7,193,96,.45);transition:transform .2s;}
      #wx-fab:hover{transform:scale(1.1);}
      .wx-badge{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;
        border-radius:10px;font-size:10px;padding:0 5px;min-width:16px;text-align:center;line-height:16px;}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'wx-panel';
    panel.innerHTML = `
      <div id="wx-head">
        <span class="ht">🎬 视频号达人ID查询</span>
        <div>
          <button class="wx-hbtn" id="wx-min">—</button>
          <button class="wx-hbtn" id="wx-close">×</button>
        </div>
      </div>
      <div id="wx-body">
        <div class="wx-status">
          <div class="wx-dot wait" id="wx-dot"></div>
          <span id="wx-stxt">监听中，等待接口数据...</span>
        </div>
        <div class="wx-tip">
          💡 <b>自动监听接口（无需手动操作）</b><br>
          浏览达人列表时会自动捕获。<br>
          也可输入昵称点「查询」或「扫描页面」。
        </div>
        <div class="wx-lbl">达人昵称（选填）</div>
        <input class="wx-inp" id="wx-name" placeholder="输入昵称筛选，留空=全部" />
        <div class="wx-btns">
          <button class="wx-btn"  id="wx-search">查　询</button>
          <button class="wx-btn2" id="wx-scan">扫描页面</button>
          <button class="wx-btn3" id="wx-export">导出CSV</button>
        </div>
        <div id="wx-result"></div>
      </div>
    `;
    document.body.appendChild(panel);

    const fab = document.createElement('div');
    fab.id = 'wx-fab';
    fab.innerHTML = '🎬<span class="wx-badge" id="wx-badge" style="display:none">0</span>';
    document.body.appendChild(fab);

    // 接口自动捕获后更新面板
    panelRenderFn = (results) => {
      const dot = panel.querySelector('#wx-dot');
      dot.className = 'wx-dot flash';
      setTimeout(() => dot.className = 'wx-dot ok', 1200);
      panel.querySelector('#wx-stxt').textContent = `已捕获 ${results.length} 条（实时）`;

      // 更新 fab badge
      const badge = document.querySelector('#wx-badge');
      if (badge) {
        badge.textContent = results.length;
        badge.style.display = results.length ? '' : 'none';
      }

      // 如果结果面板已有内容，自动刷新
      const res = panel.querySelector('#wx-result');
      if (res.querySelector('.wx-item')) renderList(results);
    };

    panel.querySelector('#wx-min').addEventListener('click', () => { panel.style.display='none'; fab.style.display='flex'; });
    panel.querySelector('#wx-close').addEventListener('click', () => { panel.style.display='none'; fab.style.display='flex'; });
    fab.addEventListener('click', () => { panel.style.display=''; fab.style.display='none'; });

    // 扫描按钮
    panel.querySelector('#wx-scan').addEventListener('click', () => {
      const filter = panel.querySelector('#wx-name').value.trim().toLowerCase();
      const domResults = scanList();
      if (domResults.length) onNewData(domResults);
      let results = [...globalCache.values()];
      if (filter) results = results.filter(r => (r.nickname||'').toLowerCase().includes(filter));
      renderList(results);
      panel.querySelector('#wx-stxt').textContent = results.length ? `共 ${results.length} 条` : '未扫描到数据';
      panel.querySelector('#wx-dot').className = results.length ? 'wx-dot ok' : 'wx-dot wait';
    });

    // 导出 CSV
    panel.querySelector('#wx-export').addEventListener('click', () => {
      const data = [...globalCache.values()];
      if (!data.length) return alert('暂无数据可导出');
      const rows = [['昵称','talentAppid','finderId','粉丝数','来源']];
      data.forEach(r => rows.push([r.nickname||'', r.talentAppid||'', r.finderId||'', r.fansNumber||'', r._source||'']));
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(csv);
      a.download = `达人数据_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
    });

    // 查询按钮
    async function doSearch() {
      const name = panel.querySelector('#wx-name').value.trim();
      const res  = panel.querySelector('#wx-result');
      const btn  = panel.querySelector('#wx-search');
      btn.disabled = true; btn.textContent = '查询中...';
      res.innerHTML = '<div class="wx-load">⏳ 正在搜索...</div>';

      const triggered = name ? triggerPageSearch(name) : false;

      try {
        const results = await waitForData(triggered ? 8000 : 3000);
        const filtered = name
          ? results.filter(r => (r.nickname||'').toLowerCase().includes(name.toLowerCase()))
          : results;
        renderList(filtered.length ? filtered : results);
      } catch (e) {
        res.innerHTML = `<div class="wx-err">❌ ${esc(e.message)}</div>`;
      } finally {
        btn.disabled = false; btn.textContent = '查　询';
      }
    }

    panel.querySelector('#wx-search').addEventListener('click', doSearch);
    panel.querySelector('#wx-name').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

    function renderList(list) {
      const res = panel.querySelector('#wx-result');
      if (!list?.length) {
        res.innerHTML = '<div class="wx-err">未提取到达人数据\n\n• 请浏览达人列表，接口数据会自动捕获\n• 或点「扫描页面」手动读取 DOM\n• 检查控制台 [WX达人] 日志</div>';
        return;
      }
      res.innerHTML = `<div class="wx-count"><span>共 ${list.length} 条</span><span style="color:#aaa">（含接口+DOM）</span></div>` +
        list.map(item => {
          const tid  = item.talentAppid || '-';
          const fid  = item.finderId || '';
          const nick = item.nickname || '未知昵称';
          const fans = item.fansNumber;
          const fansStr = fans ? formatNum(fans) + '粉' : '';
          const src = item._source ? item._source.replace(/^https?:\/\/[^/]+/, '').substring(0, 30) : '';
          return `<div class="wx-item">
            <div class="wx-iname">
              ${esc(nick)}
              ${fansStr ? `<span class="wx-fans">${fansStr}</span>` : ''}
              ${src ? `<span class="wx-src" title="${esc(item._source||'')}">${esc(src)}</span>` : ''}
            </div>
            <div class="wx-irow">
              <span class="wx-ilbl">talentAppid</span>
              <span class="wx-ival" data-v="${esc(tid)}">${esc(tid)}</span>
              <span class="wx-copy" data-v="${esc(tid)}">复制</span>
            </div>
            ${fid ? `<div class="wx-irow">
              <span class="wx-ilbl">finderId</span>
              <span class="wx-ival" data-v="${esc(fid)}">${esc(fid)}</span>
              <span class="wx-copy" data-v="${esc(fid)}">复制</span>
            </div>` : ''}
          </div>`;
        }).join('');

      res.querySelectorAll('.wx-ival,.wx-copy').forEach(el => {
        el.addEventListener('click', () => {
          navigator.clipboard.writeText(el.dataset.v).then(() => {
            const o = el.textContent; el.textContent = '✅';
            setTimeout(() => el.textContent = o, 1500);
          });
        });
      });
    }
  }

  // document-start 时 DOM 还没有，等 DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startObserver();
      initUI();
    });
  } else {
    startObserver();
    initUI();
  }

  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function formatNum(n) { n = Number(n); return n >= 10000 ? (n/10000).toFixed(1)+'w' : String(n); }

})();