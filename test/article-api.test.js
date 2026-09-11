/**
 * 文章数据接口响应判据的单元测试（node:test，无需 Puppeteer）
 * 运行：npm run test:unit
 *
 * 回归背景（2026-09 线上故障）：
 * 判据若缺少 articleId 校验，会把"上一篇编辑页迟到的 getArticle"误命中，
 * 导航后响应体已被销毁，于是抛"命中空响应体"，导致 17/39 篇文章失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createArticleDataResponsePredicate,
    hasArticleId,
    isArticleDataUrl,
    pickHeaders,
    safeCall
} from '../lib/article-api.js';

const API_URL = 'https://bizapi.csdn.net/blog-console-api/v3/editor/getArticle';

/**
 * 构造一个最小的 HTTPResponse 替身
 * @param {Object} options - 参数
 * @param {string} options.url - 响应URL
 * @param {string} [options.method='GET'] - 请求方法
 * @param {number} [options.status=200] - 状态码
 * @param {Object} [options.headers] - 响应头
 * @returns {Object} response 替身与 request 替身
 */
function makeResponse({
    url,
    method = 'GET',
    status = 200,
    headers = {
        'content-type': 'application/json; charset=utf-8'
    }
} = {}) {
    const request = {
        url: () => url,
        method: () => method,
        resourceType: () => 'xhr',
        postData: () => 'articleId=1',
        failure: () => null,
        frame: () => ({
            url: () => 'https://editor.csdn.net'
        })
    };
    return {
        url: () => url,
        request: () => request,
        status: () => status,
        statusText: () => (status === 200 ? 'OK' : 'ERROR'),
        ok: () => status >= 200 && status < 300,
        headers: () => headers,
        fromCache: () => false,
        fromServiceWorker: () => false
    };
}

test('URL命中文章数据接口时 isArticleDataUrl 为真', () => {
    assert.equal(isArticleDataUrl(API_URL), true);
    assert.equal(isArticleDataUrl(`${API_URL}?id=123`), true);
    assert.equal(isArticleDataUrl('https://editor.csdn.net/md/?articleId=123'), false);
});

test('判据只命中当前文章的响应（核心回归）', () => {
    const predicate = createArticleDataResponsePredicate('164324122');
    // 当前文章：命中
    assert.equal(predicate(makeResponse({
        url: `${API_URL}?id=164324122`
    })), true);
    // 上一篇迟到的响应：必须不命中（原bug会发生错配）
    assert.equal(predicate(makeResponse({
        url: `${API_URL}?id=164123739`
    })), false);
});

test('判据拒绝非接口URL与CORS预检', () => {
    const predicate = createArticleDataResponsePredicate('123');
    assert.equal(predicate(makeResponse({
        url: 'https://editor.csdn.net/md/?articleId=123'
    })), false);
    assert.equal(predicate(makeResponse({
        url: `${API_URL}?id=123`,
        method: 'OPTIONS'
    })), false);
});

test('判据不再按状态码/Content-Type过滤（交由调用方分层处理）', () => {
    const predicate = createArticleDataResponsePredicate('123');
    // 502/非JSON 也要能被判据命中，否则 waitForResponse 只能干等到超时
    assert.equal(predicate(makeResponse({
        url: `${API_URL}?id=123`,
        status: 502,
        headers: {
            'content-type': 'text/html'
        }
    })), true);
});

test('响应已失效/异常时判据与 safeCall 不抛错', () => {
    const predicate = createArticleDataResponsePredicate('123');
    const brokenResponse = {
        url() {
            throw new Error('target closed');
        },
        request: () => null
    };
    assert.equal(predicate(brokenResponse), false);
    assert.equal(safeCall(brokenResponse, 'url'), undefined);
    assert.equal(safeCall(null, 'url'), undefined);
    // 兼容老版本没有 postData 的情况
    assert.equal(safeCall({}, 'postData'), undefined);
});

test('id 参数必须整体匹配，不能是前缀误命中', () => {
    // 若实现退化为 `id=123` 的 includes 前缀匹配，则 id=1234 会被错误命中；此处锁定精确匹配行为
    assert.equal(hasArticleId(`${API_URL}?id=1234`, '123'), false);
    assert.equal(hasArticleId(`${API_URL}?id=123`, '123'), true);
    assert.equal(hasArticleId(`${API_URL}?id=123&foo=1`, '123'), true);
    // 参数名必须精确为 id，不能命中 articleId
    assert.equal(hasArticleId(`${API_URL}?articleId=123`, '123'), false);
});

test('pickHeaders 只保留白名单响应头（不落盘 set-cookie）', () => {
    const picked = pickHeaders({
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=secret',
        'Access-Control-Allow-Origin': 'https://editor.csdn.net'
    });
    assert.deepEqual(picked, {
        'content-type': 'application/json',
        'access-control-allow-origin': 'https://editor.csdn.net'
    });
});
