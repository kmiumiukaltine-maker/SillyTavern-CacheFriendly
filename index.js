// Cache Friendly — 让世界书和变量别把 prompt 缓存打碎
//
// 原理：缓存只认"从开头起一模一样"的前缀。世界书里会变的条目（绿灯这轮亮下轮灭、
// 内容里有 {{getvar}} / {{random}} / {{time}} / <% %> 模板的）如果放在角色卡前后，
// 每轮都会让后面整段聊天记录的缓存作废。
// 这个插件在酒馆挑条目之前，把这些"会变的"条目改派到聊天最末尾（深度 0），
// 不会变的常驻条目原地不动；带变量的常驻条目要看到它真的变了才挪。只改本轮的临时副本，不会写回你的世界书文件。
// 向量召回（聊天记录向量化 / 资料库）每轮捞的不同，也一并挪到末尾。

import { eventSource, event_types, saveSettingsDebounced, extension_prompts, extension_prompt_types } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const KEY = 'cacheFriendly';
const DEFAULTS = { enabled: true, strictMacro: false, depthToEnd: true, vectorsToEnd: true, extToEnd: true, claudeCache: true, cache1h: false, checkup: true, checkupToast: true, log: false };

// world_info_position: before 0, after 1, ANTop 2, ANBottom 3, atDepth 4, EMTop 5, EMBottom 6, outlet 7
const STATIC_POSITIONS = [0, 1, 5, 6];
const AT_DEPTH = 4;
const ROLE_SYSTEM = 0;

const VOLATILE = /\{\{\s*(getvar|getglobalvar|var|globalvar|setvar|addvar|incvar|decvar|random|roll|pick|time|date|weekday|isotime|isodate|datetimeformat|idle_duration|lastmessage|lastusermessage|lastcharmessage|lastmessageid|currentswipeid|input|outlet)\b/i;

function settings() {
    extension_settings[KEY] = Object.assign({}, DEFAULTS, extension_settings[KEY] || {});
    return extension_settings[KEY];
}

// ── 判断哪些条目要挪 ───────────────────────────────────────────
// 绿灯（非常驻）：这轮亮下轮灭，一律挪。
// 带变量 / <% %> 的常驻条目：很多其实一整局都不变（开局设一次的世界观、名字……），
//   所以先留在原位，插件每轮记下它实际发出去的内容；只有看到它前后两轮真的变了，
//   才记成"会变的"，从下一轮起挪到末尾（记在这个聊天的元数据里，换聊天各算各的）。
// 手动：条目标题里写 [cf:end] 一律挪，写 [cf:keep] 一律不挪。
// 设置里勾"带变量的一律挪"就回到 1.3.0 以前的做法。
const ENTRY = new Map();      // id -> { name, raw, constant, macro }
const LAST = new Map();       // id -> 上一轮实际内容（只在内存里，刷新后重新记）

function entryId(e) { return `${e.world}.${e.uid}`; }
function hasMacro(text) { return VOLATILE.test(text) || text.includes('<%'); }

function volatileSet() {
    const ctx = SillyTavern.getContext();
    const meta = ctx.chatMetadata;
    if (!meta) return null;
    if (!Array.isArray(meta.cacheFriendlyVolatile)) meta.cacheFriendlyVolatile = [];
    return meta.cacheFriendlyVolatile;
}

function markVolatile(id, why) {
    const info = ENTRY.get(id);
    if (!info || !info.constant || !info.macro) return false;   // 只管"带变量的常驻条目"
    const list = volatileSet();
    if (!list || list.includes(id)) return false;
    list.push(id);
    SillyTavern.getContext().saveMetadataDebounced?.();
    if (settings().log) console.log(`[Cache Friendly] 「${info.name}」${why}，下一轮起挪到末尾`);
    return true;
}

function shouldMove(entry, s) {
    const name = String(entry.comment || '');
    if (name.includes('[cf:keep]')) return false;
    if (name.includes('[cf:end]')) return true;
    if (!entry.constant) return true;
    const text = String(entry.content ?? '');
    if (!hasMacro(text)) return false;
    if (s.strictMacro) return true;
    return (volatileSet() || []).includes(entryId(entry));
}

function onEntriesLoaded(lore) {
    const s = settings();
    let moved = 0, flattened = 0;
    for (const list of [lore.globalLore, lore.characterLore, lore.chatLore, lore.personaLore]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (!entry || entry.disable) continue;
            const raw = String(entry.content ?? '');
            ENTRY.set(entryId(entry), { name: entry.comment || (Array.isArray(entry.key) ? entry.key.join(',') : '') || `#${entry.uid}`, raw, constant: !!entry.constant, macro: hasMacro(raw) });
            if (!s.enabled) continue;
            if (STATIC_POSITIONS.includes(Number(entry.position)) && shouldMove(entry, s)) {
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
    STAT.moved = moved; STAT.flattened = flattened;
    if (s.log) console.log(`[Cache Friendly] moved ${moved} entries to the end, flattened ${flattened} @depth entries`);
}

// ── 向量召回挪到末尾 ─────────────────────────────────────────────
// 酒馆自带的向量召回（聊天记录向量化 3_vectors、资料库 4_vectors_data_bank）每轮捞出来的
// 片段都不一样，默认却插在主提示词里（聊天记录前面），每轮都把后面整段缓存打碎。
// 它是在"生成拦截器"里把内容塞进 extension_prompts 的；本插件的拦截器排在它后面跑，
// 把这两项改成"聊天内 · 深度 0"。只改这一轮要用的位置，不改向量插件的设置。
const VECTOR_KEYS = ['3_vectors', '4_vectors_data_bank'];

// ── 其他插件的注入：变了才挪（1.6.0）─────────────────────────────
// 数据库/表格、总结、小白X、/inject……这些插件都往 extension_prompts 里塞东西，
// 很多塞在聊天记录前面（IN_PROMPT / BEFORE_PROMPT）或者聊天中间（深度 > 0）。
// 跟带变量的世界书一个办法：每轮记下每条注入的内容，看到前后两轮真的变了，
// 才记成"会变的"，从下一轮起改到聊天末尾（深度 0）。不变的原地不动，不改那些插件的设置。
// 酒馆自己的世界书深度条目、outlet、静默提示、故事串不归这里管。
const EXT_SKIP = /^(customDepthWI|customWIOutlet|QUIET_PROMPT|__STORY_STRING__)/;
const EXT_LAST = new Map();   // key -> 上一轮内容（只在内存里）

function extVolatileSet() {
    const meta = SillyTavern.getContext().chatMetadata;
    if (!meta) return null;
    if (!Array.isArray(meta.cacheFriendlyVolatileExt)) meta.cacheFriendlyVolatileExt = [];
    return meta.cacheFriendlyVolatileExt;
}

function markExtVolatile(key, why) {
    const list = extVolatileSet();
    if (!list || list.includes(key)) return false;
    list.push(key);
    SillyTavern.getContext().saveMetadataDebounced?.();
    if (settings().log) console.log(`[Cache Friendly] 插件注入「${key}」${why}，下一轮起挪到末尾`);
    return true;
}

function extAtEnd(p) { return p.position === extension_prompt_types.IN_CHAT && Number(p.depth) === 0; }

function moveVolatileExt() {
    const list = extVolatileSet() || [];
    let moved = 0;
    for (const key of Object.keys(extension_prompts)) {
        if (EXT_SKIP.test(key) || VECTOR_KEYS.includes(key)) continue;
        const p = extension_prompts[key];
        if (!p || !p.value || p.position === extension_prompt_types.NONE) continue;
        const val = String(p.value);
        const before = EXT_LAST.get(key);
        EXT_LAST.set(key, val);
        if (list.includes(key)) {
            p.position = extension_prompt_types.IN_CHAT;
            p.depth = 0;
            moved++;
            continue;
        }
        if (extAtEnd(p)) continue;
        if (before !== undefined && before !== val) markExtVolatile(key, '这轮内容跟上轮不一样');
    }
    return moved;
}

globalThis.cacheFriendly_interceptor = async function () {
    const s = settings();
    STAT.ext = s.extToEnd ? moveVolatileExt() : 0;
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
    STAT.vectors = moved;
    if (s.log && moved) console.log(`[Cache Friendly] moved ${moved} vector recall block(s) to the end`);
};

// ── 缓存体检 ─────────────────────────────────────────────────────
// 每轮把要发出去的消息跟上一轮比：从开头起有多少字一模一样（= 理论上能命中缓存的部分）。
// 掉下来时指出从哪儿开始变的，尽量认出是哪条世界书 / 角色卡哪一栏 / 向量召回。
// 只在本地比，不发任何请求；只看文字，不看缓存标记。
const CHECK = { chatId: null, prev: null, wiNow: [], wiPrev: [], history: [] };
const STAT = { moved: 0, flattened: 0, vectors: 0, ext: 0 };   // 最近一轮挪了多少，给测试报告用

function msgText(m) {
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
    return '';
}

function onWorldInfoActivated(entries) {
    CHECK.wiPrev = CHECK.wiNow;   // 上一轮亮过、这一轮灭了的条目，也要认得出来
    CHECK.wiNow = Array.isArray(entries) ? entries.map(e => ({ id: entryId(e), name: e.comment || (Array.isArray(e.key) ? e.key.join(',') : '') || `#${e.uid}`, text: String(e.content || '') })) : [];
    // 宏在激活时已经替换好了：跟上一轮比，真变了就记下来
    for (const e of CHECK.wiNow) {
        const before = LAST.get(e.id);
        if (before !== undefined && before !== e.text) markVolatile(e.id, '这轮内容跟上轮不一样');
        LAST.set(e.id, e.text);
    }
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
    for (const e of [...CHECK.wiNow, ...CHECK.wiPrev]) if (covers(e.text)) { CHECK.hitId = e.id; return `世界书「${e.name}」`; }
    // <% %> 模板是发送前才渲染的，激活时的内容对不上，用模板里固定的文字片段去认
    for (const [id, info] of ENTRY) {
        if (!info.macro) continue;
        const parts = info.raw.split(/<%[\s\S]*?%>|\{\{[\s\S]*?\}\}/).map(x => x.trim()).filter(x => x.length >= 12);
        if (parts.some(covers)) { CHECK.hitId = id; return `世界书「${info.name}」`; }
    }
    for (const key of VECTOR_KEYS) if (covers(String(extension_prompts[key]?.value || ''))) return '向量召回';
    for (const key of Object.keys(extension_prompts)) {
        if (EXT_SKIP.test(key) || VECTOR_KEYS.includes(key)) continue;
        const raw = String(extension_prompts[key]?.value || '');
        const parts = [raw, ...raw.split(/\{\{[\s\S]*?\}\}/).map(x => x.trim()).filter(x => x.length >= 12)];
        if (parts.some(covers)) { CHECK.extHit = key; return `插件注入「${key}」`; }
    }
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
    if (!prev) { CHECK.history = []; showCheckup('等下一轮再比（第一轮没东西可比）', null); return; }

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
        CHECK.hitId = null; CHECK.extHit = null;
        const who = whoIsAt(now[k].text, pos) || (k < prev.length ? whoIsAt(prev[k].text, pos) : '');
        CHECK.lastWho = who;
        if (CHECK.hitId && tail > 3 && markVolatile(CHECK.hitId, '体检发现它在变')) where = '（已记下，下一轮起挪到末尾）';
        if (CHECK.extHit && tail > 3 && settings().extToEnd && markExtVolatile(CHECK.extHit, '体检发现它在变')) where = '（已记下，下一轮起挪到末尾）';
        where = `从第 ${k + 1} 条（共 ${now.length} 条）开始变` + (who ? `，是 ${who}` : '') + `：「${snippet(now[k].text, pos)}」` + where;
    }
    const ok = pct >= 70 || tail <= 3;   // 只在最后两三条变 = 正常的新对话
    let lead = 0;
    while (lead < now.length && now[lead].role === 'system') lead++;
    CHECK.history.push({ pct, at: k < now.length ? k + 1 : null, n: now.length, lead, who: k < now.length ? (CHECK.lastWho || '') : '', ok });
    if (CHECK.history.length > 10) CHECK.history.shift();
    const dx = diagnose();
    if (dx) where += `\n诊断：${dx}`;
    showCheckup(`本轮前缀不变 ${pct}%` + (where ? `｜${where}` : ''), ok);
    if (!ok && s.checkupToast && typeof toastr !== 'undefined') {
        toastr.warning(`前面只有 ${pct}% 没变，缓存大半作废。\n${where}`, '缓存体检', { timeOut: 8000 });
    }
    if (s.log) console.log('[Cache Friendly] checkup', pct, where);
}

// ── 诊断：从最近几轮的"在哪儿变"认出常见病因（1.6.0）──────────────────────
// 1) 每轮都在"离结尾固定第 N 条"变 → 记忆/摘要插件每轮隐藏一层旧楼层
// 2) 总条数不涨、从聊天第一条就变 → 上下文满了，酒馆每轮砍最老的消息
// 3) 从第 1 条（最顶上）就变 → 有东西把会变的内容塞在了最前面
function diagnose() {
    const h = CHECK.history.filter(x => !x.ok && x.at);
    const last = CHECK.history[CHECK.history.length - 1];
    if (!last || last.ok || !last.at) return '';
    if (last.who) return '';   // 已经认出是哪条了，不用猜
    if (last.at === 1) return '从最顶上第 1 条就在变：有插件或预设把会变的内容放在了所有东西最前面（状态表、总结、骰子、时间之类）。找到它，改成插在聊天末尾 / 深度 0。';
    const r = h.slice(-3);
    if (r.length >= 3) {
        const tails = r.map(x => x.n - x.at);
        const grow = r[r.length - 1].n - r[0].n;
        if (Math.max(...tails) - Math.min(...tails) <= 2 && grow >= 2)
            return `每轮都在离结尾约 ${tails[tails.length - 1]} 条的地方变：多半是记忆 / 摘要插件在每轮自动隐藏旧楼层。这个修不了，建议把它设成"攒够一批再隐藏"。`;
        if (Math.abs(grow) <= 1 && r.every(x => x.at <= x.lead + 2))
            return '聊天条数不再增加、每轮从聊天记录开头就变：上下文满了，酒馆每轮在砍最老的消息。把上下文长度（Context Size）调大就好。';
    }
    return '';
}

// ── 测试报告 ─────────────────────────────────────────────────────
// 一键生成一段纯文字，测试的人贴到群里就行。不含接口地址、钥匙、聊天内容；
// 模型名前面 [xxx] 这种通道前缀也去掉。
async function buildReport() {
    const s = settings();
    const ctx = SillyTavern.getContext();
    const oai = ctx.chatCompletionSettings || {};
    let ver = '?', st = '?';
    try { ver = (await (await fetch(new URL('./manifest.json', import.meta.url))).json()).version; } catch { /* 拿不到就算了 */ }
    try { st = (await (await fetch('/version')).json()).pkgVersion || '?'; } catch { /* 同上 */ }
    const src = oai.chat_completion_source || '?';
    const rawModel = String((src === 'custom' ? oai.custom_model : oai[`${src}_model`]) || oai.openai_model || '?');
    const model = rawModel.replace(/^\s*\[[^\]]*\]\s*/, '');
    const on = (b) => (b ? '开' : '关');
    const vol = (volatileSet() || []).map(id => ENTRY.get(id)?.name || id);
    const lines = [
        '【Cache Friendly 测试报告】',
        `插件 ${ver} ｜ 酒馆 ${st}`,
        `接口来源：${src} ｜ 模型：${model}`,
        `开关：挪世界书 ${on(s.enabled)}｜带变量一律挪 ${on(s.strictMacro)}｜深度条目收尾 ${on(s.depthToEnd)}｜向量召回 ${on(s.vectorsToEnd)}｜插件注入 ${on(s.extToEnd)}｜自动Claude缓存 ${on(s.claudeCache)}｜1小时 ${on(s.cache1h)}`,
        `最近一轮：挪了 ${STAT.moved} 条世界书，收尾 ${STAT.flattened} 条深度条目，向量召回 ${STAT.vectors ? '已挪' : '无/未挪'}，插件注入挪了 ${STAT.ext} 条`,
        `检测到在变、已挪走的插件注入：${(extVolatileSet() || []).join('、') || '无'}`,
        `本聊天里检测到在变、已挪走的常驻条目：${vol.length ? vol.join('、') : '无'}`,
        `最近 ${CHECK.history.length} 轮体检（前缀不变%）：`,
        ...CHECK.history.map((h, i) => `  ${i + 1}. ${h.pct}%` + (h.at ? `，从第 ${h.at}/${h.n} 条开始变` : '') + (h.who ? `（${h.who}）` : '') + (h.ok ? '' : ' ⚠')),
        ...(diagnose() ? [`诊断：${diagnose()}`] : []),
        '（请再附一张用量记录截图：缓存读取 / 写入，记得打码钥匙）',
    ];
    if (!CHECK.history.length) lines.splice(8, 0, '  还没有数据：先聊两三轮再生成');
    return lines.join('\n');
}

async function copyReport() {
    const text = await buildReport();
    const box = document.getElementById('cf_report_box');
    if (box) { box.value = text; box.style.display = 'block'; }
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
        try { box?.select(); ok = document.execCommand('copy'); } catch { /* 手动复制 */ }
    }
    if (typeof toastr !== 'undefined') toastr[ok ? 'success' : 'info'](ok ? '已复制，贴到群里就行' : '复制不了，请在下面的框里长按全选复制', '测试报告');
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
          <small>绿灯条目一律挪到深度 0。带 {{getvar}} / &lt;% %&gt; 的常驻条目先留在原位，检测到前后两轮内容真的变了才挪。条目标题写 [cf:end] 强制挪、[cf:keep] 强制不挪。</small>
          <label class="checkbox_label"><input id="cf_strict" type="checkbox"> 带变量的条目一律挪（旧版做法）</label>
          <small>不等检测，带变量/模板的条目直接挪到末尾。缓存更稳，但一整局都不变的条目也会被挪走。</small>
          <label class="checkbox_label"><input id="cf_depth" type="checkbox"> 按深度插入的世界书也收到末尾</label>
          <small>@深度 N 的条目改成深度 0，不再插在聊天中间。</small>
          <label class="checkbox_label"><input id="cf_vec" type="checkbox"> 向量召回挪到聊天末尾</label>
          <small>聊天记录向量化、资料库每轮捞出来的片段不一样，挪到最后就不打碎前面的缓存。</small>
          <label class="checkbox_label"><input id="cf_ext" type="checkbox"> 其他插件的注入：变了就挪到末尾</label>
          <small>数据库 / 表格、总结、小白X、/inject 等插件塞进来的内容，检测到前后两轮真的变了，就从下一轮起挪到聊天末尾。不变的不动。</small>
          <label class="checkbox_label"><input id="cf_claude" type="checkbox"> 自定义接口用 Claude 时自动开缓存</label>
          <small>"自定义（OpenAI 兼容）"连 Claude 模型时，自动打缓存标记（system + 聊天记录滚动缓存）。接口要认这个标记才生效；用"Claude"接口的请改 config.yaml。</small>
          <label class="checkbox_label"><input id="cf_1h" type="checkbox"> 用 1 小时缓存</label>
          <small>写入贵一倍，适合聊得慢、经常隔十几分钟才回一句。</small>
          <hr>
          <label class="checkbox_label"><input id="cf_check" type="checkbox"> 缓存体检</label>
          <small>每轮比一比：前面有多少跟上一轮一模一样（这部分才能吃到缓存）。</small>
          <div id="cf_checkup_text" style="font-size:0.9em;margin:4px 0 6px;word-break:break-all;">还没发过消息</div>
          <label class="checkbox_label"><input id="cf_check_toast" type="checkbox"> 掉到 70% 以下时弹提示，告诉我是哪儿变了</label>
          <div id="cf_report" class="menu_button" style="margin:6px 0;width:fit-content;">📋 复制测试报告</div>
          <textarea id="cf_report_box" class="text_pole" rows="8" readonly style="display:none;font-size:0.85em;"></textarea>
          <label class="checkbox_label"><input id="cf_log" type="checkbox"> 在浏览器控制台打印挪了几条</label>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#cf_enabled').prop('checked', s.enabled).on('input', function () { settings().enabled = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_strict').prop('checked', s.strictMacro).on('input', function () { settings().strictMacro = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_depth').prop('checked', s.depthToEnd).on('input', function () { settings().depthToEnd = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_vec').prop('checked', s.vectorsToEnd).on('input', function () { settings().vectorsToEnd = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_ext').prop('checked', s.extToEnd).on('input', function () { settings().extToEnd = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_claude').prop('checked', s.claudeCache).on('input', function () { settings().claudeCache = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_1h').prop('checked', s.cache1h).on('input', function () { settings().cache1h = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_check').prop('checked', s.checkup).on('input', function () { settings().checkup = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_check_toast').prop('checked', s.checkupToast).on('input', function () { settings().checkupToast = !!$(this).prop('checked'); saveSettingsDebounced(); });
    $('#cf_report').on('click', copyReport);
    $('#cf_log').prop('checked', s.log).on('input', function () { settings().log = !!$(this).prop('checked'); saveSettingsDebounced(); });
}

jQuery(() => {
    settings();
    addSettingsUi();
    eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    eventSource.on(event_types.CHAT_CHANGED, () => { LAST.clear(); EXT_LAST.clear(); });
});
