import puppeteer from "puppeteer";
import moment from 'moment';
import fs from 'fs/promises';
import path from "path";
import yaml from 'js-yaml';
import fsSync from 'fs';
// 文章数据接口的响应判据与诊断解析（纯函数模块，含单元测试）
import {
    ARTICLE_API_TIMEOUT,
    safeCall,
    pickHeaders,
    isArticleDataUrl,
    hasArticleId,
    createArticleDataResponsePredicate,
    describeResponse
} from './lib/article-api.js';


////// 入口主流程 开始 ///////
// 加载配置文件
const configContent = fsSync.readFileSync('./config.yml', 'utf8');
const config = yaml.load(configContent);
// 从配置中获取全局常量
const {
    csdn: {
        user_id: CSDN_USER_ID,
        user_pwd: CSDN_USER_PWD
    },
    directories: {
        user_data: USER_DATA_DIR,
        default_download: DEFAULT_DOWNLOAD_PATH,
        download_paths: DOWNLOAD_PATHS
    },
    general: {
        quick_mode: QUICK_MODE,
        cookie_file: COOKIE_FILE,
        process_log: PROCESS_LOG,
        action_interval_time: ACTION_INTERVAL_TIME,
        page_reuse_limit: PAGE_REUSE_LIMIT,
        viewport_width: VIEWPORT_WIDTH,
        viewport_height: VIEWPORT_HEIGHT,
        debug_validation_time: DEBUG_VALIDATION_TIME,
        debug_login_time: DEBUG_LOGIN_TIME,
        page_load_timeout: PAGE_LOAD_TIMEOUT,
        default_navigation_timeout: DEFAULT_NAVIGATION_TIMEOUT,
        login_redirect_wait_time: LOGIN_REDIRECT_WAIT_TIME,
        scroll_multiplier: SCROLL_MULTIPLIER,
        replacements: REPLACEMENTS,
        spm: SPM
    },
    article_ids: {
        markdown_format_ids: MARKDOWN_FORMAT_IDS,
        old_format_ids: OLD_FORMAT_IDS
    },
    cookies: {
        expires: COOKIE_EXPIRES,
        protected_cookies: PROTECTED_COOKIES
    },
    browser: {
        launch_args: BROWSER_ARGS
    },
    retry: {
        max_no_change_count: MAX_NO_CHANGE_COUNT,
        max_retry_count: MAX_RETRY_COUNT
    }
} = config;
const SPM_PARAM_START = SPM ? "?spm=" + SPM : '';
const SPM_PARAM_END = SPM ? "&spm=" + SPM : '';

function appendSpmParam(urlStr) {
    if (!SPM) return urlStr;
    const url = new URL(urlStr);
    url.searchParams.set('spm', SPM);
    return url.toString();
}

// =====================================
// 诊断与网络记录相关常量（P0/P2 增强）
// =====================================
// 失败样本日志目录（P2 诊断增强，仅在 process_log=true 时落盘）
const FAILURE_LOG_DIR = './logs';
// 每个页面保留的最近网络事件条数（用于异常时输出网络层上下文）
const NETWORK_EVENT_BUFFER_SIZE = 50;
// 网络事件记录过滤：仅记录接口相关域名/路径（主文档响应不受此限制），避免日志噪音
const NETWORK_EVENT_URL_KEYWORDS = ['bizapi.csdn.net', '/blog-console-api/', '/community/home-api/'];
// 永久性HTTP状态码：重启浏览器也无法恢复，重试时不做重量级恢复
const PERMANENT_HTTP_STATUS = [401, 403, 404, 410];
// 重启浏览器的重试阈值：达到该重试次数才重启浏览器，之前的重试只重建页面（浏览器重启成本高）
const BROWSER_RESTART_RETRY_THRESHOLD = 2;
// 页面 -> 网络事件状态（WeakMap，页面关闭后可被回收）
// 结构：{ buffer: Array, seq: number, currentArticleId: string|null }
const networkEventStates = new WeakMap();

// =====================================
// 日志工具（process_log=false 时用于无人值守静默运行）
// =====================================
/**
 * 过程日志：仅当 process_log=true 时输出。
 * 用于循环体内的逐条进度（如"正在处理文章 X"、"下载成功"）、详细诊断（响应诊断、网络事件）等，
 * 定时任务无人值守执行时应关闭 process_log，避免日志无限膨胀。
 * 注意：错误与警告（console.error / console.warn）不属于过程日志，始终输出。
 * @param {...*} args - 同 console.log 参数
 */
function logProcess(...args) {
    if (!PROCESS_LOG) return;
    console.log(...args);
}

// 等待指定的时间（毫秒）
const sleep = async (ms) => {
    await new Promise(resolve => setTimeout(resolve, ms));
};
// 创建新页面对象
const createNewPage = async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT
    });
    // 挂载网络事件记录器（仅当开启过程日志时），便于异常时回放网络层上下文
    attachNetworkRecorder(page);
    return page;
};
console.log("开始执行CSDN导出任务！");
// 获取外部参数并校验
const {
    runMode,
    dayOffset
} = checkParams();
// 初始化浏览器
let browser = await initBrowser(runMode === 'run' || runMode === 'single');

// 立即执行的异步函数来处理业务逻辑，为并发处理留下扩展
(async () => {
    try {
        // 处理 setup 模式
        if (runMode === 'setup') {
            await setup(browser);
            await browser.close();
            process.exit(0); // 正常退出，不再执行后续代码
        }
        // 模拟登录操作
        await login(browser);
        // 处理 login 模式
        if (runMode === 'login') {
            // 仅完成登录，不再执行后续代码
            console.log('登录模式，仅完成登录操作，不再执行后续代码。')
            // 等待一会儿后再关闭浏览器，用于进行登录
            await sleep(DEBUG_LOGIN_TIME);
            await browser.close();
            process.exit(0);
        }
        let articleInfos = [];
        // 是否处理指定文章
        if (runMode === 'single') {
            // 为每个ID生成文章信息对象
            articleInfos = [
                // 生成Markdown格式文章信息
                ...MARKDOWN_FORMAT_IDS.map(id => ({
                    articleId: id,
                    url: `https://blog.csdn.net/${CSDN_USER_ID}/article/details/${id}${SPM_PARAM_START}`,
                    editUrl: `https://editor.csdn.net/md?articleId=${id}${SPM_PARAM_END}`
                })),
                // 生成旧格式文章信息
                ...OLD_FORMAT_IDS.map(id => ({
                    articleId: id,
                    url: `https://blog.csdn.net/${CSDN_USER_ID}/article/details/${id}${SPM_PARAM_START}`,
                    editUrl: `https://mp.csdn.net/mp_blog/creation/editor/${id}${SPM_PARAM_START}`
                }))
            ];
        } else {
            // 获取文章ID列表
            articleInfos = await getArticleInfoArray(browser, CSDN_USER_ID, dayOffset);
        }
        // 获取最后编辑时间，并过滤文章ID列表
        articleInfos = await filterArticlesByLastTime(dayOffset, articleInfos);
        // 下载CSDN文章内容
        await downloadArticles(articleInfos, runMode === 'run' && dayOffset < 0);
        // 后处理函数
        await postProcessFiles(articleInfos);
        // 关闭浏览器
        if (runMode === 'debug') {
            // 调试时，等待完成验证等操作
            console.log("已处理完所有任务，因为当前为调试模式，暂不退出，等待人工检查。")
            await sleep(DEBUG_VALIDATION_TIME);
        }
        await browser.close();
        // 打印任务结束信息
        console.log("CSDN导出任务结束！");
    } catch (error) {
        console.error("CSDN导出任务发生错误:", error);
        if (browser) {
            await browser.close(); // 确保关闭浏览器
        }
        process.exit(1); // 非零退出码表示失败
    }
})();
////// 入口主流程 结束 ///////




/**
 * 获取命令行参数并校验
 */
function checkParams() {
    // 获取命令行参数
    const args = process.argv.slice(2);
    // 定义默认值
    const defaultRunMode = 'run';
    const defaultDayOffset = -1;
    // 解析参数
    let runMode = args[0] || defaultRunMode;
    let dayOffset = args[1] ? parseInt(args[1], 10) : defaultDayOffset;
    // 参数校验
    const validRunModes = ['run', 'debug', 'setup', 'login', 'single'];
    if (!validRunModes.includes(runMode)) {
        console.error(`
无效的 runMode: ${runMode}。
有效值为：
- 'run'（默认值）：正常模式，启动无头浏览器，可以在没有图形界面的 CentOS 服务器环境中执行。
- 'debug'：调试模式，启动浏览器UI界面，可以观察浏览器运行情况并进行验证。
- 'setup'：设置模式，启动浏览器UI界面，用于记录登录信息。
- 'login'：模拟登录模式，启动浏览器UI界面，使用用户名、密码进行模拟登录CSDN操作。
- 'single'：仅处理指定的文章，文章的ID等信息在代码中硬编码来指定。
        `);
        process.exit(1);
    }
    if (isNaN(dayOffset) || !Number.isInteger(dayOffset)) {
        console.error(`
无效的 dayOffset: ${args[1]}。
请输入一个有效的整数。
dayOffset 表示从今天0点往前多少天开始计算：
- 0：从今天0点开始到现在。
- 1：从昨天0点开始到现在。
- 2：从前天0点开始到现在。
- -1：（默认值）不限制开始日期，获取所有的全量文章。
        `);
        process.exit(1);
    }
    // 打印参数信息
    console.log(`参数解析成功，runMode: ${runMode}, dayOffset: ${dayOffset}`);
    return {
        runMode,
        dayOffset
    }
}

/**
 * 删除文件夹及其内容
 * @param {string} dirPath - 要删除的文件夹路径
 */
async function deleteFolderRecursive(dirPath) {
    if (await fs.stat(dirPath).catch(() => false)) {
        const files = await fs.readdir(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = await fs.stat(filePath);
            if (stats.isDirectory()) {
                await deleteFolderRecursive(filePath);
            } else {
                await fs.unlink(filePath);
            }
        }
        await fs.rmdir(dirPath);
    }
}

/**
 * 在异常或关键节点时输出调试快照（仅当 PROCESS_LOG 启用时生效）
 * 用于问题定位，包含：页面URL、网络事件回放、页面HTML
 * @param {import('puppeteer').Page} page - 当前页面对象
 * @param {string} [context=''] - 上下文描述（如 "登录失败"），可选
 */
async function debugSnapshot(page, context = '') {
    if (!PROCESS_LOG) return;

    try {
        const url = safePageUrl(page);
        console.log(`\n[DEBUG SNAPSHOT] ${context}`);
        console.log(`URL:  ${url}`);
        // 网络事件回放：用于区分预检/缓存/中止等无响应体的情况
        const networkEvents = getNetworkEvents(page);
        const trackedArticleId = page ? (networkEventStates.get(page) || {}).currentArticleId : null;
        console.log(`网络事件（当前文章 ${trackedArticleId || '未标记'}，最近 ${networkEvents.length} 条）:`);
        if (networkEvents.length === 0) {
            console.log('  （无接口相关网络事件记录）');
        } else {
            networkEvents.forEach(event => console.log(`  ${JSON.stringify(event)}`));
        }
        const html = await page.content();
        console.log(`HTML:\n ${html}\n`);
    } catch (err) {
        console.error(`[DEBUG SNAPSHOT] ${context} 获取快照失败:`, err.message);
    }
}

// =====================================
// 诊断与网络记录工具（P0/P2 增强）
// =====================================
/**
 * 安全读取页面URL（页面已关闭/异常时返回空字符串）
 * @param {import('puppeteer').Page} page - 页面对象
 * @returns {string} 页面URL
 */
function safePageUrl(page) {
    try {
        return page ? page.url() : '';
    } catch (err) {
        return '';
    }
}

// 注：safeCall / pickHeaders / isArticleDataUrl / createArticleDataResponsePredicate / describeResponse
// 已抽到 ./lib/article-api.js，便于单测（见 test/article-api.test.js）

/**
 * 标记"当前正在处理哪篇文章"（P1 诊断增强）
 * 网络事件在收集时按文章归属打标，异常落盘时只取当前文章范围内的事件，
 * 避免页面复用（最多 PAGE_REUSE_LIMIT 篇）时把此前文章的网络事件混入失败样本。
 * @param {import('puppeteer').Page} page - 页面对象
 * @param {string|number} articleId - 当前文章ID
 */
function beginNetworkTracking(page, articleId) {
    const state = page ? networkEventStates.get(page) : null;
    if (!state) return;
    state.currentArticleId = articleId == null ? null : String(articleId);
}

/**
 * 获取页面的最近网络事件（用于异常上下文）
 * 仅返回"当前正在处理的文章"范围内的事件（未标记时返回全部）
 * @param {import('puppeteer').Page} page - 页面对象
 * @returns {Array<Object>} 网络事件数组
 */
function getNetworkEvents(page) {
    const state = page ? networkEventStates.get(page) : null;
    if (!state) return [];
    if (state.currentArticleId == null) return state.buffer.slice();
    return state.buffer.filter(event => event.articleId === state.currentArticleId);
}

/**
 * 为页面挂载网络事件记录器（旁路记录，不改变原有监听逻辑）
 * 记录：接口相关请求/响应 + 主文档响应（主文档状态码用于识别 WAF/404/502 等）
 * @param {import('puppeteer').Page} page - 页面对象
 */
function attachNetworkRecorder(page) {
    if (!PROCESS_LOG || !page) return;
    const state = {
        buffer: [],
        seq: 0,
        currentArticleId: null
    };
    networkEventStates.set(page, state);
    const push = (event) => {
        event.seq = ++state.seq;
        event.articleId = state.currentArticleId;
        state.buffer.push(event);
        if (state.buffer.length > NETWORK_EVENT_BUFFER_SIZE) {
            state.buffer.shift();
        }
    };
    // 仅记录接口相关URL，以及主文档（document）响应，避免日志噪音
    const shouldRecord = (url, resourceType) => resourceType === 'document' ||
        NETWORK_EVENT_URL_KEYWORDS.some(keyword => url.includes(keyword));

    page.on('requestfailed', (request) => {
        const url = safeCall(request, 'url') || '';
        const resourceType = safeCall(request, 'resourceType');
        if (!shouldRecord(url, resourceType)) return;
        push({
            type: 'requestfailed',
            time: new Date().toISOString(),
            method: safeCall(request, 'method'),
            resourceType,
            errorText: safeCall(request, 'failure')?.errorText || null,
            url
        });
    });

    page.on('response', (response) => {
        let url = '';
        try {
            url = response.url();
        } catch (err) {
            return;
        }
        const resourceType = safeCall(response.request(), 'resourceType');
        if (!shouldRecord(url, resourceType)) return;
        push({
            type: 'response',
            time: new Date().toISOString(),
            method: safeCall(response.request(), 'method'),
            status: safeCall(response, 'status'),
            resourceType,
            fromCache: safeCall(response, 'fromCache'),
            contentType: (safeCall(response, 'headers') || {})['content-type'] || null,
            url
        });
    });
}

/**
 * 保存失败样本日志（P2 诊断增强），便于事后离线比对
 * 详细日志仅在 process_log=true 时落盘，避免无人值守定时任务产生大量文件
 * @param {string} articleId - 文章ID
 * @param {Object} payload - 需要落盘的诊断信息
 */
async function saveFailureLog(articleId, payload) {
    if (!PROCESS_LOG) return;
    try {
        await fs.mkdir(FAILURE_LOG_DIR, {
            recursive: true
        });
        const timeSuffix = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(FAILURE_LOG_DIR, `fail-${articleId}-${timeSuffix}.json`);
        await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
        console.log(`已保存失败样本日志：${filePath}`);
    } catch (err) {
        console.error(`保存失败样本日志时出错：${err.message}`);
    }
}

/**
 * 采集页面级上下文（P1 诊断增强）
 * 用于区分"WAF安全验证页 / 404 / 页面模板变更"等场景（网络层事件无法覆盖）
 * @param {import('puppeteer').Page} page - 页面对象
 * @returns {Promise<Object|null>} 页面上下文（异常或超时返回错误信息）
 */
async function capturePageContext(page) {
    if (!page) return null;
    try {
        // 注意：必须就地 catch，否则超时后 evaluate 才失败时会产生未处理的 Promise 拒绝，可能直接终止进程
        const context = page.evaluate(() => ({
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            // CSDN WAF 验证页特征（doc/csdn-block-page-example.*.html 样例）：标题含"安全验证"且加载 init_waf.js
            hasWafMarker: /安全验证|Security Verification/.test(document.title) ||
                !!document.querySelector('script[src*="init_waf"], script[src*="cdn_cgi_bs_captcha"]'),
            htmlSnippet: (document.documentElement ? document.documentElement.innerHTML : '').slice(0, 200)
        })).catch(err => ({
            error: `采集页面上下文失败：${err.message}`
        }));
        // 页面卡死时避免采集动作本身长时间挂起
        return await Promise.race([context, sleep(5000).then(() => ({
            error: '采集页面上下文超时（5s）'
        }))]);
    } catch (err) {
        return {
            error: err.message
        };
    }
}

/**
 * 判断错误是否为永久性错误（P2：失败分层）
 * 依据：错误消息中的 HTTP 状态码（401/403/404/410 等），重启浏览器也无法恢复
 * @param {Error} error - 错误对象
 * @returns {boolean} 是否为永久性错误
 */
function isPermanentError(error) {
    const message = String((error && error.message) || '');
    return PERMANENT_HTTP_STATUS.some(status => message.includes(`status=${status}`));
}

/**
 * 决定重试方式（P2：失败分层 + 重试阶梯）
 * - 永久性错误：只重建页面，不重启浏览器（重启成本高且无法恢复）
 * - 首次重试：只重建页面（轻量）
 * - 多次重试：重启浏览器（重量，用于恢复卡死的浏览器/网络状态）
 * @param {number} retryCount - 当前（已自增的）重试次数
 * @param {Error} error - 触发的错误
 * @returns {'recreate-page'|'restart-browser'} 重试方式
 */
function decideRetryStrategy(retryCount, error) {
    if (isPermanentError(error)) return 'recreate-page';
    return retryCount >= BROWSER_RESTART_RETRY_THRESHOLD ? 'restart-browser' : 'recreate-page';
}

/**
 * 按重试策略恢复页面句柄（P2：重试阶梯）
 * 会按需重启全局 browser，并返回新建的页面对象
 * @param {import('puppeteer').Page} page - 当前页面对象
 * @param {number} retryCount - 当前（已自增的）重试次数
 * @param {Error} error - 触发的错误
 * @returns {Promise<import('puppeteer').Page>} 恢复后的页面对象
 */
async function recoverPageForRetry(page, retryCount, error) {
    if (decideRetryStrategy(retryCount, error) === 'restart-browser') {
        logProcess(`重试策略：重启浏览器（第${retryCount}次重试）`);
        await browser.close();
        browser = await initBrowser(runMode === 'run' || runMode === 'single');
    } else {
        const reason = isPermanentError(error) ? '，永久性错误不重启浏览器' : '';
        logProcess(`重试策略：仅重建页面（第${retryCount}次重试${reason}）`);
        // 关闭旧页面，避免残留页面持续占用资源/产生网络请求
        await page.close().catch(() => { });
    }
    return await createNewPage(browser);
}

/**
 * 兼容不同 Puppeteer 版本的 XPath 查询封装
 * 说明：新版 Puppeteer 移除了 page.$x，此处优先使用 $x，缺失时回退到 ::-p-xpath
 * @param {import('puppeteer').Page} page - 页面对象
 * @param {string} xpath - XPath 表达式
 * @returns {Promise<Array>} 匹配到的元素数组
 */
async function queryXPath(page, xpath) {
    if (typeof page.$x === 'function') {
        return await page.$x(xpath);
    }
    return await page.$$(`::-p-xpath(${xpath})`);
}

/**
 * 按重试次数选择导航等待策略（重试次数越大，等待越充分）
 * 修复：原实现中 retryCount > 0 分支在前，导致 networkidle2 分支永远不可达
 * @param {import('puppeteer').Page} page - 页面对象
 * @param {string} url - 目标地址
 * @param {number} retryCount - 当前重试次数
 */
async function navigateWithRetryFallback(page, url, retryCount) {
    if (retryCount > 1) {
        // 多次重试状态时，等待HTML文档和相关资源已加载
        await page.goto(url, {
            timeout: PAGE_LOAD_TIMEOUT.NETWORKIDLE2,
            waitUntil: 'networkidle2'
        });
    } else if (retryCount > 0) {
        // 重试状态时，等待HTML文档和相关资源已加载
        await page.goto(url, {
            timeout: PAGE_LOAD_TIMEOUT.LOAD,
            waitUntil: 'load'
        });
    } else {
        // 首次访问：等待HTML文档已加载（无需等待图片等资源加载）
        await page.goto(url, {
            timeout: PAGE_LOAD_TIMEOUT.DOMCONTENTLOADED,
            waitUntil: 'domcontentloaded'
        });
    }
}

/**
 * 访问文章编辑页并抓取文章数据接口的响应体
 * 统一了：响应监听（含articleId判据）、状态码分层、空响应体校验、JSON解析与诊断日志
 * @param {import('puppeteer').Page} page - 页面对象
 * @param {Object} article - 文章信息对象（需包含 articleId、editUrl）
 * @param {number} retryCount - 当前重试次数
 * @returns {Promise<Object>} 接口返回的JSON对象
 */
async function fetchArticleData(page, article, retryCount) {
    const expectedIdMarker = `id=${article.articleId}`;
    // 网络事件按文章归属打标，便于异常落盘时只看当前文章的事件
    beginNetworkTracking(page, article.articleId);
    // 将每次处理完一篇文章后的等待时间放在此处：先等待，再注册监听
    // （修复：原来"先注册监听再等待2秒"会让上一篇页面迟到的 getArticle 落在监听窗口内被误命中）
    await sleep(ACTION_INTERVAL_TIME);
    // 注册监听后立刻导航，尽量缩短监听窗口；判据中已锁定本篇 articleId
    // 计时起点：监听窗口开启时刻（此后的等待都可能逼近 ARTICLE_API_TIMEOUT）
    const listenStartedAt = Date.now();
    const responsePromise = page.waitForResponse(createArticleDataResponsePredicate(article.articleId), {
        timeout: ARTICLE_API_TIMEOUT
    });
    // 防止页面导航失败时该Promise长期悬挂并产生未处理的拒绝
    responsePromise.catch(() => { });
    await navigateWithRetryFallback(page, article.editUrl, retryCount);
    const navigatedAt = Date.now();

    const response = await responsePromise;
    // 耗时观测：命中正确响应的等待时长（相对监听窗口起点）及其中的导航耗时
    // 用途：观测该值是否逐步逼近 ARTICLE_API_TIMEOUT（超时前兆），便于在失败前发现退化
    const waitMs = Date.now() - listenStartedAt;
    const navigateMs = navigatedAt - listenStartedAt;
    const request = response.request();
    const matchedUrl = safeCall(response, 'url') || '';
    const status = safeCall(response, 'status');
    // 防御性自检：命中的响应必须属于当前文章（判据已保证，此处二次校验并输出对照信息）
    if (!hasArticleId(matchedUrl, article.articleId)) {
        throw new Error(`命中响应与当前文章不匹配：expect=${expectedIdMarker} match=${matchedUrl} ` +
            `method=${safeCall(request, 'method')} status=${status}`);
    }
    // 过程日志：期望ID与实际命中ID同时打印，便于一眼发现"错配"
    logProcess(`[API] 文章 ${article.articleId} 命中响应：expect=${expectedIdMarker} match=${matchedUrl} ` +
        `${safeCall(request, 'method')} ${status} ${safeCall(response, 'statusText')} ` +
        `fromCache=${safeCall(response, 'fromCache')} 等待=${waitMs}ms(其中导航=${navigateMs}ms)`);
    // 详细日志：完整的响应诊断信息（方法/状态/请求体/白名单响应头/frame地址）
    logProcess('[API] 响应诊断信息：', JSON.stringify(describeResponse(response)));

    // 安全读取响应体：保留读取失败的原始原因（原先 .catch(()=>'') 会吞掉 CDP 的报错信息）
    let bodyText = '';
    let bodyReadError = null;
    try {
        bodyText = await response.text();
    } catch (err) {
        bodyReadError = err;
    }

    // 状态码分层：非 2xx 立即失败（快速重试，不再让 waitForResponse 干等到超时）
    if (!response.ok()) {
        const bodyInfo = bodyReadError ? `读取失败(${bodyReadError.message})` : bodyText.slice(0, 200);
        throw new Error(`接口返回非2xx：status=${status} ${safeCall(response, 'statusText')} ` +
            `body=${bodyInfo} url=${matchedUrl}`);
    }
    if (bodyReadError) {
        throw new Error(`读取响应体失败：${bodyReadError.message}；method=${safeCall(request, 'method')} ` +
            `status=${status} fromCache=${safeCall(response, 'fromCache')} url=${matchedUrl}`);
    }
    if (!bodyText) {
        throw new Error(`命中空响应体（无法读取body）：method=${safeCall(request, 'method')} status=${status} ` +
            `contentType=${(safeCall(response, 'headers') || {})['content-type'] || 'N/A'} ` +
            `fromCache=${safeCall(response, 'fromCache')} url=${matchedUrl}`);
    }
    try {
        return JSON.parse(bodyText);
    } catch (err) {
        throw new Error(`响应体不是合法JSON（status=${status}）：${bodyText.slice(0, 200)}`);
    }
}

/**
 * 安全解析JSON响应（事件监听场景使用）
 * 排除预检（OPTIONS）响应，并在读取/解析失败时输出诊断信息，
 * 避免直接使用 response.json() 抛出难以定位的 "Could not load body..." 异常
 * @param {import('puppeteer').HTTPResponse} response - 响应对象
 * @param {string} [context=''] - 上下文描述
 * @returns {Promise<Object|null>} 解析结果（失败返回null）
 */
async function safeJsonFromResponse(response, context = '') {
    // 排除CORS预检等无响应体的请求
    if (safeCall(response.request(), 'method') === 'OPTIONS') {
        return null;
    }
    let bodyText = '';
    try {
        bodyText = await response.text();
    } catch (err) {
        console.error(`${context} 读取响应体失败：${err.message}（method=${safeCall(response.request(), 'method')} status=${safeCall(response, 'status')}）`);
        return null;
    }
    if (!bodyText) return null;
    try {
        return JSON.parse(bodyText);
    } catch (err) {
        console.error(`${context} 解析响应失败：${err.message}（method=${safeCall(response.request(), 'method')} status=${safeCall(response, 'status')}）`);
        return null;
    }
}


// =====================================
// 1. 新增：保存原生Cookies文件的函数
// =====================================
/**
 * 保存浏览器原生完整Cookies（JSON格式，含所有元信息）
 * @param {import('puppeteer').Page} page - Puppeteer页面对象
 */
async function saveNativeCookies(page) {
    try {
        // 定义原生Cookie文件名（COOKIE_FILE + .native.json后缀）
        const nativeCookieFile = `${COOKIE_FILE}.native.json`;
        console.log(`\n开始保存原生完整Cookies到: ${nativeCookieFile}`);

        // 获取所有 cookies（当前页面上下文可见的所有域）
        const allCookies = await page.cookies(); // 不指定URL则获取所有域名的Cookie

        // 无有效Cookie时跳过
        if (!allCookies || allCookies.length === 0) {
            console.log('未获取到任何原生Cookie，跳过保存');
            return;
        }

        // 生成精确到秒的时间后缀（格式：YYYY-MM-DD-HH-mm-ss）
        const now = new Date();
        const timeSuffix = now.toISOString()
            .replace(/T/g, '-')
            .replace(/:/g, '-')
            .replace(/\.\d+Z$/, '')
            .replace(/\.\d+/, ''); // 移除毫秒，仅保留到秒

        // 备份文件名：原生Cookie文件 + 精确到秒的时间后缀
        const backupFile = `${nativeCookieFile}.${timeSuffix}`;

        // 步骤1：删除同名备份文件（如果存在）
        try {
            await fs.access(backupFile);
            await fs.unlink(backupFile);
            console.log(`已删除同名备份文件: ${backupFile}`);
        } catch (err) {
            // 备份文件不存在，无需处理
        }

        // 步骤2：如果原生Cookie文件已存在，重命名为备份文件
        try {
            await fs.access(nativeCookieFile);
            await fs.rename(nativeCookieFile, backupFile);
            console.log(`已将原有原生Cookie文件备份为: ${backupFile}`);
        } catch (err) {
            // 原生Cookie文件不存在，无需备份
        }

        // 步骤3：保存完整Cookie为JSON格式（格式化，便于阅读）
        await fs.writeFile(
            nativeCookieFile,
            JSON.stringify(allCookies, null, 2),
            'utf8'
        );
        console.log(`✅ 原生完整Cookies已成功保存到: ${nativeCookieFile}`);

        // 步骤4：打印用户友好的说明日志
        console.log(`
� Cookie文件说明：
1. 原生Cookie文件 (${nativeCookieFile})：
   - 包含所有Cookie元信息（domain/path/httpOnly/secure/expires/sameSite等），**尤其包含标记为HttpOnly状态的核心登录Cookie**
   - 由脚本自动保存，无需手动操作，完整还原浏览器所有Cookie
   - 导入时无需补充任何属性，直接生效，可100%还原登录态

2. 传统Cookie文件 (${COOKIE_FILE})：
   - 手动获取及补充完整方法：
     a. 打开Chrome浏览器访问CSDN并完成登录
     b. F12打开开发者工具 → 切换到Console（控制台）面板
     c. 输入 document.cookie 并回车，右键复制输出的完整字符串
     d. 将复制的字符串粘贴到 ${COOKIE_FILE} 文件中（基础内容）
     e. 补充HttpOnly核心登录Cookie（关键步骤，缺失则无法登录）：
        ① F12 → Application（应用）→ Storage（存储）→ Cookies → 选择.csdn.net/blog.csdn.net等相关域名
        ② 找到列表中「HttpOnly」列打√的Cookie（点击列名可以按照HttpOnly排序），复制其name=value键值对
        ③ 将这些键值对手动拼接到 ${COOKIE_FILE} 文件的字符串末尾（格式：原有内容; 新Cookie=值; 新Cookie2=值2）
   - 必须补充的核心HttpOnly登录Cookie（示例）：
     ✅ SESSION（.csdn.net/msg.csdn.net）：（可选）CSDN根域名核心会话标识，服务器判定登录的核心依据
     ✅ UserInfo（.csdn.net）：加密存储的用户身份信息，验证用户合法性
     ✅ UserToken（.csdn.net）：用户权限令牌，访问个人/敏感接口必需
     ✅ https_waf_cookie（blog.csdn.net）：CSDN WAF防护验证Cookie，防止请求被拦截
     ✅ waf_captcha_marker（blog.csdn.net）：人机验证标记，部分接口调用必需
`);
    } catch (error) {
        console.error(`❌ 保存原生Cookies失败: ${error.message}`);
    }
}


/**
 * 解析并导入Cookie（优先使用原生JSON文件，不存在则使用传统文本文件）
 * @param {import('puppeteer').Page} page - Puppeteer页面对象
 * @returns {Promise<number>} 成功导入的Cookie数量
 */
async function parseCookies(page) {
    // 迁移COOKIE_DOMAIN到函数内部
    const COOKIE_DOMAIN = '.csdn.net';
    let importedCount = 0;

    // 定义原生Cookie文件名
    const nativeCookieFile = `${COOKIE_FILE}.native.json`;

    try {
        // 步骤1：优先检查并使用原生Cookie文件
        await fs.access(nativeCookieFile);
        const nativeCookieContent = await fs.readFile(nativeCookieFile, 'utf8');
        if (nativeCookieContent.trim()) {
            const nativeCookies = JSON.parse(nativeCookieContent);
            if (Array.isArray(nativeCookies) && nativeCookies.length > 0) {
                // 如果强行覆盖有效期会导致登录失败，可能是有些关键项加了校验
                // 预处理Cookie：复制原数组并修改有效期为COOKIE_EXPIRES，不修改原始文件内容
                // const processedCookies = nativeCookies.map(cookie => ({
                //     ...cookie, // 复制所有原有属性
                //     expires: COOKIE_EXPIRES // 覆盖有效期为指定常量
                // }));
                const processedCookies = nativeCookies

                // 先访问目标网站确保上下文存在
                await page.goto(`https://www${COOKIE_DOMAIN}`, {
                    waitUntil: 'domcontentloaded'
                });
                // 导入预处理后的Cookie（有效期已修改）
                await page.setCookie(...processedCookies);
                importedCount = processedCookies.length;
                // console.log(`✅ 从原生Cookie文件(${nativeCookieFile})导入 ${importedCount} 个Cookie（已统一有效期为 ${COOKIE_EXPIRES}）`);
                console.log(`✅ 从原生Cookie文件(${nativeCookieFile})导入 ${importedCount} 个Cookie`);

                // 重命名原生Cookie文件为日期后缀备份（仅日期，无时间）
                await renameCookieFile(nativeCookieFile);
                return importedCount;
            }
        }
    } catch (nativeErr) {
        // 细分原生Cookie文件的错误类型
        if (nativeErr.code === 'ENOENT') {
            // 文件不存在：保留原有友好提示
            console.log(`原生Cookie文件(${nativeCookieFile})不存在，尝试使用传统Cookie文件(${COOKIE_FILE})`);
        } else if (nativeErr.name === 'SyntaxError') {
            // JSON解析错误：特殊提示
            console.error(`❌ 原生Cookie文件(${nativeCookieFile})格式错误（JSON解析失败）：${nativeErr.message}`);
        } else {
            // 其他错误（权限、目录、文件损坏等）：打印详细错误信息
            console.error(`❌ 处理原生Cookie文件(${nativeCookieFile})时发生异常：`);
            console.error(`   错误码: ${nativeErr.code}`);
            console.error(`   错误信息: ${nativeErr.message}`);
            console.error(`   错误堆栈: ${nativeErr.stack}`);
            console.log(`尝试使用传统Cookie文件(${COOKIE_FILE})`);
        }
    }

    // 步骤2：原生文件不存在时，使用传统文本Cookie文件
    try {
        await fs.access(COOKIE_FILE);
        const cookieString = await fs.readFile(COOKIE_FILE, 'utf8');
        if (cookieString.trim()) {
            // 先访问目标网站确保上下文存在
            await page.goto(`https://www${COOKIE_DOMAIN}`, {
                waitUntil: 'domcontentloaded'
            });

            // 传统解析逻辑（保留原有逻辑）
            const cookies = cookieString.split('; ')
                .filter(part => part.trim() !== '')
                .map(cookie => {
                    const [name, value] = cookie.split('=', 2);
                    if (!name || value === undefined) {
                        console.warn(`跳过无效Cookie: ${cookie}`);
                        return null;
                    }
                    // 移除值中的引号和末尾的换行符
                    let cleanValue = value.replace(/^"(.*)"$/, '$1').trim();
                    // 对 UserNick 进行 URL 解码
                    if (name === 'UserNick') {
                        cleanValue = decodeURIComponent(cleanValue);
                    }
                    // 设置默认属性
                    const cookieObj = {
                        name: name.trim(),
                        value: cleanValue,
                        domain: COOKIE_DOMAIN,
                        path: '/',
                        expires: COOKIE_EXPIRES,
                        httpOnly: false,
                        secure: false
                    };
                    // 为特定Cookie设置httpOnly和secure标志
                    if (PROTECTED_COOKIES.includes(name)) {
                        cookieObj.httpOnly = true;
                        cookieObj.secure = true;
                    }
                    return cookieObj;
                })
                .filter(cookie => cookie !== null);

            if (cookies.length > 0) {
                await page.setCookie(...cookies);
                importedCount = cookies.length;
                console.log(`✅ 从传统Cookie文件(${COOKIE_FILE})导入 ${importedCount} 个Cookie`);

                // 重命名传统Cookie文件为日期后缀备份（仅日期，无时间）
                await renameCookieFile(COOKIE_FILE);
            }
        } else {
            console.log(`传统Cookie文件(${COOKIE_FILE})内容为空，跳过导入`);
        }
    } catch (traditionalErr) {
        // 细分传统Cookie文件的错误类型
        if (traditionalErr.code === 'ENOENT') {
            // 文件不存在：保留原有友好提示
            console.log(`传统Cookie文件(${COOKIE_FILE})不存在，跳过Cookie导入`);
        } else {
            // 其他错误（权限不足、文件是目录、读取失败等）：打印详细错误信息
            console.error(`❌ 处理传统Cookie文件(${COOKIE_FILE})时发生异常：`);
            console.error(`   错误码: ${traditionalErr.code}`);
            console.error(`   错误信息: ${traditionalErr.message}`);
            console.error(`   错误堆栈: ${traditionalErr.stack}`);
            console.log(`跳过Cookie导入`);
        }
    }

    return importedCount;
}

/**
 * 辅助函数：将Cookie文件重命名为日期后缀备份（先删除同名备份）
 * @param {string} filePath - 要重命名的文件路径
 */
async function renameCookieFile(filePath) {
    try {
        // 生成仅日期的后缀（YYYY-MM-DD）
        const dateSuffix = new Date().toISOString().split('T')[0];
        const newFilePath = `${filePath}.${dateSuffix}`;

        // 先删除同名备份文件（如果存在）
        try {
            await fs.access(newFilePath);
            await fs.unlink(newFilePath);
            console.log(`已删除同名日期备份文件: ${newFilePath}`);
        } catch (err) {
            // 备份文件不存在，无需处理
        }

        // 重命名原文件
        await fs.rename(filePath, newFilePath);
        console.log(`已将Cookie文件重命名为: ${newFilePath}`);
    } catch (renameError) {
        console.error(`重命名Cookie文件失败: ${renameError.message}`);
    }
}

// =====================================
// 3. 修改：重构initBrowser函数
// =====================================
/**
 * 初始化浏览器
 * @param {boolean} [headless=true] - 是否开启无头模式
 * @returns {Promise<import('puppeteer').Browser>} 浏览器对象
 */
async function initBrowser(headless = true) {
    console.log('初始化浏览器。');
    let browser;
    try {
        // 根据传入的参数决定是否开启无头模式
        const headlessOption = headless ? "new" : false;

        // 启动浏览器
        browser = await puppeteer.launch({
            headless: headlessOption,
            userDataDir: USER_DATA_DIR,
            args: BROWSER_ARGS
        });

        // 创建临时页面用于导入Cookie
        const tempPage = await browser.newPage();
        // 调用重构后的parseCookies函数导入Cookie
        const cookieCount = await parseCookies(tempPage);
        // 关闭临时页面
        await tempPage.close();

        if (cookieCount === 0) {
            console.log('未导入任何Cookie');
        }

        return browser;
    } catch (e) {
        console.error("初始化浏览器失败，直接退出。", e);
        if (browser) {
            await browser.close();
        }
        process.exit(99);
    }
}

// =====================================
// 4. 修改：重构setup函数（调用保存原生Cookie函数）
// =====================================
/**
 * 设置模式，启动浏览器UI界面，用于记录登录信息。
 * @param {import('puppeteer').Browser} browser - 浏览器对象
 */
async function setup(browser) {
    console.log('设置模式，启动浏览器UI界面，用于记录登录信息。');
    const LOGIN_URL = `https://passport.csdn.net/login${SPM_PARAM_START}`;

    try {
        await deleteFolderRecursive(USER_DATA_DIR);
        console.log(`userData 目录 ${USER_DATA_DIR} 已删除`);
    } catch (err) {
        console.log(`userData 目录 ${USER_DATA_DIR} 目录不存在，无需删除`);
    }

    // 创建下载目录
    await fs.mkdir(DEFAULT_DOWNLOAD_PATH, { recursive: true });
    console.log(`下载目录 ${DEFAULT_DOWNLOAD_PATH} 已创建`);

    // 遍历创建自定义下载目录
    for (const [subject, dirPath] of Object.entries(DOWNLOAD_PATHS)) {
        await fs.mkdir(dirPath, { recursive: true });
        console.log(`下载目录 ${dirPath} (${subject}) 已创建`);
    }

    // 初始化页面并打开登录页
    const page = await createNewPage(browser);
    await page.goto(LOGIN_URL);

    // 等待用户登录
    await sleep(DEBUG_LOGIN_TIME);

    // 关键修改：在关闭page前调用保存原生Cookie函数
    await saveNativeCookies(page);

    // 关闭页面
    await page.close();
}

/**
 * 工具函数：判断页面是否处于已登录状态（基于特征点数组循环检测）
 * @param {import('puppeteer').Page} page - Puppeteer页面对象
 * @returns {Promise<boolean>} true=已登录，false=未登录
 */
async function isLoggedIn(page) {
    try {
        // 未登录特征点数组（核心判断依据，每个特征点附带原理说明）
        const notLoggedInFeatures = [
            {
                selector: 'div.passport-container',
                description: '登录页专属根容器：仅登录页存在该容器，存在则说明停留在登录页，未登录'
            },
            {
                selector: '.csdn-toolbar-loginbtn',
                description: '全局登录按钮：任意页面出现该按钮，说明账号处于未登录的全局状态'
            }
        ];

        // 循环检测所有未登录特征点
        for (const feature of notLoggedInFeatures) {
            const element = await page.$(feature.selector);
            if (element) {
                console.log(`检测到未登录特征【${feature.selector}】：${feature.description}，判定为未登录`);
                return false;
            }
        }

        console.log('未检测到任何未登录特征，判定为已登录');
        return true;
    } catch (error) {
        console.warn('登录状态判断出错，默认判定为未登录：', error.message);
        return false;
    }
}

/**
 * 模拟登录模式，启动浏览器UI界面，使用用户名、密码进行模拟登录CSDN操作。
 * @param {import('puppeteer').Browser} browser - 浏览器对象
 */
async function login(browser) {
    const LOGIN_URL = `https://passport.csdn.net/login${SPM_PARAM_START}`;
    let page = await createNewPage(browser);
    // 打开CSDN登录页面，等待可能的登陆后跳转
    try {
        await page.goto(LOGIN_URL, {
            timeout: PAGE_LOAD_TIMEOUT.DOMCONTENTLOADED,
            waitUntil: 'domcontentloaded'
        });
    } catch (error) {
        try {
            console.error(`打开CSDN登录页面失败：${error.message}，再次重试。`);
            await page.close()
            page = await createNewPage(browser);
            await page.goto(LOGIN_URL, {
                timeout: PAGE_LOAD_TIMEOUT.LOAD,
                waitUntil: 'load'
            });
        } catch (error) {
            try {
                console.error(`打开CSDN登录页面再次失败：${error.message}，再次重试。`);
                await page.close()
                page = await createNewPage(browser);
                await page.goto(LOGIN_URL, {
                    timeout: PAGE_LOAD_TIMEOUT.NETWORKIDLE2,
                    waitUntil: 'networkidle2'
                });
            } catch (error) {
                // 防止是页面已打开，只是加载判断失误情况，先验证登录状态再继续
                console.error(`打开CSDN登录页面再次失败：${error.message}，不再重试。继续后面的验证登录状态等流程。`);
                await debugSnapshot(page);
            }
        }
    }
    await sleep(LOGIN_REDIRECT_WAIT_TIME);

    // 核心替换1：调用isLoggedIn判断初始登录状态
    const loggedIn = await isLoggedIn(page);
    if (loggedIn) {
        console.log('经验证，用户已登录');
        await page.close();
        return;
    }
    console.log('用户未登录，尝试登录...');

    // ========== 补回被遗漏的变量定义（关键修复点） ==========
    // 使用XPath来查找“密码登录”Tab（定义passwordLoginTab变量）
    const passwordLoginTab = await queryXPath(page, '//span[text()="密码登录"]');
    // 使用CSS选择器来查找login-third-passwd元素（定义loginThirdPasswd变量）
    const loginThirdPasswd = await page.$('span.login-third-passwd');
    // =======================================================

    // 原有登录操作逻辑（现在变量已定义，不会报错）
    if (passwordLoginTab.length > 0) {
        await passwordLoginTab[0].click();
        console.log('点击了"密码登录"Tab');
    } else {
        await loginThirdPasswd.click();
        console.log('点击了login-third-passwd元素');
    }
    // 在“手机号/邮箱/用户名”输入框内输入用户ID
    const usernameInput = await queryXPath(page, '//input[@placeholder="手机号/邮箱/用户名"]');
    if (usernameInput.length > 0) {
        await usernameInput[0].type(CSDN_USER_ID);
        await sleep(ACTION_INTERVAL_TIME);
    } else {
        throw new Error('尝试登录失败：找不到“手机号/邮箱/用户名”输入框');
    }
    // 在“密码”输入框输入密码
    const passwordInput = await queryXPath(page, '//input[@placeholder="密码"]');
    if (passwordInput.length > 0) {
        await passwordInput[0].type(CSDN_USER_PWD);
        await sleep(ACTION_INTERVAL_TIME);
    } else {
        throw new Error('尝试登录失败：找不到“密码”输入框');
    }
    // 勾选“同意协议”勾选框
    const agreeCheckbox = await queryXPath(page, '//i[contains(@class, "icon-nocheck")]');
    if (agreeCheckbox.length > 0) {
        await agreeCheckbox[0].click();
        await sleep(ACTION_INTERVAL_TIME);
    } else {
        console.log('登录改版：找不到“同意协议”勾选框，直接忽略');
    }
    // 点击“登录”按钮
    const loginButton = await queryXPath(page, '//button[text()="登录"]');
    if (loginButton.length > 0) {
        await loginButton[0].click();
    } else {
        throw new Error('尝试登录失败：找不到“登录”按钮');
    }

    // 等待一段时间，确保页面加载完成
    await sleep(LOGIN_REDIRECT_WAIT_TIME);

    // 核心替换2：调用isLoggedIn判断登录后状态
    const loggedInAfterLogin = await isLoggedIn(page);
    if (!loggedInAfterLogin) {
        await debugSnapshot(page);
        throw new Error('尝试登录失败：模拟登录后，仍检测到未登录特征');
    }

    await page.close();
    console.log('登录成功！');
}

/**
 * 获取文章ID列表（新增dayOffset入参，支持快速模式）
 * @param {import('puppeteer').Browser} browser - 浏览器对象
 * @param {string} userId - 用户ID
 * @param {number} [dayOffset=-1] - 最早日期偏移量：>=0时取最近dayOffset天的文章，<0时取全部
 * @returns {Promise<Array<Object>>} 包含文章ID等信息的数组
 */
async function getArticleInfoArray(browser, userId, dayOffset = -1) {
    // 计算起始日期：dayOffset>=0时取最近dayOffset天，否则取1970-01-01
    const startDate = dayOffset >= 0 ? moment().subtract(dayOffset, 'days').format('YYYY-MM-DD') : '1970-01-01';
    console.log(`获取文章ID列表，起始日期：${startDate}，快速模式：${dayOffset >= 0 && QUICK_MODE === true}`);

    // 快速模式：dayOffset>=0 且 QUICK_MODE=true
    if (dayOffset >= 0 && QUICK_MODE === true) {
        return await getQuickModeArticleInfos(browser, userId, startDate);
    }

    // 非快速模式：执行原有逻辑
    console.log('访问“全部可见”类型的文章列表');
    let articleInfos = await _getArticleInfoArray(browser, userId, 1);
    console.log('访问“仅我可见”类型的文章列表');
    articleInfos = articleInfos.concat(await _getArticleInfoArray(browser, userId, 2));
    console.log('访问“审核中&失败”类型的文章列表');
    articleInfos = articleInfos.concat(await _getArticleInfoArray(browser, userId, 3));
    return articleInfos;
}

/**
 * 快速模式：获取指定日期后更新的文章ID列表
 * @param {import('puppeteer').Browser} browser - 浏览器对象
 * @param {string} userId - 用户ID
 * @param {string} startDate - 起始日期（YYYY-MM-DD）
 * @returns {Promise<Array<Object>>} 符合条件的文章信息数组
 */
async function getQuickModeArticleInfos(browser, userId, startDate) {
    const TARGET_URL = `https://blog.csdn.net/community/home-api/v1/get-business-list`;
    const LATELY_PAGE_URL = `https://blog.csdn.net/${userId}?type=lately${SPM_PARAM_END}`;
    let page = await createNewPage(browser);
    let removeResponseListener; // 取消监听的函数
    const articleInfos = []; // 存储符合条件的文章
    // 标记是否已遇到早于起始日期的文章（用于停止翻页）
    const stopFlag = { hasReachedEarlyDate: false };
    let noChangeCount = 0; // 无新数据计数
    let retryCount = 0; // 重试计数

    // 第一步：绑定快速模式的响应监听
    const bindQuickResponseListener = () => {
        removeResponseListener = bindQuickModeResponseListener(page, articleInfos, TARGET_URL, startDate, stopFlag);
    };

    // 第二步：初始化页面访问
    while (true) {
        try {
            bindQuickResponseListener(); // 绑定监听
            // 访问最近文章页面
            await page.goto(LATELY_PAGE_URL, {
                timeout: PAGE_LOAD_TIMEOUT.DOMCONTENTLOADED,
                waitUntil: 'domcontentloaded'
            });
            await sleep(ACTION_INTERVAL_TIME);
            break;
        } catch (error) {
            console.error(`访问最近文章页面失败：${error.message}`);
            // 补全错误上下文：输出完整堆栈
            console.error(error.stack || error);
            if (retryCount >= MAX_RETRY_COUNT) {
                removeResponseListener?.();
                throw new Error(`访问最近文章页面已重试${retryCount}次失败`);
            }
            retryCount++;
            logProcess(`访问最近文章页面进行第${retryCount}次重试`);
            removeResponseListener?.();
            await page.close();
            page = await createNewPage(browser);
            await sleep(ACTION_INTERVAL_TIME);
        }
    }

    // 重置重试计数（用于滑动逻辑）
    retryCount = 0;

    // 第三步：模拟滑动翻页获取数据
    while (true) {
        // 若已遇到早于起始日期的文章，停止翻页
        if (stopFlag.hasReachedEarlyDate) {
            logProcess(`已遇到早于${startDate}的文章，停止翻页`);
            break;
        }

        const previousLength = articleInfos.length;

        // 模拟向下滑动
        await page.evaluate((scrollMultiplier) => {
            window.scrollBy(0, scrollMultiplier * window.innerHeight);
        }, SCROLL_MULTIPLIER);
        await sleep(ACTION_INTERVAL_TIME);

        // 过程日志
        logProcess(`快速模式-当前已获取符合条件的文章数：${articleInfos.length}（是否停止：${stopFlag.hasReachedEarlyDate}）`);

        // 检测是否有新数据
        if (articleInfos.length === previousLength) {
            noChangeCount++;
        } else {
            noChangeCount = 0;
        }

        // 多次无新数据，触发重试
        if (noChangeCount >= MAX_NO_CHANGE_COUNT) {
            if (retryCount >= MAX_RETRY_COUNT) {
                removeResponseListener?.();
                await debugSnapshot(page);
                throw new Error(`快速模式滑动翻页已重试${retryCount}次失败`);
            }
            retryCount++;
            logProcess(`快速模式-模拟滑动进行第${retryCount}次重试`);
            noChangeCount = 0;

            // 重新创建页面并绑定监听
            removeResponseListener?.();
            await page.close();
            page = await createNewPage(browser);
            bindQuickResponseListener();
            // 重新加载页面
            await page.goto(LATELY_PAGE_URL, {
                timeout: PAGE_LOAD_TIMEOUT.NETWORKIDLE2,
                waitUntil: 'networkidle2'
            });
            await sleep(ACTION_INTERVAL_TIME);
            // 重试后主动滑动一次
            await page.evaluate((scrollMultiplier) => {
                window.scrollBy(0, scrollMultiplier * window.innerHeight);
            }, SCROLL_MULTIPLIER);
            await sleep(ACTION_INTERVAL_TIME);
        }
    }

    // 清理资源
    removeResponseListener?.();
    await page.close();
    console.log(`快速模式-最终获取符合条件的文章数：${articleInfos.length}`);
    return articleInfos;
}

/**
 * 快速模式-绑定文章列表API的响应监听
 * @param {import('puppeteer').Page} page - 页面对象
 * @param {Array} articleInfos - 存储符合条件的文章数组
 * @param {string} TARGET_URL - 目标API地址
 * @param {string} startDate - 起始日期（YYYY-MM-DD）
 * @param {Object} stopFlag - 停止标记（引用类型）
 * @returns {Function} 取消监听的函数
 */
function bindQuickModeResponseListener(page, articleInfos, TARGET_URL, startDate, stopFlag) {
    const responseHandler = async (response) => {
        const requestUrl = response.url();
        if (requestUrl.includes(TARGET_URL) && !stopFlag.hasReachedEarlyDate) {
            try {
                const data = await safeJsonFromResponse(response, '快速模式-解析API响应');
                if (data && data.code === 200 && data.data && data.data.list) {
                    // 遍历列表，筛选type=blog的项
                    for (const item of data.data.list) {
                        if (item.type !== 'blog' || !item.updateTime) {
                            continue; // 非文章或无更新时间，跳过
                        }

                        // 1. 转换updateTime为日期（YYYY-MM-DD）
                        const updateDate = moment(item.updateTime).format('YYYY-MM-DD');
                        // 2. 比较更新日期与起始日期
                        const isAfterStartDate = moment(updateDate).isSameOrAfter(startDate);

                        if (isAfterStartDate) {
                            // 3. 提取文章ID（url最后一个路径段）
                            const articleId = extractArticleId(item.url);
                            if (articleId && !articleInfos.some(info => info.articleId === articleId)) {
                                articleInfos.push({
                                    articleId: articleId,
                                    url: appendSpmParam(item.url),
                                    editUrl: appendSpmParam(item.editUrl || ''),
                                    lastTime: item.updateTime // 存储更新时间戳
                                });
                            }
                        } else {
                            // 遇到早于起始日期的文章，标记停止
                            logProcess(`发现早于${startDate}的文章（更新日期：${updateDate}），标记停止翻页`);
                            stopFlag.hasReachedEarlyDate = true;
                            break; // 停止遍历当前列表
                        }
                    }
                }
            } catch (e) {
                console.error(`快速模式-处理API响应失败：${e.message}`);
            }
        }
    };

    page.on('response', responseHandler);
    return () => page.off('response', responseHandler); // 返回取消监听函数
}

/**
 * 从文章URL中提取文章ID
 * @param {string} url - 文章URL
 * @returns {string|null} 文章ID（失败返回null）
 */
function extractArticleId(url) {
    if (!url) return null;
    // 匹配规则：details/后接数字，或URL最后一段为数字
    const match = url.match(/\/(\d+)$/) || url.match(/details\/(\d+)/);
    return match ? match[1] : null;
}

/**
 * 绑定文章列表API的响应监听（抽离为独立函数，确保每次创建新页面都能绑定）
 * @param {import('puppeteer').Page} page - 页面对象
 * @param {Array} articleInfos - 文章信息数组
 * @param {string} TARGET_URL - 目标API地址
 * @param {number} totalArticles - 总文章数（引用传递，用于更新）
 * @returns {Function} 取消监听的函数（避免内存泄漏）
 */
function bindArticleResponseListener(page, articleInfos, TARGET_URL, totalArticlesRef) {
    const responseHandler = async (response) => {
        const requestUrl = response.url();
        if (requestUrl.includes(TARGET_URL)) {
            try {
                const data = await safeJsonFromResponse(response, '解析文章列表API响应');
                if (data && data.code === 200 && data.data && data.data.list) {
                    // 只添加未存在的文章，避免重复（清零后这里自然是全新数据）
                    data.data.list.forEach((article) => {
                        if (!articleInfos.some(info => info.articleId === article.articleId)) {
                            articleInfos.push({
                                articleId: article.articleId,
                                url: appendSpmParam(article.url),
                                editUrl: appendSpmParam(article.editUrl),
                                lastTime: article.postTime
                            });
                        }
                    });
                    // 重置总文章数（确保获取最新的总数）
                    totalArticlesRef.value = data.data.total;
                }
            } catch (e) {
                console.error(`处理文章列表API响应失败: ${e.message}`);
            }
        }
    };
    page.on('response', responseHandler);
    // 返回取消监听的函数，避免内存泄漏
    return () => page.off('response', responseHandler);
}

/**
 * 获取文章ID列表
 * @param {import('puppeteer').Browser} browser - 浏览器对象
 * @param {string} userId - 用户ID
 * @param {number} filterType - 访问的文章列表类型：1：全部可见，2：仅我可见，3：审核中&失败
 * @returns {Promise<Array<Object>>} 包含文章ID等信息的数组
 */
async function _getArticleInfoArray(browser, userId, filterType) {
    console.log('获取文章ID列表。');
    const TARGET_URL = `https://blog.csdn.net/community/home-api/v1/get-business-list`;
    const ARTICLES_PAGE_URL = `https://blog.csdn.net/${userId}?type=blog${SPM_PARAM_END}`;
    const PRIVATE_ARTICLES_PAGE_URL = `https://blog.csdn.net/${userId}?type=blog&filterType=private${SPM_PARAM_END}`;
    const AUDIT_ARTICLES_PAGE_URL = `https://blog.csdn.net/${userId}?type=blog&filterType=audit${SPM_PARAM_END}`;
    let page = await createNewPage(browser);
    let removeResponseListener; // 用于取消响应监听的函数
    let articles_page_url = ARTICLES_PAGE_URL;
    if (filterType === 2) {
        articles_page_url = PRIVATE_ARTICLES_PAGE_URL;
    } else if (filterType === 3) {
        articles_page_url = AUDIT_ARTICLES_PAGE_URL;
    }
    const articleInfos = [];
    // 用对象包装totalArticles，实现引用传递（解决基本类型无法在监听中更新的问题）
    const totalArticlesRef = {
        value: -1
    };
    let noChangeCount = 0; // 跟踪没有变化的次数
    let retryCount = 0; // 重试计数
    // 第一步：初始化页面并访问文章列表页（修复重试判断逻辑）
    while (true) {
        try {
            // 绑定响应监听（每次创建新页面都要重新绑定）
            removeResponseListener = bindArticleResponseListener(page, articleInfos, TARGET_URL, totalArticlesRef);
            // 按重试次数选择导航等待策略（重试次数越大，等待越充分）
            await navigateWithRetryFallback(page, articles_page_url, retryCount);
            await sleep(ACTION_INTERVAL_TIME);
            break;
        } catch (error) {
            console.error(`访问列表页时发生错误：${error.message}`);
            // 补全错误上下文：输出完整堆栈
            console.error(error.stack || error);
            if (retryCount >= MAX_RETRY_COUNT) {
                // 取消监听后再抛出错误，避免内存泄漏
                removeResponseListener?.();
                throw new Error(`访问列表页面已重试${retryCount}次仍然失败`);
            }
            retryCount++;
            logProcess(`访问列表页面进行第${retryCount}次重试`);
            // 取消旧页面的监听，避免内存泄漏
            removeResponseListener?.();
            await page.close();
            page = await createNewPage(browser);
            await sleep(ACTION_INTERVAL_TIME);
        }
    }
    // 重置重试计数（用于滑动逻辑）
    retryCount = 0;
    // 第二步：模拟向下滑动加载更多文章（保留清零，修复监听）
    while (true) {
        const previousLength = articleInfos.length;
        // 模拟向下滑动
        await page.evaluate((scrollMultiplier) => {
            window.scrollBy(0, scrollMultiplier * window.innerHeight);
        }, SCROLL_MULTIPLIER);
        await sleep(ACTION_INTERVAL_TIME);
        // 过程日志
        logProcess(`当前已获取到的文章数量：${articleInfos.length} / ${totalArticlesRef.value}`);
        // 所有文章已加载完成，退出循环
        if (articleInfos.length === totalArticlesRef.value && totalArticlesRef.value !== -1) {
            break;
        }
        // 检测是否有新文章加载
        if (articleInfos.length === previousLength) {
            noChangeCount++;
        } else {
            noChangeCount = 0; // 有新文章，重置计数
        }
        // 多次无变化，触发重试（保留清零逻辑，修复监听）
        if (noChangeCount >= MAX_NO_CHANGE_COUNT) {
            if (retryCount >= MAX_RETRY_COUNT) {
                removeResponseListener?.();
                await debugSnapshot(page);
                throw new Error(`模拟向下滑动已重试${retryCount}次仍然失败`);
            }
            retryCount++;
            logProcess(`模拟向下滑动进行第${retryCount}次重试`);
            // 保留你的核心逻辑：清零，重新获取全部数据
            articleInfos.length = 0; // 清空文章数组
            totalArticlesRef.value = -1; // 重置总文章数
            noChangeCount = 0;
            // 修复：关闭旧页面，创建新页面并重新绑定监听
            removeResponseListener?.();
            await page.close();
            page = await createNewPage(browser);
            // 关键：重新绑定响应监听，确保清零后能捕获新数据
            removeResponseListener = bindArticleResponseListener(page, articleInfos, TARGET_URL, totalArticlesRef);
            // 重新加载页面，触发API请求（获取最新的全部数据）
            await page.goto(articles_page_url, {
                timeout: PAGE_LOAD_TIMEOUT.NETWORKIDLE2,
                waitUntil: 'networkidle2'
            });
            await sleep(ACTION_INTERVAL_TIME);
            // 修复：重试后主动滑动一次，强制触发API请求，确保数据重新填充
            await page.evaluate((scrollMultiplier) => {
                window.scrollBy(0, scrollMultiplier * window.innerHeight);
            }, SCROLL_MULTIPLIER);
            await sleep(ACTION_INTERVAL_TIME);
        }
    }
    // 清理资源：取消监听、关闭页面
    removeResponseListener?.();
    await page.close();
    console.log(`获取到的文章数量：${articleInfos.length}。`);
    return articleInfos;
}

/**
 * 获取最后编辑时间，并过滤文章ID列表
 * // @param {import('puppeteer').Browser} browser - 浏览器对象
 * 入参不再带浏览器对象，而是直接使用全局的浏览器对象，方便在异常时直接重启浏览器对象
 * @param {number} dayOffset - 天数偏移量
 * @param {Array<Object>} articleInfos - 文章信息数组
 * @returns {Promise<Array<Object>>} 包含过滤后的文章信息数组，其中每个文章对象都增加了 lastTime 属性，表示最后编辑时间。
 */
async function filterArticlesByLastTime(dayOffset, articleInfos) {
    if (!articleInfos || articleInfos.length === 0) return [];
    const startDate = dayOffset >= 0 ? moment().subtract(dayOffset, 'days').format('YYYY-MM-DD') : '1970-01-01';
    console.log(`获取最后编辑时间，并过滤文章ID列表。起始日期: ${startDate}`);
    const filteredArticles = [];
    const totalArticles = articleInfos.length;
    let page = await createNewPage(browser);
    let pageUseCount = 0; // 用于跟踪 page 对象的使用次数
    for (const [index, article] of articleInfos.entries()) {
        let retryCount = 0;
        while (true) {
            try {
                // 如果 page 使用次数达到限制，关闭当前 page 并创建新的 page
                if (pageUseCount >= PAGE_REUSE_LIMIT) {
                    await page.close();
                    page = await createNewPage(browser);
                    pageUseCount = 0; // 重置计数器
                }
                // 网络事件按文章归属打标，便于异常落盘时只看当前文章的事件
                beginNetworkTracking(page, article.articleId);
                // 按重试次数选择导航等待策略（重试次数越大，等待越充分）
                await navigateWithRetryFallback(page, article.url, retryCount);
                pageUseCount++; // 增加 page 使用次数
                // 每次访问完一篇文章后，等待一下
                await sleep(ACTION_INTERVAL_TIME);
                // 等待 postTime 变量出现
                await page.waitForFunction(
                    () => window.postTime !== undefined, {
                        timeout: PAGE_LOAD_TIMEOUT.DOMCONTENTLOADED
                    });
                const postTimeValue = await page.evaluate(() => window.postTime);
                if (!postTimeValue) {
                    throw new Error('未能获取到postTime变量');
                }
                // 尝试获取 lastTime 变量
                const lastTimeValue = await page.evaluate(() => window.lastTime);
                // 如果 lastTime 不存在或为 0，则使用 postTime 代替
                const timeValue = lastTimeValue && lastTimeValue !== '0' ? lastTimeValue : postTimeValue;
                const timeDate = moment(timeValue, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD');
                // 过程日志：逐篇输出最后修改时间（含文章对象，较冗长，仅在 debug 模式下有意义）
                if (runMode === 'debug') {
                    logProcess(`当前文章的最后修改时间为：${timeDate} @ `, article)
                }
                // 将 timeValue 添加到 article 对象中
                article.lastTime = timeValue;
                if (timeDate > startDate) {
                    // 获取主题：使用 queryXPath 执行 XPath 查询并获取匹配的元素列表，解构并获取第一个元素
                    const [element] = await queryXPath(page, '//a[@class="tag-link" and @rel="noopener"]');
                    let textContent = null;
                    if (element) {
                        // 如果找到匹配的元素，则提取其文本内容并去除首尾空格
                        textContent = await element.evaluate(el => el.textContent.trim());
                    } else {
                        // 备选方案：使用span[@class="tit"]定位并获取第一个元素的文本
                        const [spanElement] = await queryXPath(page, '//span[@class="tit"]');
                        if (spanElement) {
                            textContent = await spanElement.evaluate(el => el.textContent.trim());
                        }
                    }
                    article.subject = textContent;
                    filteredArticles.push(article);
                }
                // 如果成功，跳出重试循环
                break;
            } catch (error) {
                console.error(`处理文章 ${article.articleId} 时发生错误: ${error.message}`);
                // 补全错误上下文：完整堆栈 + 页面/网络层诊断信息
                console.error(error.stack || error);
                await saveFailureLog(article.articleId, {
                    mission: 'filterArticlesByLastTime',
                    articleId: article.articleId,
                    url: article.url,
                    retryCount,
                    pageUrl: safePageUrl(page),
                    permanent: isPermanentError(error),
                    error: {
                        name: error.name,
                        message: error.message,
                        stack: error.stack
                    },
                    pageContext: await capturePageContext(page),
                    networkEvents: getNetworkEvents(page)
                });
                if (retryCount >= MAX_RETRY_COUNT) {
                    // console.error(`文章 ${article.articleId} 在重试${retryCount}次后仍然失败，放弃处理。`);
                    await debugSnapshot(page);
                    throw new Error(`文章 ${article.articleId} 在最大重试次数后仍然失败`);
                }
                retryCount++;
                logProcess(`进行第${retryCount}次重试`);
                // P2：失败分层 + 重试阶梯（永久性错误/首次重试只重建页面，多次重试才重启浏览器）
                page = await recoverPageForRetry(page, retryCount, error);
                pageUseCount = 0; // 重置计数器
            }
        }
        // 过程日志：打印当前的处理进度
        logProcess(`根据最后编辑时间过滤文章的处理进度: ${index + 1} / ${totalArticles}`);
    }
    await page.close();
    console.log(`过滤后的文章数量：${filteredArticles.length}。`);
    // 详细日志：过滤后的文章列表信息
    logProcess('过滤后的文章列表信息：', filteredArticles);
    return filteredArticles;
}

/**
 * 下载CSDN文章内容
 * //@param {import('puppeteer').Browser} browser - 浏览器对象
 * 入参不再带浏览器对象，而是直接使用全局的浏览器对象，方便在异常时直接重启浏览器对象
 * @param {Array<Object>} articleInfos - 文章信息数组
 * @param {boolean} continueDownload - 是否继续之前的下载
 * @returns {Promise<void>}
 */
async function downloadArticles(articleInfos, continueDownload = false) {
    console.log('下载CSDN文章内容。');
    if (!articleInfos || articleInfos.length === 0) return;
    const exist_articles = {};
    const totalArticles = articleInfos.length;
    let page = await createNewPage(browser);
    await page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT); // 设置默认超时时间
    let pageUseCount = 0; // 用于跟踪 page 对象的使用次数
    // 处理 DEFAULT_DOWNLOAD_PATH 和 DOWNLOAD_PATHS 中的所有路径
    const pathsToProcess = [DEFAULT_DOWNLOAD_PATH, ...Object.values(DOWNLOAD_PATHS)];
    for (const dirPath of pathsToProcess) {
        try {
            const files = await fs.readdir(dirPath);
            for (const file of files) {
                const match = file.match(/^(\d+)-.*\.md$/); // 匹配 <数字-任意.md> 格式的文件
                if (match && match[1]) {
                    const articleId = parseInt(match[1], 10);
                    // 如果存在相同ID的文章，则更新为最新的完整文件路径
                    exist_articles[articleId] = path.join(dirPath, file);
                }
            }
        } catch (error) {
            console.error(`读取路径 ${dirPath} 时出错：${error.message}`);
        }
    }
    console.log(`已找到 ${Object.keys(exist_articles).length} 个已下载的文章。`);
    for (const [index, article] of articleInfos.entries()) {
        // 前置处理
        if (article.articleId in exist_articles) {
            const fullPath = exist_articles[article.articleId];
            let dirPath = path.dirname(fullPath);
            if (continueDownload) {
                let targetDir = DEFAULT_DOWNLOAD_PATH; // 默认路径
                // 如果文章有主题，并且该主题存在于 DOWNLOAD_PATHS 中，则更新 targetDir
                if (article.subject && article.subject in DOWNLOAD_PATHS) {
                    targetDir = DOWNLOAD_PATHS[article.subject];
                }
                // 确保 targetDir 和 dirPath 的格式一致
                targetDir = path.resolve(targetDir); // 标准化路径，去除多余的分隔符
                dirPath = path.resolve(dirPath); // 同样标准化 dirPath
                // 检查路径是否一致（不考虑末尾分隔符）
                if (dirPath !== targetDir) {
                    try {
                        const targetFilePath = path.join(targetDir, path.basename(fullPath));
                        await fs.rename(fullPath, targetFilePath);
                        exist_articles[article.articleId] = targetFilePath; // 更新 exist_articles 中的路径
                        logProcess(`文章 ${article.articleId} 已移动到 ${targetFilePath}`);
                    } catch (error) {
                        console.error(`移动文件 ${fullPath} 到 ${targetDir} 时出错：${error.message}`);
                    }
                } else {
                    logProcess(`文章 ${article.articleId} 路径已正确，跳过。`);
                }
                // 跳过后续处理
                continue;
            } else {
                try {
                    await fs.unlink(fullPath); // 删除文件
                    delete exist_articles[article.articleId]; // 从 exist_articles 中移除该条目
                    logProcess(`已删除文章 ${article.articleId} 的文件：${fullPath}`);
                } catch (error) {
                    console.error(`删除文件 ${fullPath} 时出错：${error.message}`);
                }
            }
        }
        let retryCount = 0;
        while (true) {
            try {
                logProcess(`正在处理文章 ${article.articleId}，URL: ${article.editUrl}`);
                // 如果 page 使用次数达到限制，关闭当前 page 并创建新的 page
                if (pageUseCount >= PAGE_REUSE_LIMIT) {
                    await page.close();
                    page = await createNewPage(browser);
                    await page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT); // 设置默认超时时间
                    pageUseCount = 0; // 重置计数器
                }
                // 监听文章数据接口（判据：URL + URL中的articleId + 请求方法），
                // 并统一处理状态码分层、空响应体校验、JSON解析与诊断日志
                const responseBody = await fetchArticleData(page, article, retryCount);
                pageUseCount++; // 增加 page 使用次数
                if (responseBody.code !== 200) {
                    // 业务错误码非200：纳入重试计数并做退避，避免无限循环
                    const businessError = `获取文章 ${article.articleId} 数据时发生错误: code=${responseBody.code}, msg=${responseBody.msg}`;
                    console.error(businessError);
                    if (retryCount >= MAX_RETRY_COUNT) {
                        throw new Error(`${businessError}（业务错误码非200，已重试${retryCount}次后放弃）`);
                    }
                    retryCount++;
                    logProcess(`业务错误码非200，进行第${retryCount}次重试`);
                    await sleep(ACTION_INTERVAL_TIME * retryCount); // 退避等待
                    continue;
                }
                const {
                    data
                } = responseBody;
                const content = data.markdowncontent || data.content;
                const title = data.title;
                if (!content) {
                    // 空内容同样纳入重试计数与退避，避免原先无上限的 continue 造成无限循环
                    const emptyContentError = `文章 ${article.articleId} 内容为空`;
                    if (retryCount >= MAX_RETRY_COUNT) {
                        throw new Error(`${emptyContentError}（已重试${retryCount}次后放弃）`);
                    }
                    console.error(emptyContentError);
                    retryCount++;
                    logProcess(`${emptyContentError}，进行第${retryCount}次重试`);
                    await sleep(ACTION_INTERVAL_TIME * retryCount); // 退避等待
                    continue;
                }
                // 保存内容到文件：过滤所有非法字符（< > : " / \ | ? *），统一替换为短横线-
                const sanitizedTitle = title.replace(/[<>:"/\\|?*]/g, '-');
                const targetDir = article.subject && article.subject in DOWNLOAD_PATHS ? DOWNLOAD_PATHS[article.subject] : DEFAULT_DOWNLOAD_PATH;
                const filePath = path.join(targetDir, `${article.articleId}-${sanitizedTitle}.md`);
                await fs.writeFile(filePath, content, 'utf-8');
                logProcess(`文章 ${article.articleId} 下载成功，保存到 ${filePath}`);
                // 如果成功，跳出重试循环
                break;
            } catch (error) {
                console.error(`处理文章 ${article.articleId} 时发生错误：${error.message}`);
                // 补全错误上下文：完整堆栈 + 页面/网络层诊断信息（含 method/status/fromCache/failure）
                console.error(error.stack || error);
                await saveFailureLog(article.articleId, {
                    mission: 'downloadArticles',
                    articleId: article.articleId,
                    editUrl: article.editUrl,
                    retryCount,
                    pageUrl: safePageUrl(page),
                    permanent: isPermanentError(error),
                    error: {
                        name: error.name,
                        message: error.message,
                        stack: error.stack
                    },
                    pageContext: await capturePageContext(page),
                    networkEvents: getNetworkEvents(page)
                });
                if (retryCount >= MAX_RETRY_COUNT) {
                    // console.error(`文章 ${article.articleId} 在重试${retryCount}次后仍然失败，放弃处理。`);
                    await debugSnapshot(page);
                    throw new Error(`文章 ${article.articleId} 在最大重试次数后仍然失败`);
                }
                retryCount++;
                logProcess(`进行第${retryCount}次重试`);
                // P2：失败分层 + 重试阶梯（永久性错误/首次重试只重建页面，多次重试才重启浏览器）
                page = await recoverPageForRetry(page, retryCount, error);
                await page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT); // 设置默认超时时间
                pageUseCount = 0; // 重置计数器
            }
        }
        // 过程日志：打印当前的处理进度
        logProcess(`处理进度: ${index + 1} / ${totalArticles}`);
    }
    // 确保在所有文章处理完成后关闭最后一个 page
    await page.close();
}

/**
 * 后处理函数
 * @param {Array<Object>} articleInfos - 包含所有文章信息的数组
 */
async function postProcessFiles(articleInfos) {
    console.log('开始对文件进行后处理。')
    if (!articleInfos || articleInfos.length === 0) return;
    // 创建一个映射，便于快速查找 articleId 对应的 lastTime
    const articleMap = new Map(articleInfos.map(article => [article.articleId, article]));
    try {
        // 读取下载目录中的所有文件
        const files = await fs.readdir(DEFAULT_DOWNLOAD_PATH);
        // 遍历每个文件
        for (const file of files) {
            // 检查文件是否符合命名格式
            const match = file.match(/^(\d+)-.*\.md$/);
            if (!match) continue; // 忽略不符合格式的文件
            const articleId = parseInt(match[1], 10);
            const article = articleMap.get(articleId);
            if (!article) continue; // 如果找不到对应的文章信息，跳过
            const filePath = path.join(DEFAULT_DOWNLOAD_PATH, file);
            // 读取文件内容
            let content = await fs.readFile(filePath, 'utf-8');
            // 对文件内容进行字符串替换
            for (const replacement of REPLACEMENTS) {
                // 将源字符串转换为正则表达式
                const regex = new RegExp(replacement.source, 'g');
                content = content.replace(regex, replacement.target);
            }
            // 写回替换后的内容
            await fs.writeFile(filePath, content, 'utf-8');
            // 更新文件的访问时间和修改时间
            const lastTime = moment(article.lastTime, 'YYYY-MM-DD HH:mm:ss').toDate();
            await fs.utimes(filePath, lastTime, lastTime);
        }
        console.log('文件处理完成');
    } catch (err) {
        console.error(`文件处理过程中发生错误：${err.message}`);
        throw new Error(`文件处理过程中发生错误：${err.message}`);
    }
}
