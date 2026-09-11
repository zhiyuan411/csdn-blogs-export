/**
 * 文章「主题」（CSDN 分类专栏）提取模块
 *
 * 详情页结构与失效历史（均以真实页面原始 HTML 为依据）：
 *   1) 旧版：「分类专栏」链接形如 <a class="tag-link" href=".../category_xxx.html" rel="noopener">读书笔记</a>
 *      → 原实现用 XPath //a[@class="tag-link" and @rel="noopener"] 取第一个专栏名。
 *   2) 2026-09 改版：分类专栏上移到头部「收录于」区（<span class="badge-name">读书笔记</span>），
 *      文章标签改名为 class="tag-link-new"（文本带 # 前缀、指向搜索页）。
 *      → 旧 XPath 精确匹配 class="tag-link" 命中 0 个元素，主题恒为 null。
 *   3) 2026-09 补充排查（对 104 篇真实抓取日志逐篇核对后确认）：
 *      · 免费专栏文章：头部「收录于」徽标由服务端直出（data-column-count="1"），<span class="badge-name"> 可直接取到；
 *        —— 实测命中值（生活娱乐/计算机技术/AI底稿/文学社科/修身养性）全部正确。
 *      · 付费专栏文章：头部徽标区被**刻意置空**（data-column-count="0" + display:none），专栏名改由
 *        服务端直出在「付费专栏卡」里：<div id="blogColumnPayAdvert"> … <a class="item-target" title="计算机技术杂谈">
 *        … <span class="tit">计算机技术杂谈</span>。此前落到 meta 策略的 35 篇正是这批付费专栏文章。
 *      · <meta property="article:section"> 实测等于「文章的第一个标签」（如 qt / CoT / mysql / neo4j），
 *        与专栏是两套命名空间（专栏名为 计算机技术杂谈 / 股票技术杂谈 / 读书笔记 等），故该策略已删除。
 *      · VIP 文章（如 156650675）：头部徽标区同样被置空（data-column-count="0"、无 .badge-name），
 *        也没有付费专栏卡；专栏名在右侧工具栏「专栏目录」按钮上（服务端直出）：
 *        <a class="bt-columnlist-show" data-title="计算机技术" data-url=".../category_11642677.html">。
 *        该按钮三类页面（普通/收费/VIP）均存在、每页唯一、不经 JS，故升为首选来源；
 *        只取 data-title（data-description 恰好同名，但语义是描述，按要求不使用）。
 *      · 「分类专栏」类面板（a.special-column-name）列出作者**全部**专栏、文本带「付费/篇」、无 title，
 *        与本文归属无关；而且页面上有**两份重复副本**（#asideCategory 与
 *        .aside-box.kind_person #kind_person_column，各 17 条）——只排除其中一份，另一份照样会把
 *        17 个专栏当主题（实测把 VIP 文章 156650675 判成「计算机技术杂谈 付费」）。
 *        凡是"列出作者全部专栏"的面板都无法据此判断归属，故泛化兜底（a[href*="category_"]）已删除。
 *
 * 设计要点：
 *   1. 多策略（SUBJECT_STRATEGIES）按优先级依次尝试，任一命中即返回：
 *      付费专栏卡 →「专栏目录」按钮的 data-title（三类页面通吃）
 *      → 头部「收录于」徽标（免费专栏，三种松紧度）→ 头部下拉卡片 → 旧版精确选择器。
 *      以上均为服务端直出来源，不依赖 JS 渲染时机。
 *      详情页再次改版时，只要有一条策略仍能命中即可继续工作。
 *   2. 所有策略在浏览器端一次 evaluate 内完成，策略以纯数据描述（便于单测与顺序审查）。
 *   3. 多专栏文章取 DOM 顺序第一个（沿用旧行为），全部候选一并返回供日志核对。
 *      优先级刻意把「付费专栏卡」放在最前：文章同时属于付费与免费专栏时，优先归入付费目录。
 *   4. 主题缺失只影响「保存目录」（调用方回落默认目录），本模块永不抛错中断导出。
 */

// 主题文本的最大长度（超过视为误命中的正文/描述文本）
export const SUBJECT_MAX_LENGTH = 30;

// 主题文本噪声黑名单：整串命中这些文案视为无效（避免把提示词、按钮、版式文案当主题）
export const SUBJECT_NOISE_WORDS = [
    '收录于',
    '当前文章被收录于',
    '当前文章被以下社区和专栏收录',
    '专栏收录该内容',
    '收录该内容',
    '订阅专栏',
    '超级会员免费看',
    '标签',
    '文章标签',
    '分类专栏',
    '专栏',
    '专栏目录',
    '原创',
    '转载',
    '翻译',
    '更多',
    '查看详情',
    '收起',
    '展开'
];

// 主题文本噪声片段：文本中**包含**这些片段即视为无效
// 用途：整串拼接后的版式文案（如 "计算机技术杂谈 专栏收录该内容"、"98 篇文章"）也必须被剔除
export const SUBJECT_NOISE_PATTERNS = [
    '收录该内容',
    '篇文章',
    '订阅专栏',
    '超级会员免费看',
    '查看详情',
    '收录于',
    '当前文章被'
];

/**
 * 主题提取策略列表（按优先级排列：先服务端直出的精确来源，再旧版，最后泛化兜底）
 * - type: 'css' 用 document.querySelectorAll；'xpath' 用 document.evaluate（兼容旧版页面结构）
 * - attr: 优先读取该属性（比文本干净），缺失或为空时回落 textContent
 * - attrOnly: 属性为空时**不**回落文本（按钮型元素：文本是"专栏目录"这类按钮文案，回落必然取错）
 * - exclude: 命中元素若位于该容器内则丢弃（避免误取与本文无关的专栏列表）
 * @type {Array<{name: string, type: 'css'|'xpath', selector: string, attr?: string,
 *               attrOnly?: boolean, exclude?: string, description: string}>}
 */
export const SUBJECT_STRATEGIES = [
    {
        name: 'pay-column-card-title',
        type: 'css',
        selector: '#blogColumnPayAdvert .column-group-item .item-target[title]',
        attr: 'title',
        description: '付费专栏卡中专栏链接的 title：付费专栏文章的头部「收录于」区被置空（data-column-count="0"），此处是唯一可靠来源'
    },
    {
        name: 'pay-column-card-tit',
        type: 'css',
        selector: '#blogColumnPayAdvert .column-group-item .tit',
        description: '付费专栏卡中的专栏名节点 <span class="tit">（卡片结构微调时的兜底；刻意不取 .title 容器，避免拼上"专栏收录该内容"）'
    },
    {
        name: 'column-directory-title',
        type: 'css',
        selector: 'a.bt-columnlist-show[data-title]',
        attr: 'data-title',
        attrOnly: true,
        description: '右侧工具栏「专栏目录」按钮的 data-title：三类页面（普通/收费/VIP）服务端直出、每页唯一，即本文所属专栏（多专栏时为第一个）'
    },
    {
        name: 'tool-directory-title',
        type: 'css',
        selector: '.tool-directory [data-title]',
        attr: 'data-title',
        attrOnly: true,
        description: '同上（按钮类名变化时的兜底）：工具栏目录区中带 data-title 的元素'
    },
    {
        name: 'header-collect-badge-name',
        type: 'css',
        selector: '#article-header-collect-list .article-header-badge .badge-name',
        exclude: '#article-header-collect-more-btn',
        description: '头部「收录于」徽标内的专栏名（免费专栏，服务端直出；限定 .article-header-badge 以免混入社区等其他徽标）'
    },
    {
        name: 'header-badge-name',
        type: 'css',
        selector: '.article-header-badge .badge-name',
        exclude: '#article-header-collect-more-btn',
        description: '头部徽标内的专栏名（容器 id / 类名变化时的兜底）'
    },
    {
        name: 'header-collect-badge-name-loose',
        type: 'css',
        selector: '#article-header-collect-list .badge-name',
        exclude: '#article-header-collect-more-btn',
        description: '头部「收录于」区内任意 badge-name（徽标类名变化时的兜底；排除"更多"折叠区，避免把社区名当专栏）'
    },
    {
        name: 'column-detail-title',
        type: 'css',
        selector: 'a.column-detail-link[title]',
        attr: 'title',
        description: '头部专栏下拉卡片内专栏链接的 title 属性（比文本干净，无多余空白）'
    },
    {
        name: 'column-dropdown-name',
        type: 'css',
        selector: '.dropdown-column-main .dropdown-name, .article-header-badge-trigger .badge-name',
        description: '头部专栏下拉卡片中的专栏名'
    },
    {
        name: 'legacy-tag-link',
        type: 'xpath',
        selector: '//a[@class="tag-link" and @rel="noopener"]',
        description: '旧版详情页「分类专栏」链接（class 精确匹配，不会误命中新版标签 tag-link-new）'
    },
    {
        name: 'legacy-span-tit',
        type: 'xpath',
        selector: '//span[@class="tit"]',
        description: '旧版详情页专栏名的备选容器（新版仅在付费专栏卡中出现，是 pay-column-card-tit 的 XPath 版兜底）'
    }
];

/**
 * 主题文本清洗（不含业务校验）：去 &nbsp;、合并连续空白、去首尾空白
 * @param {*} raw - 原始文本或属性值
 * @returns {string|null} 清洗后的文本，无内容时返回 null
 */
export function normalizeSubjectText(raw) {
    if (typeof raw !== 'string') return null;
    const text = raw.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return text || null;
}

/**
 * 主题有效性校验（业务规则）
 * 过滤：空文本、噪声文案（"收录于"等，含片段匹配）、超长文本（正文/描述误命中）、
 *      以 # 开头（文章标签的渲染形式，如 #mysql）、纯数字/纯符号（专栏名不会如此）
 * @param {string|null} text - 已清洗的文本
 * @returns {boolean} 是否为有效主题
 */
export function isValidSubject(text) {
    if (!text) return false;
    if (text.length > SUBJECT_MAX_LENGTH) return false;
    if (SUBJECT_NOISE_WORDS.includes(text)) return false;
    if (SUBJECT_NOISE_PATTERNS.some(pattern => text.includes(pattern))) return false;
    // 以 # 开头是文章标签的渲染形式（新版标签 class="tag-link-new" 文本形如 "#mysql"）
    if (text.startsWith('#')) return false;
    // 至少包含一个中文或英文字母（排除纯数字、纯符号、纯 emoji）
    return /[\u4e00-\u9fa5a-zA-Z]/.test(text);
}

/**
 * 清洗 + 校验，返回有效主题或 null
 * @param {*} raw - 原始文本或属性值
 * @returns {string|null} 有效主题
 */
export function normalizeSubject(raw) {
    const text = normalizeSubjectText(raw);
    return isValidSubject(text) ? text : null;
}

/**
 * 按顺序返回第一个有效主题（多候选时的统一取值规则：取第一个）
 * @param {Array<*>} rawList - 原始候选值列表
 * @returns {string|null} 有效主题
 */
export function pickFirstValidSubject(rawList = []) {
    for (const raw of rawList) {
        const subject = normalizeSubject(raw);
        if (subject) return subject;
    }
    return null;
}

/**
 * 去重（保持首次出现顺序）
 * @param {Array<string>} list - 待去重列表
 * @returns {Array<string>} 去重结果
 */
function unique(list) {
    return [...new Set(list)];
}

/**
 * 浏览器端采集回调：按策略列表逐条取值（每条策略独立 try/catch，单条选择器失效不影响其它策略）
 *
 * 注意：该函数由 Puppeteer 序列化为源码后在页面上下文执行，因此不得引用本模块的任何外部变量。
 * @param {Array<Object>} strategyList - 策略列表
 * @returns {Array<{name: string, values: Array<string>, error?: string}>} 每条策略的原始候选值
 */
export function collectSubjectCandidates(strategyList) {
    const readValue = (el, strategy) => {
        if (!el) return '';
        if (strategy.attr) {
            const value = el.getAttribute(strategy.attr);
            if (value && value.trim()) return value;
            // attrOnly：属性是唯一有效来源，属性缺失时回落按钮文案（如"专栏目录"）必然取错
            if (strategy.attrOnly) return '';
        }
        // attr 缺失或为空时回落元素文本
        return el.textContent || '';
    };
    // 排除规则：元素若位于 exclude 指定的容器内则丢弃（如左侧栏「分类专栏」面板）
    const isExcluded = (el, exclude) => {
        if (!exclude || !el || typeof el.closest !== 'function') return false;
        try {
            return Boolean(el.closest(exclude));
        } catch (err) {
            // 非法选择器不应让整条策略失败
            return false;
        }
    };
    const collectValue = (values, el, strategy) => {
        if (isExcluded(el, strategy.exclude)) return;
        values.push(readValue(el, strategy));
    };
    const runStrategy = (strategy) => {
        const values = [];
        if (strategy.type === 'xpath') {
            const snapshot = document.evaluate(strategy.selector, document, null,
                XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < snapshot.snapshotLength; i++) {
                collectValue(values, snapshot.snapshotItem(i), strategy);
            }
        } else {
            document.querySelectorAll(strategy.selector).forEach((el) => {
                collectValue(values, el, strategy);
            });
        }
        return values;
    };
    return strategyList.map((strategy) => {
        try {
            return { name: strategy.name, values: runStrategy(strategy) };
        } catch (err) {
            return { name: strategy.name, values: [], error: (err && err.message) || String(err) };
        }
    });
}

/**
 * 提取文章主题（CSDN 分类专栏）
 *
 * 在浏览器端一次性执行所有策略（见 collectSubjectCandidates），再在 Node 端按策略优先级
 * 做清洗与校验，返回第一个命中的策略及其候选列表。
 *
 * 注意：本函数不会抛错——页面已关闭/采集异常时返回 subject=null 并附 error 信息，
 *      由调用方决定是否告警；主题缺失只会让文章落到默认下载目录。
 *
 * @param {import('puppeteer').Page} page - 页面对象
 * @param {Array<Object>} [strategies=SUBJECT_STRATEGIES] - 策略列表（可注入，便于测试）
 * @returns {Promise<{subject: string|null, subjects: Array<string>, strategy: string|null,
 *                    attempted: Array<string>, rejected: Array<string>, error: string|null}>}
 *          subject：第一个有效主题；subjects：该策略命中的全部有效主题（多专栏）；
 *          strategy：命中的策略名；attempted：已尝试的策略名（含异常标记）；
 *          rejected：被校验过滤掉的原始候选（非空即说明选择器命中了"非主题"文本，是改版的早期信号）
 */
export async function extractArticleSubject(page, strategies = SUBJECT_STRATEGIES) {
    const emptyResult = {
        subject: null,
        subjects: [],
        strategy: null,
        attempted: [],
        rejected: [],
        error: null
    };
    if (!page || typeof page.evaluate !== 'function') {
        return { ...emptyResult, error: '非法的 page 对象（缺少 evaluate 方法）' };
    }

    let rawResults;
    try {
        rawResults = await page.evaluate(collectSubjectCandidates, strategies);
    } catch (err) {
        // 采集阶段整体失败（页面已关闭、导航中断等）
        return { ...emptyResult, error: (err && err.message) || String(err) };
    }
    if (!Array.isArray(rawResults)) {
        return { ...emptyResult, error: '页面采集返回了非预期的结果' };
    }

    const attempted = [];
    const rejected = [];
    for (const result of rawResults) {
        if (result.error) {
            attempted.push(`${result.name}(异常:${result.error})`);
            continue;
        }
        attempted.push(result.name);
        const subjects = unique(result.values.map(normalizeSubject).filter(Boolean));
        // 记录被过滤掉的候选（每条策略最多 5 个、每个截断 40 字，避免日志爆炸）
        // 用途：区分"该文章确实没有专栏"与"选择器命中了但内容不是主题"（后者是改版的早期信号）
        const rejectedTexts = unique(result.values
            .map(normalizeSubjectText)
            .filter((text) => text && !isValidSubject(text)))
            .slice(0, 5);
        rejected.push(...rejectedTexts.map((text) => `${result.name}:"${text.slice(0, 40)}"`));
        if (subjects.length > 0) {
            return {
                subject: subjects[0],
                subjects,
                strategy: result.name,
                attempted,
                rejected,
                error: null
            };
        }
    }
    return { ...emptyResult, attempted, rejected };
}
