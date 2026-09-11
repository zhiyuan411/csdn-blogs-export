/**
 * 主题（CSDN 分类专栏）提取的单元测试
 *
 * 覆盖两类回归：
 *  1. 2026-09 详情页改版：旧选择器 a.tag-link / span.tit 失效 → 必须由新版策略（.badge-name / meta）接管；
 *  2. 改版期间（或再次改版）不能让提取异常中断整个导出：任何异常都必须降级为 subject=null。
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

// 新版详情页中的真实选择器（取自 doc/文章详情页样例-149205231.html）
const NEW_BADGE_SELECTOR = '#article-header-collect-list .badge-name';
const NEW_BADGE_FALLBACK_SELECTOR = '.article-header-badge .badge-name';
const NEW_COLUMN_TITLE_SELECTOR = 'a.column-detail-link[title]';
const META_SECTION_SELECTOR = 'meta[property="article:section"]';
// 旧版详情页中的真实选择器
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

/** 构造元素桩：attrs 缺省时 getAttribute 返回 null（触发回落 textContent） */
function el(text = '', attrs = {}) {
    return {
        textContent: text,
        getAttribute: (name) => (name in attrs ? attrs[name] : null)
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

test('normalizeSubjectText：去 &nbsp;、合并连续空白并按需去首尾空白', () => {
    assert.equal(normalizeSubjectText('  读书笔记  '), '读书笔记');
    assert.equal(normalizeSubjectText('读书\u00a0笔记'), '读书 笔记');
    assert.equal(normalizeSubjectText(' 读书\n笔记 '), '读书 笔记');
    assert.equal(normalizeSubjectText('   '), null);
    assert.equal(normalizeSubjectText(null), null);
    assert.equal(normalizeSubjectText(123), null);
});

test('normalizeSubject：接受正常专栏名，过滤噪声/超长/纯数字等无效文本', () => {
    assert.equal(normalizeSubject('读书笔记'), '读书笔记');
    assert.equal(normalizeSubject('修身养性'), '修身养性');
    assert.equal(normalizeSubject('front-end'), 'front-end');
    assert.equal(normalizeSubject('  Java 并发 '), 'Java 并发');
    // 噪声文案：新版头部有「收录于」「当前文章被收录于：」等版式文案
    assert.equal(normalizeSubject('收录于'), null);
    assert.equal(normalizeSubject('当前文章被收录于'), null);
    assert.equal(normalizeSubject('标签'), null);
    assert.equal(normalizeSubject('查看详情'), null);
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

test('策略列表：命名唯一、类型合法、选择器非空', () => {
    const names = SUBJECT_STRATEGIES.map(strategy => strategy.name);
    assert.equal(new Set(names).size, names.length, '策略名必须唯一，便于日志定位');
    for (const strategy of SUBJECT_STRATEGIES) {
        assert.ok(['css', 'xpath'].includes(strategy.type), `${strategy.name} 的 type 非法`);
        assert.ok(strategy.selector.length > 0, `${strategy.name} 的 selector 不能为空`);
        assert.ok(strategy.description.length > 0, `${strategy.name} 必须说明用途`);
    }
});

test('策略列表：新版选择器优先于旧版与泛化兜底（改版时先命中新版）', () => {
    const names = SUBJECT_STRATEGIES.map(strategy => strategy.name);
    const indexOf = name => names.indexOf(name);
    // 旧版选择器已在新版页面失效（现象：主题恒为 null），因此必须排在所有新版策略之后
    assert.ok(indexOf('header-collect-badge-name') < indexOf('legacy-tag-link'));
    assert.ok(indexOf('header-collect-badge-name') < indexOf('legacy-span-tit'));
    assert.ok(indexOf('meta-article-section') < indexOf('legacy-tag-link'));
    assert.ok(indexOf('legacy-span-tit') < indexOf('category-href-link'));
    // 新版关键选择器必须在列表中
    assert.ok(SUBJECT_STRATEGIES.some(strategy => strategy.selector === NEW_BADGE_SELECTOR));
    assert.ok(SUBJECT_STRATEGIES.some(strategy => strategy.selector === META_SECTION_SELECTOR));
});

test('策略列表：不得使用新版「标签」的 class（tag-link-new），避免把标签当主题', () => {
    for (const strategy of SUBJECT_STRATEGIES) {
        assert.ok(!strategy.selector.includes('tag-link-new'),
            `${strategy.name} 命中了新版标签选择器，标签不是主题`);
    }
});

test('新版详情页：命中头部「收录于」徽标，多专栏取第一个并保留全部候选', async () => {
    const page = createPageStub({
        [NEW_BADGE_SELECTOR]: [el('读书笔记'), el('修身养性')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '读书笔记');
    assert.deepEqual(result.subjects, ['读书笔记', '修身养性']);
    assert.equal(result.strategy, 'header-collect-badge-name');
    assert.equal(result.error, null);
});

test('新版详情页：容器 id 改名时回退到 .article-header-badge .badge-name', async () => {
    const page = createPageStub({
        [NEW_BADGE_FALLBACK_SELECTOR]: [el('修身养性')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '修身养性');
    assert.equal(result.strategy, 'header-badge-name');
});

test('新版详情页：title 属性优先于文本（避免文本中的多余空白）', async () => {
    const page = createPageStub({
        [NEW_COLUMN_TITLE_SELECTOR]: [el('  读书笔记\n', { title: '读书笔记' })]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '读书笔记');
    assert.equal(result.strategy, 'column-detail-title');
});

test('title 属性缺失或为空时回落到元素文本', async () => {
    const page = createPageStub({
        [NEW_COLUMN_TITLE_SELECTOR]: [el('修身养性', { title: '   ' })]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '修身养性');
    assert.equal(result.strategy, 'column-detail-title');
});

test('meta article:section：读取 content 属性作为通用兜底', async () => {
    const page = createPageStub({
        [META_SECTION_SELECTOR]: [el('', { content: '读书笔记' })]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '读书笔记');
    assert.equal(result.strategy, 'meta-article-section');
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

test('泛化兜底：仅剩指向专栏页的链接时也能取到主题', async () => {
    const page = createPageStub({
        'a[href*="category_"]': [el(''), el(' ', { title: '读书笔记' })]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '读书笔记');
    assert.equal(result.strategy, 'category-href-link');
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
        [NEW_BADGE_SELECTOR]: [el('收录于')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, null);
    assert.ok(result.rejected.some(item => item.includes('收录于')), '应记录被过滤的候选');
});

test('单个策略抛错不影响其它策略（异常隔离）', async () => {
    const page = createPageStub({
        [NEW_BADGE_SELECTOR]: new Error('Invalid selector'),
        [NEW_BADGE_FALLBACK_SELECTOR]: [el('读书笔记')]
    });
    const result = await extractArticleSubject(page);
    assert.equal(result.subject, '读书笔记');
    assert.ok(result.attempted.some(item => item.includes('header-collect-badge-name(异常:')));
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
