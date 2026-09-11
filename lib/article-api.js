/**
 * CSDN 文章数据接口（getArticle）的响应判据与诊断解析
 *
 * 抽为独立模块的原因：这些函数都是纯函数（不依赖浏览器/配置），可以脱离 Puppeteer 单元测试。
 * 2026-09 的线上故障（17/39 篇文章抛"命中空响应体"）根因就是响应判据缺少 articleId 校验，
 * 导致上一篇编辑页迟到的 getArticle 响应被误命中，导航后响应体已被销毁。
 * 该回归由 test/article-api.test.js 守住。
 */

// 文章数据接口地址（所有文章共用同一路径，articleId 通过 URL 的 id 参数区分）
export const ARTICLE_DATA_API_URLS = [
    'https://bizapi.csdn.net/blog-console-api/v3/editor/getArticle',
    'https://bizapi.csdn.net/blog-console-api/v1/editor/getArticle'
];

// 文章数据接口响应的最长等待时间（毫秒）
// 说明：该监听在导航前注册，超时需要覆盖"导航等待（load/networkidle2 最大 60s）+ 接口响应余量"，故取 90s
export const ARTICLE_API_TIMEOUT = 90000;

// 响应头白名单：仅保留与问题定位相关的头，避免 set-cookie 等敏感信息落盘
export const DIAGNOSTIC_HEADER_WHITELIST = [
    'content-type',
    'content-length',
    'cache-control',
    'vary',
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-max-age'
];

/**
 * 安全调用对象的方法（不同 Puppeteer 版本/响应已失效时返回 undefined，不抛错）
 * @param {Object} target - 目标对象
 * @param {string} methodName - 方法名
 * @returns {*} 方法返回值或 undefined
 */
export function safeCall(target, methodName) {
    try {
        return target && typeof target[methodName] === 'function' ? target[methodName]() : undefined;
    } catch (err) {
        return undefined;
    }
}

/**
 * 按白名单提取响应头（避免 set-cookie 等敏感信息落盘）
 * @param {Object} headers - 原始响应头对象
 * @returns {Object} 白名单过滤后的响应头
 */
export function pickHeaders(headers = {}) {
    const picked = {};
    for (const [key, value] of Object.entries(headers)) {
        if (DIAGNOSTIC_HEADER_WHITELIST.includes(key.toLowerCase())) {
            picked[key.toLowerCase()] = value;
        }
    }
    return picked;
}

/**
 * 判断URL是否为文章数据接口
 * @param {string} url - 响应URL
 * @returns {boolean} 是否命中
 */
export function isArticleDataUrl(url) {
    return ARTICLE_DATA_API_URLS.some(apiUrl => url.includes(apiUrl));
}

/**
 * 判断URL的 id 查询参数是否等于指定文章ID（参数名精确匹配，值整体匹配）
 * 采用正则而非 includes：避免 id=123 误命中 id=1234 这类前缀关系
 * @param {string} url - 请求URL
 * @param {string|number} articleId - 期望的文章ID
 * @returns {boolean} 是否命中
 */
export function hasArticleId(url, articleId) {
    const escapedId = String(articleId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`[?&]id=${escapedId}(?:&|$)`).test(String(url || ''));
}

/**
 * 创建文章数据接口的响应判据（纯函数工厂，便于单元测试）
 * 判据：URL命中 + URL中的id与当前文章一致 + 请求方法（排除OPTIONS预检）
 *
 * 修复要点（P0-1）：必须校验URL中的 id 参数与当前文章一致。
 * 原判据只校验URL+方法+状态+Content-Type，会把"上一篇编辑页迟到的 getArticle"也匹配进来：
 * 该响应在导航前就已注册的监听窗口内被命中，等真正读取响应体时页面已导航，body 已被销毁，
 * 于是必然抛"命中空响应体"（原为 "Could not load body for this request..."），并导致每篇上一篇的响应错配。
 * 因此这里把状态码与 Content-Type 的判断移出判据，交由调用方分层处理（可给出更准确的错误信息）。
 * @param {string|number} articleId - 当前文章ID
 * @returns {function(import('puppeteer').HTTPResponse): boolean} 响应判据
 */
export function createArticleDataResponsePredicate(articleId) {
    return (response) => {
        const url = safeCall(response, 'url') || '';
        if (!isArticleDataUrl(url)) return false;
        // 关键修复：只认当前文章的响应，杜绝"错配上一篇"
        if (!hasArticleId(url, articleId)) return false;
        // 排除CORS预检（OPTIONS）等无响应体的请求
        if (safeCall(response.request(), 'method') === 'OPTIONS') return false;
        return true;
    };
}

/**
 * 提取响应的诊断信息（方法/状态/缓存/请求体/响应头等）
 * @param {import('puppeteer').HTTPResponse} response - 响应对象
 * @returns {Object} 诊断信息
 */
export function describeResponse(response) {
    const request = response.request();
    const failure = safeCall(request, 'failure');
    return {
        method: safeCall(request, 'method'),
        url: safeCall(response, 'url'),
        status: safeCall(response, 'status'),
        statusText: safeCall(response, 'statusText'),
        ok: safeCall(response, 'ok'),
        fromCache: safeCall(response, 'fromCache'),
        fromServiceWorker: safeCall(response, 'fromServiceWorker'),
        resourceType: safeCall(request, 'resourceType'),
        postData: safeCall(request, 'postData') || null,
        failure: failure ? failure.errorText : null,
        // 发起该请求的 frame 地址：用于识别请求来自哪个 origin 上下文（如编辑器内嵌 iframe）
        frameUrl: safeCall(safeCall(request, 'frame'), 'url') || null,
        headers: pickHeaders(safeCall(response, 'headers') || {})
    };
}
