/**
 * 文章「主题」（CSDN 分类专栏）提取模块
 *
 * 2026-09 详情页改版导致的失效（现象：所有文章 article.subject 恒为 null）：
 *   旧版详情页的「分类专栏」链接形如 <a class="tag-link" href=".../category_xxx.html" rel="noopener">读书笔记</a>，
 *   原实现用 XPath //a[@class="tag-link" and @rel="noopener"] 取第一个专栏名。
 *   新版详情页把「分类专栏」上移到头部「收录于」区域：
 *     <div class="article-header-badge"><span class="badge-name">读书笔记</span></div>
 *   同时把「文章标签」改名为 class="tag-link-new"（文本带 # 前缀，指向搜索页而非专栏页）。
 *   于是旧 XPath 精确匹配 class="tag-link" 命中 0 个元素，主题必然为 null。
 *
 * 设计要点：
 *   1. 多策略（SUBJECT_STRATEGIES）按优先级依次尝试，任一命中即返回：
 *      新版精确选择器 → 通用 meta → 旧版精确选择器 → 泛化兜底（任意 category_ 链接）。
 *      详情页再次改版时，只要有一条策略仍能命中即可继续工作。
 *   2. 所有策略在浏览器端一次 evaluate 内完成，策略以纯数据描述（便于单测与顺序审查）。
 *   3. 多专栏文章取 DOM 顺序第一个（沿用旧行为），全部候选一并返回供日志核对。
 *   4. 主题缺失只影响「保存目录」（调用方回落默认目录），本模块永不抛错中断导出。
 */

// 主题文本的最大长度（超过视为误命中的正文/描述文本）
export const SUBJECT_MAX_LENGTH = 30;

// 主题文本噪声黑名单：命中这些文案视为无效（避免把提示词、按钮、版式文案当主题）
export const SUBJECT_NOISE_WORDS = [
    '收录于',
    '当前文章被收录于',
    '当前文章被以下社区和专栏收录',
    '标签',
    '文章标签',
    '分类专栏',
    '专栏',
    '原创',
    '转载',
    '翻译',
    '更多',
    '查看详情',
    '收起',
    '展开'
];

/**
 * 主题提取策略列表（按优先级排列，先精确后兜底）
 * - type: 'css' 用 document.querySelectorAll；'xpath' 用 document.evaluate（兼容旧版页面结构）
 * - attr: 优先读取该属性（比文本干净），缺失或为空时回落 textContent
 * @type {Array<{name: string, type: 'css'|'xpath', selector: string, attr?: string, description: string}>}
 */
export const SUBJECT_STRATEGIES = [
    {
        name: 'header-collect-badge-name',
        type: 'css',
        selector: '#article-header-collect-list .badge-name',
        description: '新版详情页头部「收录于」徽标内的专栏名（如：读书笔记 / 修身养性）'
    },
    {
        name: 'header-badge-name',
        type: 'css',
        selector: '.article-header-badge .badge-name',
        description: '新版详情页头部徽标（容器 id 被改动时的兜底）'
    },
    {
        name: 'column-detail-title',
        type: 'css',
        selector: 'a.column-detail-link[title]',
        attr: 'title',
        description: '新版详情页专栏详情链接的 title 属性（比文本更干净，无多余空白）'
    },
    {
        name: 'column-dropdown-name',
        type: 'css',
        selector: '.dropdown-column-main .dropdown-name, .article-header-badge-trigger .badge-name',
        description: '新版详情页专栏下拉卡片中的专栏名'
    },
    {
        name: 'meta-article-section',
        type: 'css',
        selector: 'meta[property="article:section"]',
        attr: 'content',
        description: '页面 meta 元数据 article:section（新旧版通用的通用兜底，多专栏时取主专栏）'
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
        description: '旧版详情页专栏名的备选容器'
    },
    {
        name: 'category-href-link',
        type: 'css',
        selector: 'a[href*="category_"]',
        attr: 'title',
        description: '泛化兜底：任意指向专栏页（category_xxx.html）的链接，兼容未知改版'
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
 * 过滤：空文本、噪声文案（"收录于"等）、超长文本（正文/描述误命中）、纯数字/纯符号（专栏名不会如此）
 * @param {string|null} text - 已清洗的文本
 * @returns {boolean} 是否为有效主题
 */
export function isValidSubject(text) {
    if (!text) return false;
    if (text.length > SUBJECT_MAX_LENGTH) return false;
    if (SUBJECT_NOISE_WORDS.includes(text)) return false;
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
    const readValue = (el, attr) => {
        if (!el) return '';
        if (attr) {
            const value = el.getAttribute(attr);
            if (value && value.trim()) return value;
        }
        // attr 缺失或为空时回落元素文本
        return el.textContent || '';
    };
    const runStrategy = (strategy) => {
        const values = [];
        if (strategy.type === 'xpath') {
            const snapshot = document.evaluate(strategy.selector, document, null,
                XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            for (let i = 0; i < snapshot.snapshotLength; i++) {
                values.push(readValue(snapshot.snapshotItem(i), strategy.attr));
            }
        } else {
            document.querySelectorAll(strategy.selector).forEach((el) => {
                values.push(readValue(el, strategy.attr));
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
