import puppeteer from "puppeteer";
import moment from 'moment';
import fs from 'fs/promises';
import path from "path";
import yaml from 'js-yaml';
import fsSync from 'fs';

////// 入口主流程 开始 ///////

// 加载配置文件
const configContent = fsSync.readFileSync('./config.yml', 'utf8');
const config = yaml.load(configContent);

// 从配置中获取全局常量
const {
  csdn: { user_id: CSDN_USER_ID, user_pwd: CSDN_USER_PWD },
  directories: { user_data: USER_DATA_DIR, default_download: DEFAULT_DOWNLOAD_PATH, download_paths: DOWNLOAD_PATHS },
  general: { 
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
    replacements: REPLACEMENTS 
  },
  article_ids: { markdown_format_ids: MARKDOWN_FORMAT_IDS, old_format_ids: OLD_FORMAT_IDS },
  cookies: { expires: COOKIE_EXPIRES, protected_cookies: PROTECTED_COOKIES },
  browser: { launch_args: BROWSER_ARGS },
  retry: { max_no_change_count: MAX_NO_CHANGE_COUNT, max_retry_count: MAX_RETRY_COUNT }
} = config;


// 等待指定的时间（毫秒）
const sleep = async (ms) => {
    await new Promise(resolve => setTimeout(resolve, ms));
};

// 创建新页面对象
const createNewPage = async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT});
    return page;
};

console.log("开始执行CSDN导出任务！");

// 获取外部参数并校验
const {runMode, dayOffset} = checkParams();

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
            url: `https://blog.csdn.net/${CSDN_USER_ID}/article/details/${id}`,
            editUrl: `https://editor.csdn.net/md?articleId=${id}`
          })),
          // 生成旧格式文章信息
          ...OLD_FORMAT_IDS.map(id => ({
            articleId: id,
            url: `https://blog.csdn.net/${CSDN_USER_ID}/article/details/${id}`,
            editUrl: `https://mp.csdn.net/mp_blog/creation/editor/${id}`
          }))
        ];

        } else {
          // 获取文章ID列表
          articleInfos = await getArticleInfoArray(browser, CSDN_USER_ID);
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

    return {runMode, dayOffset}
}

/**
 * 解析 Cookie 字符串为 Puppeteer 可用的格式
 * @param {string} cookieString - 原始 Cookie 字符串
 * @param {string} domain - Cookie 所属域名
 * @returns {Array} 解析后的 Cookie 数组
 */
function parseCookies(cookieString, domain) {
    return cookieString.split('; ')
        .filter(part => part.trim() !== '')
        .map(cookie => {
            const [name, value] = cookie.split('=', 2);
            
            if (!name || value === undefined) {
                console.warn(`跳过无效 Cookie: ${cookie}`);
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
                domain: domain,
                path: '/',
                expires: COOKIE_EXPIRES, // 从配置中获取
                httpOnly: false,
                secure: false
            };
            
            // 为特定 Cookie 设置 httpOnly 和 secure 标志
            if (PROTECTED_COOKIES.includes(name)) {
                cookieObj.httpOnly = true;
                cookieObj.secure = true;
            }
            
            return cookieObj;
        })
        .filter(cookie => cookie !== null);
}

/**
 * 初始化浏览器
 * @param {boolean} [headless=true] - 是否开启无头模式
 * @returns {Promise<import('puppeteer').Browser>} 浏览器对象
 */
async function initBrowser(headless = true) {
    console.log('初始化浏览器。');

    let browser;

    try {
        // 根据传入的参数决定是否开启无头模式，并且如果是无头模式则使用新的Headless实现
        const headlessOption = headless ? "new" : false;

        // userDataDir 表示把登录信息放到当前目录下，省着我们每次调用脚本都需要登录
        browser = await puppeteer.launch({
            headless: headlessOption, // 根据传入的参数决定是否开启无头模式
            userDataDir: USER_DATA_DIR,
            // ignoreHTTPSErrors: true, // 忽略 HTTPS 错误
             args: BROWSER_ARGS // 从配置中获取浏览器启动参数
        });


        // 检查本地是否存在 Cookie 文件
        try {
            await fs.access(COOKIE_FILE);
            
            // 读取 Cookie 文件内容
            const cookieString = await fs.readFile(COOKIE_FILE, 'utf8');
            
            if (cookieString.trim()) {
                // 设置 Cookie 使用的目标网站域名
                const COOKIE_DOMAIN = '.csdn.net';
                // 创建临时页面用于设置 Cookie
                const tempPage = await browser.newPage();

                // 先访问一次目标网站，确保上下文存在
                await tempPage.goto(`https://www${COOKIE_DOMAIN}`, { waitUntil: 'domcontentloaded' });
                
                // 解析并设置 Cookie
                const cookies = parseCookies(cookieString, COOKIE_DOMAIN);
                // console.log(cookies);
                await tempPage.setCookie(...cookies);
                
                console.log(`已从 ${COOKIE_FILE} 读取并设置 ${cookies.length} 个 Cookie`);
                
                // 关闭临时页面
                await tempPage.close();

                // 重命名 Cookie 文件
                try {
                    // 获取当前日期作为后缀
                    const today = new Date();
                    const dateSuffix = today.toISOString().split('T')[0]; // 格式: YYYY-MM-DD
                    
                    // 生成新文件名: 原文件名.日期后缀
                    const newCookieFile = `${COOKIE_FILE}.${dateSuffix}`;
                    
                    // 重命名文件
                    await fs.rename(COOKIE_FILE, newCookieFile);
                    console.log(`已将 Cookie 文件重命名为: ${newCookieFile}`);
                } catch (renameError) {
                    console.error('重命名 Cookie 文件失败:', renameError);
                }
            } else {
                console.log(`${COOKIE_FILE} 文件为空，跳过设置 Cookie`);
            }
        } catch (err) {
            // console.error(`访问 Cookie 文件失败:`, err);
            // console.log(`${COOKIE_FILE} 文件不存在或无法访问，跳过设置 Cookie`);
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

/**
 * 设置模式，启动浏览器UI界面，用于记录登录信息。
 * @param {import('puppeteer').Browser} browser - 浏览器对象
 */
async function setup(browser) {
    console.log('设置模式，启动浏览器UI界面，用于记录登录信息。');

    const LOGIN_URL = 'https://passport.csdn.net/login';

    try {
        await deleteFolderRecursive(USER_DATA_DIR);
        console.log(`userData 目录 ${USER_DATA_DIR} 已删除`);
    } catch (err) {
        console.log(`userData 目录 ${USER_DATA_DIR} 目录不存在，无需删除`);
    }

    // 创建下载目录，如果不存在则创建
    await fs.mkdir(DEFAULT_DOWNLOAD_PATH, {recursive: true});
    console.log(`下载目录 ${DEFAULT_DOWNLOAD_PATH} 已创建`);

    // 遍历 DOWNLOAD_PATHS 并创建所有指定的下载目录
    for (const [subject, dirPath] of Object.entries(DOWNLOAD_PATHS)) {
        await fs.mkdir(dirPath, {recursive: true});
        console.log(`下载目录 ${dirPath} (${subject}) 已创建`);
    }

    // 初始化浏览器，关闭无头模式
    const page = await createNewPage(browser);

    // 打开CSDN登录页面
    await page.goto(LOGIN_URL);

    // 等待2分钟后再关闭浏览器，用于进行登录
    await sleep(DEBUG_LOGIN_TIME);
    await page.close();
}

/**
 * 模拟登录模式，启动浏览器UI界面，使用用户名、密码进行模拟登录CSDN操作。
 * @param {import('puppeteer').Browser} browser - 浏览器对象
 */
async function login(browser) {
    const LOGIN_URL = 'https://passport.csdn.net/login';
    let page = await createNewPage(browser);

    // 打开CSDN登录页面，等待可能的登陆后跳转
    try {
        await page.goto(LOGIN_URL, {timeout: PAGE_LOAD_TIMEOUT.DOMCONTENTLOADED, waitUntil: 'domcontentloaded'});
    } catch (error) {
        try {
            console.error(`打开CSDN登录页面失败：${error.message}，再次重试。`);
            page.close()
            page = await createNewPage(browser);
            await page.goto(LOGIN_URL, {timeout: PAGE_LOAD_TIMEOUT.LOAD, waitUntil: 'load'});
        } catch (error) {
            console.error(`打开CSDN登录页面再次失败：${error.message}，再次重试。`);
            page.close()
            page = await createNewPage(browser);
            await page.goto(LOGIN_URL, {timeout: PAGE_LOAD_TIMEOUT.NETWORKIDLE2, waitUntil: 'networkidle2'});
        }
    }

    await sleep(LOGIN_REDIRECT_WAIT_TIME);

    // 使用XPath来查找“密码登录”Tab
    const passwordLoginTab = await page.$x('//span[text()="密码登录"]');

    // 使用CSS选择器来查找login-third-passwd元素，并且确保它是span元素
    const loginThirdPasswd = await page.$('span.login-third-passwd');

    if (passwordLoginTab.length === 0 && !loginThirdPasswd) {
        console.log('经验证，用户已登录');
        await page.close();
        // 如果"密码登录"Tab和login-third-passwd元素都不存在，认为用户已登录，退出函数
        return;
    }

    console.log('用户未登录，尝试登录...');

    if (passwordLoginTab.length > 0) {
        await passwordLoginTab[0].click();
        console.log('点击了"密码登录"Tab');
    } else {
        await loginThirdPasswd.click();
        console.log('点击了login-third-passwd元素');
    }

    // 在“手机号/邮箱/用户名”输入框内输入用户ID
    const usernameInput = await page.$x('//input[@placeholder="手机号/邮箱/用户名"]');
    if (usernameInput.length > 0) {
        await usernameInput[0].type(CSDN_USER_ID);
        await sleep(ACTION_INTERVAL_TIME);
    } else {
        throw new Error('尝试登录失败：找不到“手机号/邮箱/用户名”输入框');
    }

    // 在“密码”输入框输入密码
    const passwordInput = await page.$x('//input[@placeholder="密码"]');
    if (passwordInput.length > 0) {
        await passwordInput[0].type(CSDN_USER_PWD);
        await sleep(ACTION_INTERVAL_TIME);
    } else {
        throw new Error('尝试登录失败：找不到“密码”输入框');
    }

    // 勾选“同意协议”勾选框
    const agreeCheckbox = await page.$x('//i[contains(@class, "icon-nocheck")]');
    if (agreeCheckbox.length > 0) {
        await agreeCheckbox[0].click();
        await sleep(ACTION_INTERVAL_TIME);
    } else {
        console.log('登录改版：找不到“同意协议”勾选框，直接忽略');
    }

    // 点击“登录”按钮
    const loginButton = await page.$x('//button[text()="登录"]');
    if (loginButton.length > 0) {
        await loginButton[0].click();
    } else {
        throw new Error('尝试登录失败：找不到“登录”按钮');
    }

    // 等待一段时间，确保页面加载完成
    await sleep(LOGIN_REDIRECT_WAIT_TIME);

    // 再次检查“密码登录”Tab是否存在
    const passwordLoginTabAfterLogin = await page.$x('//span[text()="密码登录"]');

    if (passwordLoginTabAfterLogin.length > 0) {
        throw new Error('尝试登录失败：模拟登录后，仍然可以看到“密码登录”Tab');
    }

    await page.close();

    console.log('登录成功！');

}

/**
 * 获取文章ID列表
 * @param {import('puppeteer').Browser} browser - 浏览器对象
 * @param {string} userId - 用户ID
 * @returns {Promise<Array<Object>>} 包含文章ID等信息的数组
 */
async function getArticleInfoArray(browser, userId) {

    console.log('访问“全部可见”类型的文章列表');
    let articleInfos = await _getArticleInfoArray(browser, userId, 1);
    console.log('访问“仅我可见”类型的文章列表');
    articleInfos = articleInfos.concat(await _getArticleInfoArray(browser, userId, 2));
    console.log('访问“审核中&失败”类型的文章列表');
    articleInfos = articleInfos.concat(await _getArticleInfoArray(browser, userId, 3));

    return articleInfos;
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

    const TARGET_URL = 'https://blog.csdn.net/community/home-api/v1/get-business-list';
    const ARTICLES_PAGE_URL = `https://blog.csdn.net/${userId}?type=blog`;
    const PRIVATE_ARTICLES_PAGE_URL = `https://blog.csdn.net/${userId}?type=blog&filterType=private`;
    const AUDIT_ARTICLES_PAGE_URL = `https://blog.csdn.net/${userId}?type=blog&filterType=audit`;
    let page = await createNewPage(browser);

    let articles_page_url = ARTICLES_PAGE_URL;
    if (filterType === 2) {
        articles_page_url = PRIVATE_ARTICLES_PAGE_URL;
    } else if (filterType === 3) {
        articles_page_url = AUDIT_ARTICLES_PAGE_URL;
    }


    const articleInfos = [];
    let totalArticles = -1;
    let noChangeCount = 0; // 跟踪没有变化的次数
    let retryCount = 0; // 重试计数

    while (true) {
        try {
            // 监听网络请求
            page.on('response', async (response) => {
                const requestUrl = response.url();
                if (requestUrl.includes(TARGET_URL)) {
                    const data = await response.json();
                    if (data.code === 200 && data.data && data.data.list) {
                        data.data.list.forEach((article) => {
                            // 检查 articleId 是否已经存在于 articleInfos 中
                            if (!articleInfos.some(info => info.articleId === article.articleId)) {
                                articleInfos.push({
                                    articleId: article.articleId,
                                    url: article.url,
                                    editUrl: article.editUrl,
                                    lastTime: article.postTime
                                });
                            }
                        });
                        totalArticles = data.data.total;
                    }
                }
            });
            await sleep(ACTION_INTERVAL_TIME);

            if (retryCount > 0) {
                // 重试状态时，访问列表页面并等待HTML文档和相关资源已加载
                await page.goto(articles_page_url, {timeout: PAGE_LOAD_TIMEOUT.LOAD, waitUntil: 'load'});
            } else if (retryCount > 1) {
                // 多次重试状态时，访问列表页面并等待HTML文档和相关资源已加载
                await page.goto(articles_page_url, {timeout: PAGE_LOAD_TIMEOUT.NETWORKIDLE2, waitUntil: 'networkidle2'});
            } else {
                // 访问列表页面并等待HTML文档已加载（无需等待图片等资源加载）
                await page.goto(articles_page_url, {timeout: PAGE_LOAD_TIMEOUT.DOMCONTENTLOADED, waitUntil: 'domcontentloaded'});
            }

            break;
        } catch (error) {
            console.error(`访问列表页时发生错误：${error.message}`)
            if (retryCount >= MAX_RETRY_COUNT) {
                throw new Error(`访问列表页面已重试${retryCount}次仍然失败`);
            }
            retryCount++; // 增加重试次数
            console.log(`访问列表页面进行第${retryCount}次重试`);
            await page.close();
            page = await createNewPage(browser);
            await sleep(ACTION_INTERVAL_TIME);
        }

    }

    await sleep(ACTION_INTERVAL_TIME);


    retryCount = 0; // 重试计数

    // 模拟向下滑动
    while (true) {
        const previousLength = articleInfos.length; // 记录当前文章数量

        // 将 SCROLL_MULTIPLIER 作为参数传递给 evaluate 方法
        await page.evaluate((scrollMultiplier) => {
            window.scrollBy(0, scrollMultiplier * window.innerHeight);
        }, SCROLL_MULTIPLIER);

        await sleep(ACTION_INTERVAL_TIME);

        // 过程日志
        if (PROCESS_LOG) {
            console.log(`当前已获取到的文章数量：${articleInfos.length} / ${totalArticles}`);
        }
        if (articleInfos.length === totalArticles) {
            break;
        }

        if (articleInfos.length === previousLength) {
            noChangeCount++;
        } else {
            noChangeCount = 0; // 有新文章出现，重置计数
        }

        if (noChangeCount >= MAX_NO_CHANGE_COUNT) {
            if (retryCount >= MAX_RETRY_COUNT) {
                throw new Error(`模拟向下滑动已重试${retryCount}次仍然失败`);
            }
            retryCount++; // 增加重试次数
            console.log(`模拟向下滑动进行第${retryCount}次重试`);
            articleInfos.length = 0; // 清空文章信息数组
            totalArticles = -1; // 重置总文章数
            noChangeCount = 0; // 重置无变化计数
            await page.close();
            page = await createNewPage(browser);
            await page.goto(articles_page_url, {timeout: PAGE_LOAD_TIMEOUT.NETWORKIDLE2, waitUntil: 'networkidle2'});
            await sleep(ACTION_INTERVAL_TIME);
        }
    }

    await page.close();

    // 打印获取到的文章信息
    // console.log(`获取到的文章数量：${articleInfos.length}。获取到的文章列表信息：`, articleInfos);
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

                if (retryCount > 0) {
                    // 重试状态时，访问详情页面并等待HTML文档和相关资源已加载
                    await page.goto(article.url, {timeout: PAGE_LOAD_TIMEOUT.LOAD, waitUntil: 'load'});
                } else if (retryCount > 1) {
                    // 多次重试状态时，访问详情页面并等待HTML文档和相关资源已加载
                    await page.goto(article.url, {timeout: PAGE_LOAD_TIMEOUT.NETWORKIDLE2, waitUntil: 'networkidle2'});
                } else {
                    // 访问详情页面并等待HTML文档已加载（无需等待图片等资源加载）
                    await page.goto(article.url, {timeout: PAGE_LOAD_TIMEOUT.DOMCONTENTLOADED, waitUntil: 'domcontentloaded'});
                }
                pageUseCount++; // 增加 page 使用次数

                // 每次访问完一篇文章后，等待一下
                await sleep(ACTION_INTERVAL_TIME);

                // 等待 postTime 变量出现
                await page.waitForFunction(
                    () => window.postTime !== undefined,
                    {timeout: PAGE_LOAD_TIMEOUT.DOMCONTENTLOADED}
                );

                const postTimeValue = await page.evaluate(() => window.postTime);
                if (!postTimeValue) {
                    throw new Error('未能获取到postTime变量');
                }

                // 尝试获取 lastTime 变量
                const lastTimeValue = await page.evaluate(() => window.lastTime);

                // 如果 lastTime 不存在或为 0，则使用 postTime 代替
                const timeValue = lastTimeValue && lastTimeValue !== '0' ? lastTimeValue : postTimeValue;

                const timeDate = moment(timeValue, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD');

                if (runMode === 'debug') {
                    console.log(`当前文章的最后修改时间为：${timeDate} @ `, article)
                }

                // 将 timeValue 添加到 article 对象中
                article.lastTime = timeValue;

                if (timeDate > startDate) {
                    // 获取主题：使用 page.$x 执行 XPath 查询并获取匹配的元素列表，解构并获取第一个元素
                    const [element] = await page.$x('//a[@class="tag-link" and @rel="noopener"]');

                    let textContent = null;
                    if (element) {
                        // 如果找到匹配的元素，则提取其文本内容并去除首尾空格
                        textContent = await element.evaluate(el => el.textContent.trim());
                    } else {
                        // 备选方案：使用span[@class="tit"]定位并获取第一个元素的文本
                        const [spanElement] = await page.$x('//span[@class="tit"]');
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
                if (retryCount >= MAX_RETRY_COUNT) {
                    // console.error(`文章 ${article.articleId} 在重试${retryCount}次后仍然失败，放弃处理。`);
                    throw new Error(`文章 ${article.articleId} 在最大重试次数后仍然失败`);
                }

                retryCount++;
                console.log(`进行第${retryCount}次重试`);
                // 重启浏览器对象，为防止页面对象卡死，不需要先关闭当前页面对象
                await browser.close();
                browser = await initBrowser(runMode === 'run' || runMode === 'single');
                page = await createNewPage(browser);
                pageUseCount = 0; // 重置计数器
            }
        }

        // 过程日志：打印当前的处理进度
        if (PROCESS_LOG) {
            console.log(`根据最后编辑时间过滤文章的处理进度: ${index + 1} / ${totalArticles}`);
        }

    }

    await page.close();

    // 打印获取到的文章信息
    console.log(`过滤后的文章数量：${filteredArticles.length}。过滤后的文章列表信息：`, filteredArticles);

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
                dirPath = path.resolve(dirPath);     // 同样标准化 dirPath

                // 检查路径是否一致（不考虑末尾分隔符）
                if (dirPath !== targetDir) {
                    try {
                        const targetFilePath = path.join(targetDir, path.basename(fullPath));
                        await fs.rename(fullPath, targetFilePath);
                        exist_articles[article.articleId] = targetFilePath; // 更新 exist_articles 中的路径
                        console.log(`文章 ${article.articleId} 已移动到 ${targetFilePath}`);
                    } catch (error) {
                        console.error(`移动文件 ${fullPath} 到 ${targetDir} 时出错：${error.message}`);
                    }
                } else {
                    console.log(`文章 ${article.articleId} 路径已正确，跳过。`);
                }
                // 跳过后续处理
                continue;
            } else {
                try {
                    await fs.unlink(fullPath); // 删除文件
                    delete exist_articles[article.articleId]; // 从 exist_articles 中移除该条目
                    console.log(`已删除文章 ${article.articleId} 的文件：${fullPath}`);
                } catch (error) {
                    console.error(`删除文件 ${fullPath} 时出错：${error.message}`);
                }
            }
        }

        let retryCount = 0;
        while (true) {
            try {
                console.log(`正在处理文章 ${article.articleId}，URL: ${article.editUrl}`);

                // 如果 page 使用次数达到限制，关闭当前 page 并创建新的 page
                if (pageUseCount >= PAGE_REUSE_LIMIT) {
                    await page.close();
                    page = await createNewPage(browser);
                    await page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT); // 设置默认超时时间
                    pageUseCount = 0; // 重置计数器
                }

                // 监听获取原文数据的接口
                const responsePromise = page.waitForResponse(response => {
                    const url = response.url();
                    // 通过检查响应头中的 Content-Type 来预检请求（即 OPTIONS 请求）等非 JSON 响应
                    const isJsonResponse = response.headers()['content-type']?.includes('application/json');
                    return (
                        isJsonResponse &&
                        (url.includes('https://bizapi.csdn.net/blog-console-api/v3/editor/getArticle') ||
                            url.includes('https://bizapi.csdn.net/blog-console-api/v1/editor/getArticle'))
                    );
                });

                // 将每次处理完一篇文章后的等待时间提前到此处，可以避免添加监听的耗时导致错过请求
                await sleep(ACTION_INTERVAL_TIME);

                if (retryCount > 0) {
                    // 重试状态时，访问编辑页面并等待HTML文档和相关资源已加载
                    await page.goto(article.editUrl, {timeout: PAGE_LOAD_TIMEOUT.LOAD, waitUntil: 'load'});
                } else if (retryCount > 1) {
                    // 多次重试状态时，访问编辑页面并等待HTML文档和相关资源已加载
                    await page.goto(article.editUrl, {timeout: PAGE_LOAD_TIMEOUT.NETWORKIDLE2, waitUntil: 'networkidle2'});
                } else {
                    // 访问编辑页面并等待HTML文档已加载（无需等待图片等资源加载）
                    await page.goto(article.editUrl, {timeout: PAGE_LOAD_TIMEOUT.DOMCONTENTLOADED, waitUntil: 'domcontentloaded'});
                }
                pageUseCount++; // 增加 page 使用次数

                // 等待响应
                const response = await responsePromise;
                // console.log(response);
                const responseBody = await response.json();
                // console.log(responseBody);

                if (responseBody.code !== 200) {
                    console.error(`获取文章 ${article.articleId} 数据时发生错误: ${responseBody.msg}`);
                    continue;
                }

                const {data} = responseBody;
                const content = data.markdowncontent || data.content;
                const title = data.title;

                if (!content) {
                    console.error(`文章 ${article.articleId} 内容为空，跳过。`);
                    continue;
                }

                // 保存内容到文件
                const sanitizedTitle = title.replace(/\//g, '%2F'); // 转义Linux下的非法字符
                // sanitizedTitle = title.replace(/[\\/*?:"<>|]/g, '-'); // 替换Windows下的非法字符
                const targetDir = article.subject && article.subject in DOWNLOAD_PATHS
                    ? DOWNLOAD_PATHS[article.subject]
                    : DEFAULT_DOWNLOAD_PATH;
                const filePath = path.join(targetDir, `${article.articleId}-${sanitizedTitle}.md`);
                await fs.writeFile(filePath, content, 'utf-8');
                console.log(`文章 ${article.articleId} 下载成功，保存到 ${filePath}`);

                // 如果成功，跳出重试循环
                break;
            } catch (error) {
                console.error(`处理文章 ${article.articleId} 时发生错误：${error.message}`);
                if (retryCount >= MAX_RETRY_COUNT) {
                    // console.error(`文章 ${article.articleId} 在重试${retryCount}次后仍然失败，放弃处理。`);
                    throw new Error(`文章 ${article.articleId} 在最大重试次数后仍然失败`);
                }

                retryCount++;
                console.log(`进行第${retryCount}次重试`);
                // 重启浏览器对象，为防止页面对象卡死，不需要先关闭当前页面对象
                await browser.close();
                browser = await initBrowser(runMode === 'run' || runMode === 'single');
                page = await createNewPage(browser);
                pageUseCount = 0; // 重置计数器
            }
        }

        // 打印当前的处理进度
        console.log(`处理进度: ${index + 1} / ${totalArticles}`);
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

