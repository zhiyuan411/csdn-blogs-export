/**
 * 主题（CSDN 分类专栏）提取的单元测试
 *
 * 覆盖三类回归：
 *  1. 三类详情页结构必须各自有策略覆盖：普通/免费（头部「收录于」徽标）、收费（付费专栏卡）、
 *     VIP（右侧工具栏「专栏目录」按钮 data-title）；
 *     旧选择器 a.tag-link / span.tit 已在新版失效，只作最后兜底；
 *  2. 已证实错误的来源不得再出现在策略列表中：
 *     meta[article:section]（实测=文章第一个标签，如 qt/CoT）、新版标签 class（tag-link-new）、
 *     「分类专栏」面板（实测列出作者全部 17 个专栏，且页面有两份重复副本 →
 *      曾把 VIP 文章 156650675 判成「计算机技术杂谈 付费」）；
 *  3. 改版期间（或再次改版）不能让提取异常中断整个导出：任何异常都必须降级为 subject=null。
 *
 * 说明：浏览器端的采集回调通过 node:vm + 最小 DOM 桩执行，因此本测试不需要浏览器与 config.yml。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
    SUBJECT_STRATEGIES,
    SUBJECT_MAX_LENGTH,
    extractArticleSubject,
    isValidSubject,
    normalizeSubject,
    normalizeSubjectText,
    pickFirstValidSubject
} from '../lib/article-subject.js';

// 付费专栏页的真实选择器（原始 HTML：#blogColumnPayAdvert 内的「付费专栏卡」）
// 付费专栏文章的头部「收录于」区被置空（data-column-count="0"），专栏名只在这里
const PAY_CARD_TITLE_SELECTOR = '#blogColumnPayAdvert .column-group-item .item-target[title]';
const PAY_CARD_TIT_SELECTOR = '#blogColumnPayAdvert .column-group-item .tit';
// 免费专栏页的真实选择器（原始 HTML：头部「收录于」徽标，服务端直出）
const BADGE_SELECTOR = '#article-header-collect-list .article-header-badge .badge-name';
const BADGE_UNSCOPED_SELECTOR = '.article-header-badge .badge-name';
const BADGE_LOOSE_SELECTOR = '#article-header-collect-list .badge-name';
const COLUMN_TITLE_SELECTOR = 'a.column-detail-link[title]';
// 「专栏目录」按钮（普通/收费/VIP 三类页面通吃，服务端直出且每页唯一）
const COLUMN_DIRECTORY_SELECTOR = 'a.bt-columnlist-show[data-title]';
const TOOL_DIRECTORY_SELECTOR = '.tool-directory [data-title]';
// 污染区（必须被策略排除）
const MORE_BTN_SELECTOR = '#article-header-collect-more-btn';
// 旧版详情页的真实选择器
const LEGACY_TAG_LINK_XPATH = '//a[@class="tag-link" and @rel="noopener"]';
const LEGACY_TIT_XPATH = '//span[@class="tit"]';

/**
 * 构造最小 DOM 桩：按选择器返回元素列表（值可以是 Error，用于模拟选择器抛错）
 * @param {Object} cssMap - CSS 选择器 → 元素数组（或 Error）
 * @param {Object} xpathMap - XPath → 元素数组（或 Error）
 */
function createDomStub(cssMap = {}, xpathMap = {}) {
    const resolve = (map, selector) => {
        const value = map[selector];
        if (value instanceof Error) throw value;
        return value || [];
    };
    return {
        document: {
            querySelectorAll: (selector) => resolve(cssMap, selector),
            evaluate: (selector) => {
                const nodes = resolve(xpathMap, selector);
                return {
                    snapshotLength: nodes.length,
                    snapshotItem: (index) => nodes[index]
                };
            }
        },
        XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 }
    };
}

/**
 * 构造元素桩
 * @param {string} text - 元素文本
 * @param {Object} attrs - 属性表（缺省时 getAttribute 返回 null，触发回落 textContent）
 * @param {Array<string>} excludedBy - 该元素所在的容器选择器（用于模拟 closest 命中排除规则）
 */
function el(text = '', attrs = {}, excludedBy = []) {
    return {
        textContent: text,
        getAttribute: (name) => (name in attrs ? attrs[name] : null),
        closest: (selector) => (excludedBy.includes(selector) ? { selector } : null)
    };
}

/**
 * 构造 page 桩：把真实的浏览器端采集回调放进 vm 执行，模拟 Puppeteer 的序列化行为
 * @param {Object} cssMap - CSS 选择器 → 元素数组（或 Error）
 * @param {Object} xpathMap - XPath → 元素数组（或 Error）
 */
function createPageStub(cssMap = {}, xpathMap = {}) {
    const sandbox = createDomStub(cssMap, xpathMap);
    return {
        evaluate: async (fn, strategies) => {
            const collector = vm.runInNewContext(`(${fn.toString()})`, sandbox);
            return collector(strategies);
        }
    };
}

/** 取策略名列表 */
const strategyNames = () => SUBJECT_STRATEGIES.map(strategy => strategy.name);

test('normalizeSubjectText：去 &nbsp;、合并连续空白并按需去首尾空白', () => {
    assert.equal(normalizeSubjectText('  读书笔记  '), '读书笔记');
    assert.equal(normalizeSubjectText('读书\u00a0笔记'), '读书 笔记');
    assert.equal(normalizeSubjectText(' 读书\n笔记 '), '读书 笔记');
    assert.equal(normalizeSubjectText('   '), null);
    assert.equal(normalizeSubjectText(null), null);
    assert.equal(normalizeSubjectText(123), null);
});

test('normalizeSubject：接受正常专栏名，过滤噪声/超长/纯数字/标签等无效文本', () => {
    assert.equal(normalizeSubject('读书笔记'), '读书笔记');
    assert.equal(normalizeSubject('修身养性'), '修身养性');
    assert.equal(normalizeSubject('计算机技术杂谈'), '计算机技术杂谈');
    assert.equal(normalizeSubject('front-end'), 'front-end');
    assert.equal(normalizeSubject('  Java 并发 '), 'Java 并发');
    // 噪声文案：新版头部有「收录于」「当前文章被收录于：」等版式文案
    assert.equal(normalizeSubject('收录于'), null);
    assert.equal(normalizeSubject('当前文章被收录于'), null);
    assert.equal(normalizeSubject('标签'), null);
    assert.equal(normalizeSubject('查看详情'), null);
    // 噪声片段：整串拼接后的版式文案（付费专栏卡 / 左侧栏）也必须被剔除
    assert.equal(normalizeSubject('计算机技术杂谈 专栏收录该内容'), null);
    assert.equal(normalizeSubject('98 篇文章'), null);
    assert.equal(normalizeSubject('订阅专栏'), null);
    // 文章标签的渲染形式（以 # 开头）不是主题
    assert.equal(normalizeSubject('#mysql'), null);
    assert.equal(normalizeSubject('#读书笔记'), null);
    // 「专栏目录」按钮文案不是主题（data-title 缺失时的兜底防线）
    assert.equal(normalizeSubject('专栏目录'), null);
    // 超长（正文/描述误命中）与无文字内容
    assert.equal(normalizeSubject('主'.repeat(SUBJECT_MAX_LENGTH + 1)), null);
    assert.equal(normalizeSubject('12345'), null);
    assert.equal(normalizeSubject('###'), null);
    assert.equal(isValidSubject('读书笔记'), true);
    assert.equal(isValidSubject(''), false);
});

test('pickFirstValidSubject：跳过无效候选，返回第一个有效主题', () => {
    assert.equal(pickFirstValidSubject(['', '收录于', '读书笔记', '修身养性']), '读书笔记');
    assert.equal(pickFirstValidSubject(['收录于']), null);
    assert.equal(pickFirstValidSubject([]), null);
});

test('策略列表：命名唯一、类型合法、选择器与说明非空', () => {
    const names = strategyNames();
    assert.equal(new Set(names).size, names.length, '策略名必须唯一，便于日志定位');
    for (const strategy of SUBJECT_STRATEGIES) {
        assert.ok(['css', 'xpath'].includes(strategy.type), `${strategy.name} 的 type 非法`);
        assert.ok(strategy.selector.length > 0, `${strategy.name} 的 selector 不能为空`);
        assert.ok(strategy.description.length > 0, `${strategy.name} 必须说明用途`);
    }
});

test('策略列表：付费专栏卡优先于「专栏目录」与头部徽标（同时属于多类专栏时归入付费目录）', () => {
    const names = strategyNames();
    assert.ok(names.indexOf('pay-column-card-title') < names.indexOf('column-directory-title'));
    assert.ok(names.indexOf('pay-column-card-tit') < names.indexOf('column-directory-title'));
    // 「专栏目录」按钮是三类页面通吃且服务端直出的首选来源，必须先于只覆盖单一结构的徽标策略
    assert.ok(names.indexOf('column-directory-title') < names.indexOf('header-collect-badge-name'));
    assert.ok(names.indexOf('column-directory-title') < names.indexOf('legacy-tag-link'));
    assert.ok(names.indexOf('column-directory-title') < names.indexOf('legacy-span-tit'));
    assert.ok(SUBJECT_STRATEGIES.some(strategy => strategy.selector === PAY_CARD_TITLE_SELECTOR));
    assert.ok(SUBJECT_STRATEGIES.some(strategy => strategy.selector === PAY_CARD_TIT_SELECTOR));
    assert.ok(SUBJECT_STRATEGIES.some(strategy => strategy.selector === COLUMN_DIRECTORY_SELECTOR));
    assert.ok(SUBJECT_STRATEGIES.some(strategy => strategy.selector === TOOL_DIRECTORY_SELECTOR));
    assert.ok(SUBJECT_STRATEGIES.some(strategy => strategy.selector === BADGE_SELECTOR));
});

test('策略列表：新版策略优先于旧版选择器（旧版仅作最后兜底）', () => {
    const names = strategyNames();
    const indexOf = name => names.indexOf(name);
    assert.ok(indexOf('header-collect-badge-name') < indexOf('legacy-tag-link'));
    assert.ok(indexOf('header-collect-badge-name') < indexOf('legacy-span-tit'));
    // 旧版选择器排在列表末尾
    assert.equal(indexOf('legacy-span-tit'), names.length - 1);
});

test('策略列表：不得使用已证实错误的来源（meta / 新版标签 / 作者全部专栏列表）', () => {
    for (const strategy of SUBJECT_STRATEGIES) {
        // meta article:section 实测等于文章的第一个标签（qt / CoT / mysql），与专栏不是同一命名空间
        assert.ok(!strategy.selector.includes('article:section'),
            `${strategy.name} 使用了 meta article:section（实测=首个标签，非专栏）`);
        assert.ok(!strategy.selector.includes('tag-link-new'),
            `${strategy.name} 命中了新版标签选择器，标签不是主题`);
        // 「分类专栏」面板列出作者全部专栏（且页面上有两份重复副本），按专栏链接泛化匹配必然取错
        assert.ok(!strategy.selector.includes('href*="category_"'),
            `${strategy.name} 用专栏链接泛化匹配，会把作者全部专栏当主题`);
        assert.ok(!strategy.selector.includes('special-column-name'),
            `${strategy.name} 命中了「分类专栏」面板（作者全部专栏，与本文归属无关）`);
    }
    assert.ok(!strategyNames().includes('category-href-link'),
        'category-href-link 已删除（实测取到作者全部专栏）');
    assert.ok(!strategyNames().includes('meta-article-section'),
        'meta-article-section 已删除（实测=文章第一个标签）');
});

test('策略列表：徽标策略必须排除"更多"折叠区（可能混入社区名）', () => {
    const byName = name => SUBJECT_STRATEGIES.find(strategy => strategy.name === name);
    assert.equal(byName('header-collect-badge-name').exclude, MORE_BTN_SELECTOR);
    assert.equal(byName('header-badge-name').exclude, MORE_BTN_SELECTOR);
    assert.equal(byName('header-collect-badge-name-loose').exclude, MORE_BTN_SELECTOR);
});

test('策略列表：attrOnly 策略必须声明 attr，且只取 data-title（不用 data-description）', () => {
    for (const strategy of SUBJECT_STRATEGIES) {
        if (strategy.attrOnly) {
            assert.ok(strategy.attr, `${strategy.name} 声明了 attrOnly 却没有 attr`);
        }
    }
    const directory = SUBJECT_STRATEGIES.find(strategy => strategy.name === 'column-directory-title');
    assert.equal(directory.attr, 'data-title');
    assert.equal(directory.attrOnly, true);
    assert.ok(!directory.selector.includes('data-description'));
});

test('付费专栏页：命中付费专栏卡的 title 属性', async () => {
    const page = createPageStub({
        [PAY_CARD_TITLE_SELECTOR]: [el('计算机技术杂谈', { title: '计算机技术杂谈' })]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '计算机技术杂谈');
    assert.deepEqual(result.subjects, ['计算机技术杂谈']);
    assert.equal(result.strategy, 'pay-column-card-title');
    assert.equal(result.error, null);
});

test('付费专栏页：title 缺失时回落到卡片内的 .tit 文本', async () => {
    const page = createPageStub({
        [PAY_CARD_TIT_SELECTOR]: [el('\n  计算机技术杂谈  \n')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '计算机技术杂谈');
    assert.equal(result.strategy, 'pay-column-card-tit');
});

test('免费专栏页：命中头部「收录于」徽标，多专栏取第一个并保留全部候选', async () => {
    const page = createPageStub({
        [BADGE_SELECTOR]: [el('读书笔记'), el('修身养性')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '读书笔记');
    assert.deepEqual(result.subjects, ['读书笔记', '修身养性']);
    assert.equal(result.strategy, 'header-collect-badge-name');
});

test('免费专栏页：容器 id 改名时回退到 .article-header-badge .badge-name', async () => {
    const page = createPageStub({
        [BADGE_UNSCOPED_SELECTOR]: [el('修身养性')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '修身养性');
    assert.equal(result.strategy, 'header-badge-name');
});

test('免费专栏页：徽标类名变化时回退到宽松徽标策略', async () => {
    const page = createPageStub({
        [BADGE_LOOSE_SELECTOR]: [el('AI底稿')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, 'AI底稿');
    assert.equal(result.strategy, 'header-collect-badge-name-loose');
});

test('排除规则：「更多」折叠区内的徽标（可能是社区名）被丢弃', async () => {
    const page = createPageStub({
        [BADGE_LOOSE_SELECTOR]: [el('某个技术社区', {}, [MORE_BTN_SELECTOR])]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, null, '折叠区内容不得被当作专栏');
    assert.deepEqual(result.rejected, [], '被排除的元素不应进入候选，也不该产生噪点日志');
});

test('VIP 页：命中「专栏目录」按钮的 data-title（普通/收费/VIP 通吃）', async () => {
    const page = createPageStub({
        [COLUMN_DIRECTORY_SELECTOR]: [el('专栏目录', {
            'data-title': '计算机技术',
            'data-description': '计算机技术',
            'data-url': 'https://blog.csdn.net/zhiyuan411/category_11642677.html'
        })]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '计算机技术');
    assert.equal(result.strategy, 'column-directory-title');
});

test('VIP 页：按钮类名变化时由 .tool-directory [data-title] 兜底', async () => {
    const page = createPageStub({
        [TOOL_DIRECTORY_SELECTOR]: [el('专栏目录', { 'data-title': '计算机技术' })]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '计算机技术');
    assert.equal(result.strategy, 'tool-directory-title');
});

test('VIP 页：data-title 缺失时不得回落成按钮文案「专栏目录」', async () => {
    const page = createPageStub({
        [COLUMN_DIRECTORY_SELECTOR]: [el('专栏目录', { 'data-title': '' })]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, null, '按钮文案不是主题');
    assert.deepEqual(result.rejected, [], 'attrOnly 策略不应把按钮文案塞进候选');
});

test('头部下拉卡片：title 属性优先于文本（避免文本中的多余空白）', async () => {
    const page = createPageStub({
        [COLUMN_TITLE_SELECTOR]: [el('  读书笔记\n', { title: '读书笔记' })]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '读书笔记');
    assert.equal(result.strategy, 'column-detail-title');
});

test('头部下拉卡片：title 属性缺失或为空时回落到元素文本', async () => {
    const page = createPageStub({
        [COLUMN_TITLE_SELECTOR]: [el('修身养性', { title: '   ' })]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '修身养性');
    assert.equal(result.strategy, 'column-detail-title');
});

test('旧版详情页：仍可通过 a.tag-link 命中（XPath 策略有效）', async () => {
    const page = createPageStub({}, {
        [LEGACY_TAG_LINK_XPATH]: [el('读书笔记')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '读书笔记');
    assert.equal(result.strategy, 'legacy-tag-link');
});

test('旧版详情页：span.tit 作为旧版备选仍可用', async () => {
    const page = createPageStub({}, {
        [LEGACY_TIT_XPATH]: [el('修身养性')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '修身养性');
    assert.equal(result.strategy, 'legacy-span-tit');
});

test('兜底链路失效时：返回 null 而不是把作者全部专栏当主题', async () => {
    // 只存在「分类专栏」面板（作者全部专栏）的页面：任何策略都不应命中它
    const result = await extractArticleSubject(createPageStub({
        'a[href*="category_"]': [el('计算机技术杂谈 付费'), el('斜杠人生 付费')],
        '.special-column-name': [el('计算机技术杂谈 付费')]
    }));
    assert.equal(result.subject, null);
    assert.equal(result.strategy, null);
});

test('未收录任何专栏：返回 null，但不抛错、不产生误报候选', async () => {
    const result = await extractArticleSubject(createPageStub());
    assert.equal(result.subject, null);
    assert.equal(result.strategy, null);
    assert.deepEqual(result.rejected, []);
    assert.ok(result.attempted.length === SUBJECT_STRATEGIES.length);
});

test('选择器命中的是版式文案（如「收录于」）：判为无效并记录 rejected', async () => {
    const page = createPageStub({
        [BADGE_SELECTOR]: [el('收录于')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, null);
    assert.ok(result.rejected.some(item => item.includes('收录于')), '应记录被过滤的候选');
});

test('单个策略抛错不影响其它策略（异常隔离）', async () => {
    const page = createPageStub({
        [PAY_CARD_TITLE_SELECTOR]: new Error('Invalid selector'),
        [BADGE_SELECTOR]: [el('读书笔记')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '读书笔记');
    assert.ok(result.attempted.some(item => item.includes('pay-column-card-title(异常:')));
});

test('页面采集整体失败：返回 error 且不抛错（主题缺失不能中断导出）', async () => {
    const page = { evaluate: async () => { throw new Error('Target closed'); } };
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, null);
    assert.equal(result.error, 'Target closed');
});

test('非法 page：返回 error 且不抛错', async () => {
    const result = await extractArticleSubject(null);
    assert.equal(result.subject, null);
    assert.ok(result.error.includes('非法的 page 对象'));
});
