// Cache Friendly — 让世界书和变量别把 prompt 缓存打碎
//
// 原理：缓存只认"从开头起一模一样"的前缀。世界书里会变的条目（绿灯这轮亮下轮灭、
// 内容里有 {{getvar}} / {{random}} / {{time}} / <% %> 模板的）如果放在角色卡前后，
// 每轮都会让后面整段聊天记录的缓存作废。
// 这个插件在酒馆挑条目之前，把这些"会变的"条目改派到聊天最末尾（深度 0），
// 不会变的常驻条目原地不动。只改本轮的临时副本，不会写回你的世界书文件。
// 向量召回（聊天记录向量化 / 资料库）每轮捞的不同，也一并挪到末尾。

import { eventSource, event_types, saveSettingsDebounced, extension_prompts, extension_prompt_types } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const KEY = 'cacheFriendly';
const DEFAULTS = { enabled: true, depthToEnd: true, vectorsToEnd: true, claudeCache: true, cache1h: false, checkup: true, checkupToast: true, log: false };

// world_info_position: before 0, after 1, ANTop 2, ANBottom 3, atDepth 4, EMTop 5, EMBottom 6, outlet 7
const STATIC_POSITIONS = [0, 1, 5, 6];
const AT_DEPTH = 4;
const ROLE_SYSTEM = 0;

const VOLATILE = /\{\{\s*(getvar|getglobalvar|var|globalvar|setvar|addvar|incvar|decvar|random|roll|pick|time|date|weekday|isotime|isodate|datetimeformat|idle_duration|lastmessage|lastusermessage|lastcharmessage|lastmessageid|currentswipeid|input|outlet)\b/i;

function settings() {
    extension_settings[KEY] = Object.assign({}, DEFAULTS, extension_settings[KEY] || {});
    return extension_settings[KEY];
}

function isVolatile(entry) {
    if (!entry.constant) return true;                      // 绿灯：这轮亮下轮灭
    const text = String(entry.content ?? '');
    return VOLATILE.test(text) || text.includes('<%');     // 内容会变的蓝灯
}

function onEntriesLoaded(lore) {
    const s = settings();
    if (!s.enabled) return;
    let moved = 0, flattened = 0;
    for (const list of [lore.globalLore, lore.characterLore, lore.chatLore, lore.personaLore]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (!entry || entry.disable) continue;
            if (STATIC_POSITIONS.includes(Number(entry.position)) && isVolatile(entry)) {
                entry.position = AT_DEPTH;
                entry.depth = 0;
                entry.role = ROLE_SYSTEM;
                moved++;
            } else if (s.depthToEnd && Number(entry.position) === AT_DEPTH && Number(entry.depth) > 0) {
                // 按深度插在聊天中间的条目，深度跟着聊天长度"滑动"，也会打碎它后面的缓存
                entry.depth = 0;
                flattened++;
            }
        }
    }
    if (s.log) console.log(`[Cache Friendly] moved ${moved} volatile entries to the end, flattened ${flattened} @depth entries`);
}

// ── 向量召回挪到末尾 ─────────────────────────────────────────────
// 酒馆自带的向量召回（聊天记录向量化 3_vectors、资料库 4_vectors_data_bank）每轮捞出来的
// 片段都不一样，默认却插在主提示词里（聊天记录前面），每轮都把后面整段缓存打碎。
// 它是在"生成拦截器"里把内容塞进 extension_prompts 的；本插件的拦截器排在它后面跑，
// 把这两项改成"聊天内 · 深度 0"。只改这一轮要用的位置，不改向量插件的设置。
const VECTOR_KEYS = ['3_vectors', '4_vectors_data_bank'];

globalThis.cacheFriendly_interceptor = async function () {
    const s = settings();
    if (!s.vectorsToEnd) return;
    let moved = 0;
    for (const key of VECTOR_KEYS) {
        const p = extension_prompts[key];
        if (!p || !p.value) continue;
        const atEnd = p.position === extension_prompt_types.IN_CHAT && Number(p.depth) === 0;
        if (atEnd) continue;
        p.position = extension_prompt_types.IN_CHAT;
        p.depth = 0;
        moved++;
    }
    if (s.log && moved) console.log(`[Cache Friendly] moved ${moved} vector recall block(s) to the end`);
};

// ── 缓存体检 ─────────────────────────────────────────────────────
// 每轮把要发出去的消息跟上一轮比：从开头起有多少字一模一样（= 理论上能命中缓存的部分）。
// 掉下来时指出从哪儿开始变的，尽量认出是哪条世界书 / 角色卡哪一栏 / 向量召回。
// 只在本地比，不发任何请求；只看文字，不看缓存标记。
const CHECK = { chatId: null, prev: null, wiNow: [], wiPrev: [] };

function msgText(m) {
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
    return '';
}

function onWorldInfoActivated(entries) {
    CHECK.wiPrev = CHECK.wiNow;   // 上一轮亮过、这一轮灭了的条目，也要认得出来
    CHECK.wiNow = Array.isArray(entries) ? entries.map(e => ({ name: e.comment || (Array.isArray(e.key) ? e.key.join(',') : '') || `#${e.uid}`, text: String(e.content || '') })) : [];
}

// 在 text 的第 pos 个字附近，认一认这是谁的内容
function whoIsAt(text, pos) {
    const covers = (needle) => {
        if (!needle || needle.length < 8) return false;
        const head = needle.slice(0, 60);
        let i = text.indexOf(head);
        while (i >= 0) {
            if (pos >= i - 2 && pos <= i + needle.length + 2) return true;
            i = text.indexOf(head, i + 1);
        }
        return false;
    };
    for (const e of [...CHECK.wiNow, ...CHECK.wiPrev]) if (covers(e.text)) return `世界书「${e.name}」`;
    for (const key of VECTOR_KEYS) if (covers(String(extension_prompts[key]?.value || ''))) return '向量召回';
    const ctx = SillyTavern.getContext();
    const ch = ctx.characters?.[ctx.characterId];
    if (ch) {
        const f = { description: '角色描述', personality: '角色性格', scenario: '场景', mes_example: '对话示例' };
        for (const k in f) if (covers(String(ch[k] || ''))) return `角色卡·${f[k]}`;
    }
    return '';
}

function snippet(t, pos) {
    return t.slice(Math.max(0, pos - 6), pos + 24).replace(/\s+/g, ' ');
}

function runCheckup(chat) {
    const s = settings();
    if (!s.checkup) return;
    const ctx = SillyTavern.getContext();
    const chatId = ctx.getCurrentChatId?.() ?? null;
    const now = chat.map(m => ({ role: m.role, text: msgText(m) }));
    const prev = (CHECK.chatId === chatId) ? CHECK.prev : null;
    CHECK.chatId = chatId; CHECK.prev = now;
    if (!prev) { showCheckup('等下一轮再比（第一轮没东西可比）', null); return; }

    const total = now.reduce((a, m) => a + m.text.length, 0) || 1;
    let same = 0, k = 0, pos = 0;
    for (; k < now.length && k < prev.length; k++) {
        if (now[k].role === prev[k].role && now[k].text === prev[k].text) { same += now[k].text.length; continue; }
        const a = prev[k].text, b = now[k].text;
        if (now[k].role === prev[k].role) { while (pos < a.length && pos < b.length && a[pos] === b[pos]) pos++; }
        same += pos;
        break;
    }
    const pct = Math.round(100 * same / total);
    const tail = now.length - k;   // 变化点后面还剩几条
    let where = '';
    if (k < now.length) {
        const who = whoIsAt(now[k].text, pos) || (k < prev.length ? whoIsAt(prev[k].text, pos) : '');
        where = `从第 ${k + 1} 条（共 ${now.length} 条）开始变` + (who ? `，是 ${who}` : '') + `：「${snippet(now[k].text, pos)}」`;
    }
    const ok = pct >= 70 || tail <= 3;   // 只在最后两三条变 = 正常的新对话
    showCheckup(`本轮前缀不变 ${pct}%` + (where ? `｜${where}` : ''), ok);
    if (!ok && s.checkupToast && typeof toastr !== 'undefined') {
        toastr.warning(`前面只有 ${pct}% 没变，缓存大半作废。<br>${where}`, '缓存体检', { escapeHtml: false, timeOut: 8000 });
    }
    if (s.log) console.log('[Cache Friendly] checkup', pct, where);
}

function showCheckup(text, ok) {
    const el = document.getElementById('cf_checkup_text');
    if (!el) return;
    el.textContent = text;
    el.style.color = ok === false ? 'var(--warning, #e0a040)' : '';
}

// ── 自动给 Claude 打缓存标记（自定义 / OpenAI 兼容接口） ─────────────────
// 原版酒馆只在"Claude"接口来源、并且改了 config.yaml 时才打缓存标记。
// 走"自定义（OpenAI 兼容）"连 Claude 模型时，消息会原样发给接口，
// 所以插件在发出去之前自己打：system 段末尾一个，最后一条用户消息、再往前第二条用户消息各一个
// （缓存跟着对话往前滚：这一轮命中上一轮写下的位置）。接口把 cache_control 传下去就能命中。
function markCache(message, ttl) {
    if (!message) return false;
    if (typeof message.content === 'string') {
        if (!message.content) return false;
        message.content = [{ type: 'text', text: message.content }];
    }
    if (!Array.isArray(message.content) || !message.content.length) return false;
    const last = message.content[message.content.length - 1];
    last.cache_control = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
    return true;
}

function onPromptReady(data) {
    const s = settings();
    if (!data || data.dryRun || !Array.isArray(data.chat)) return;
    try { runCheckup(data.chat); } catch (e) { console.warn('[Cache Friendly] checkup failed', e); }
    if (!s.claudeCache) return;
    const ctx = SillyTavern.getContext();
    const oai = ctx.chatCompletionSettings || {};
    if (oai.chat_completion_source !== 'custom') return;            // Claude 原生接口归 config.yaml 管
    const model = String(oai.custom_model || '');
    if (!/claude/i.test(model)) return;
    const chat = data.chat;
    const ttl = s.cache1h ? '1h' : '5m';
    let marks = 0;

    // 1) 开头那一串 system（角色卡、设定、常驻世界书）的最后一条
    let i = 0;
    while (i < chat.length && chat[i].role === 'system') i++;
    if (i > 0 && markCache(chat[i - 1], ttl)) marks++;

    // 2) 最后一条用户消息 + 往前第二条用户消息（滚动缓存）
    const userIdx = [];
    for (let k = chat.length - 1; k >= 0 && userIdx.length < 2; k--) {
        if (chat[k].role === 'user' && k >= i) userIdx.push(k);
        else if (chat[k].role === 'user') break;
    }
    for (const k of userIdx) if (markCache(chat[k], ttl)) marks++;
    // 最多 3 个标记 + 服务端可能有的 1 个，不超 Claude 的 4 个上限

    if (s.log) console.log(`[Cache Friendly] added ${marks} cache_control markers for ${model}`);
}

function addSettingsUi() {
    const s = settings();
    const html = `
    <div class="cache-friendly-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Cache Friendly · 缓存友好</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label"><input id="cf_enabled" type="checkbox"> 会变的世界书条目挪到聊天末尾</label>
          <small>绿灯条目、带 {{getvar}} / {{random}} / {{time}} / &lt;% %&gt; 的条目 → 深度 0。不会变的常驻条目不动。</small>
          <label class="checkbox_label"><input id="cf_depth" type="checkbox"> 按深度插入的世界书也收到末尾</label>
          <small>@深度 N 的条目改成深度 0，不再插在聊天中间。</small>
          <label class="checkbox_label"><input id="cf_vec" type="checkbox"> 向量召回挪到聊天末尾</label>
          <small>聊天记录向量化、资料库每轮捞出来的片段不一样，挪到最后就不打碎前面的缓存。</small>
          <label class="checkbox_label"><input id="cf_claude" type="checkbox"> 自定义接口用 Claude 时自动开缓存</label>
          <small>"自定义（OpenAI 兼容）"连 Claude 模型时，自动打缓存标记（system + 聊天记录滚动缓存）。接口要认这个标记才生效；用"Claude"接口的请改 config.yaml。</small>
          <label class="checkbox_label"><input id="cf_1h" type="checkbox"> 用 1 小时缓存</label>
          <small>写入贵一倍，适合聊得慢、经常隔十几分钟才回一句。</small>
          <hr>
          <label class="checkbox_label"><input id="cf_check" type="checkbox"> 缓存体检</label>
          <small>每轮比一比：前面有多少跟上一轮一模一样（这部分才能吃到缓存）。</small>
          <div id="cf_checkup_text" style="font-size:0.9em;margin:4px 0 6px;word-break:break-all;">还没发过消息</div>
          <label class="checkbox_label"><input id="cf_check_toast" type="checkbox"> 掉到 70% 以下时弹提示，告诉我是哪儿变了</label>
          <label class="checkbox_label"><input id="cf_log" type="checkbox"> 在浏览器控制台打印挪了几条</label>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#cf_enabled').prop('checked', s.enabled).on('input', function () { settings().enabled = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_depth').prop('checked', s.depthToEnd).on('input', function () { settings().depthToEnd = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_vec').prop('checked', s.vectorsToEnd).on('input', function () { settings().vectorsToEnd = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_claude').prop('checked', s.claudeCache).on('input', function () { settings().claudeCache = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_1h').prop('checked', s.cache1h).on('input', function () { settings().cache1h = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_check').prop('checked', s.checkup).on('input', function () { settings().checkup = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_check_toast').prop('checked', s.checkupToast).on('input', function () { settings().checkupToast = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_log').prop('checked', s.log).on('input', function () { settings().log = !!$(this).prop('checked'); saveSettingsDebounced(); });
}

jQuery(() => {
    settings();
    addSettingsUi();
    eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
});
